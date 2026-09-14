import { describe, it, expect, beforeEach, afterEach } from "vitest";
import workerHandler from "../netlify/functions/estate-worker-background.mts";
import tickHandler from "../netlify/functions/estate-tick.mts";
import { freshStore } from "./helpers";
import { createUser, type User } from "../src/lib/users";
import { issueSession, sessionCookie } from "../src/lib/session";
import { SELF_AGENTS, getEstate, queueEstate, saveEstate } from "../src/lib/estates";
import { internalToken, kickWorker, runWorker, verifyInternalToken } from "../src/lib/worker";
import { RENEW_PY } from "../src/lib/renewal";

const ctx = {} as any;
const FLY_ENV = { FLY_API_TOKEN: "fo1_test", FLY_ORG_SLUG: "personal", FLY_ESTATE_IMAGE: "registry.fly.io/x:y", ESTATE_SECRET_MASTER: "master-0123456789" };

/** A Fly stand-in whose create_app step fails `failures` times, then everything succeeds and health is always green. */
class LoopFly {
  calls: string[] = [];
  failures = 0;
  volumes: any[] = [];
  machines: any[] = [];
  async createApp(name: string) { this.calls.push("createApp"); if (this.failures > 0) { this.failures -= 1; throw new Error("boom"); } }
  async listIps() { return [{ address: "1.1.1.1", type: "shared_v4" }, { address: "::1", type: "v6" }]; }
  async allocateIp() { throw new Error("not expected"); }
  async listVolumes() { return this.volumes; }
  async createVolume(_a: string, name: string) { const v = { id: "vol_1", name }; this.volumes.push(v); return { id: v.id }; }
  async setSecrets() { this.calls.push("setSecrets"); }
  async listMachines() { return this.machines; }
  async createMachine(_a: string, name: string, config: any) { const m = { id: "m_1", name, config }; this.machines.push(m); return m; }
  async getMachine() { return this.machines[0] ?? null; }
  async updateMachine(_a: string, _id: string, config: any) { this.calls.push("updateMachine"); this.machines[0].config = config; return this.machines[0]; }
  async exec(_a: string, _i: string, cmd: string[]) {
    if (cmd[0] === "python3" && cmd[2] === RENEW_PY) return { exit_code: 0, stdout: JSON.stringify({ token_id: "renewed-" + cmd[4] }) + "\n", stderr: "" };
    if (cmd[0] === "python3") return { exit_code: 0, stdout: JSON.stringify({ keys: { "ledger-sign": { pub: "P", fingerprint: "fs" } }, manifests: [], roster_rows: 2 }) + "\n", stderr: "" };
    return { exit_code: 0, stdout: JSON.stringify({ token_id: "tok-" + cmd[4] }) + "\n", stderr: "" };
  }
  async stopMachine() {} async startMachine() {}
}

const greenHealth = async (url: string) => {
  const path = new URL(url).pathname;
  const bodies: Record<string, any> = {
    "/registry/health": { ok: true },
    "/delegation/health": { ok: true },
    "/ledger/health": { signing: "on", require_signing: true, appendable: true, key_fingerprint: "fs" },
    "/gateway/health": { enforce: true, tool_check: true },
    "/attest/health": { signing: "on" },
  };
  return new Response(JSON.stringify(bodies[path] ?? {}), { status: bodies[path] ? 200 : 503, headers: { "content-type": "application/json" } });
};

describe("worker loop", () => {
  let user: User;

  beforeEach(async () => {
    freshStore();
    Object.assign(process.env, FLY_ENV);
    user = await createUser("worker@example.com", "sufficiently-long-pass");
  });

  afterEach(() => {
    for (const k of Object.keys(FLY_ENV)) delete process.env[k];
    delete process.env.URL;
  });

  it("drives an estate from queued to ready in one run, retrying a transient failure, and releases the worker lease", async () => {
    await queueEstate(user);
    const fly = new LoopFly();
    fly.failures = 1;
    const r = await runWorker(user.id, "advance", fly as any, { fetchImpl: greenHealth, sleep: async () => {}, budgetMs: 60000 });
    expect(r.last).toBe("done");
    expect(r.status).toBe("ready");
    expect(r.iterations).toBeGreaterThanOrEqual(13);
    const e = (await getEstate(user.id))!;
    expect(e.status).toBe("ready");
    expect(e.worker_until).toBeNull();
    expect(e.attempts).toBe(0);
    expect(e.log.some((l) => l.note.includes("attempt 1 failed"))).toBe(true);
    expect(JSON.stringify(e)).not.toContain("tok-");
  });

  it("refuses to run beside a live worker and reports no_estate for accounts without one", async () => {
    const e = await queueEstate(user);
    e.worker_until = new Date(Date.now() + 600000).toISOString();
    await saveEstate(e);
    const fly = new LoopFly();
    const r = await runWorker(user.id, "advance", fly as any, { sleep: async () => {} });
    expect(r.last).toBe("worker_active");
    expect(fly.calls).toHaveLength(0);
    const other = await createUser("nobody@example.com", "sufficiently-long-pass");
    expect((await runWorker(other.id, "advance", fly as any)).last).toBe("no_estate");
  });

  it("stops at the budget and clears the lease", async () => {
    await queueEstate(user);
    const fly = new LoopFly();
    const r = await runWorker(user.id, "advance", fly as any, { fetchImpl: async () => new Response("", { status: 503 }), sleep: async () => {}, budgetMs: 1 });
    expect(r.iterations).toBeGreaterThanOrEqual(1);
    expect((await getEstate(user.id))!.worker_until).toBeNull();
  });

  it("renew action renews only when due", async () => {
    const e = await queueEstate(user);
    e.status = "ready";
    e.step = "done";
    e.machine_id = "m_1";
    for (const a of SELF_AGENTS) e.self_agents[a.id] = { provisioned_at: new Date(Date.now() - 26 * 86400000).toISOString() };
    await saveEstate(e);
    const fly = new LoopFly();
    fly.machines.push({ id: "m_1", name: "estate", config: { image: "i" } });
    expect((await runWorker(user.id, "renew", fly as any)).last).toBe("renewed");
    expect(fly.calls.filter((c) => c === "updateMachine")).toHaveLength(1);
    expect((await runWorker(user.id, "renew", fly as any)).last).toBe("not_due");
  });

  it("internal tokens are per user and constant-time verified", () => {
    const t = internalToken("u1", "s");
    expect(verifyInternalToken(t, "u1", "s")).toBe(true);
    expect(verifyInternalToken(t, "u2", "s")).toBe(false);
    expect(verifyInternalToken(t, "u1", "other")).toBe(false);
    expect(verifyInternalToken(null, "u1", "s")).toBe(false);
    expect(verifyInternalToken("short", "u1", "s")).toBe(false);
  });

  it("kickWorker posts an internal kick to the site URL and reports acceptance", async () => {
    let seen: any = null;
    const fetchImpl = async (url: string, init?: any) => { seen = { url, init }; return new Response("", { status: 202 }); };
    expect(await kickWorker("u1", "advance", fetchImpl)).toBe(false); // no URL
    process.env.URL = "https://portal.test/";
    expect(await kickWorker("u1", "renew", fetchImpl)).toBe(true);
    expect(seen.url).toBe("https://portal.test/.netlify/functions/estate-worker-background");
    expect(seen.init.headers["x-ff-internal"]).toBe(internalToken("u1"));
    expect(JSON.parse(seen.init.body)).toEqual({ user_id: "u1", action: "renew" });
  });
});

describe("worker and tick functions", () => {
  let user: User;

  beforeEach(async () => {
    freshStore();
    Object.assign(process.env, FLY_ENV);
    user = await createUser("fn@example.com", "sufficiently-long-pass");
  });

  afterEach(() => {
    for (const k of Object.keys(FLY_ENV)) delete process.env[k];
    delete process.env.URL;
  });

  it("worker function: 401 without session or internal token; 501 unconfigured; accepts a session", async () => {
    const anon = await workerHandler(new Request("http://portal.test/.netlify/functions/estate-worker-background", { method: "POST", body: "{}" }), ctx);
    expect(anon.status).toBe(401);
    const forged = await workerHandler(new Request("http://portal.test/.netlify/functions/estate-worker-background", { method: "POST", headers: { "x-ff-internal": "nope" }, body: JSON.stringify({ user_id: user.id }) }), ctx);
    expect(forged.status).toBe(401);
    const cookie = sessionCookie(await issueSession(user.id)).split(";")[0];
    delete process.env.FLY_API_TOKEN;
    const off = await workerHandler(new Request("http://portal.test/.netlify/functions/estate-worker-background", { method: "POST", headers: { cookie }, body: "{}" }), ctx);
    expect(off.status).toBe(501);
    process.env.FLY_API_TOKEN = "fo1_test";
    const ok = await workerHandler(new Request("http://portal.test/.netlify/functions/estate-worker-background", { method: "POST", headers: { cookie }, body: "{}" }), ctx);
    expect(ok.status).toBe(200);
    expect((await ok.json()).last).toBe("no_estate");
    const internal = await workerHandler(new Request("http://portal.test/.netlify/functions/estate-worker-background", { method: "POST", headers: { "x-ff-internal": internalToken(user.id) }, body: JSON.stringify({ user_id: user.id, action: "renew" }) }), ctx);
    expect(internal.status).toBe(200);
  });

  it("tick: kicks the worker for idle provisioning estates and renewals, skips estates with a live worker", async () => {
    process.env.URL = "https://portal.test";
    const e = await queueEstate(user);
    const other = await createUser("busy@example.com", "sufficiently-long-pass");
    const busy = await queueEstate(other);
    busy.worker_until = new Date(Date.now() + 600000).toISOString();
    await saveEstate(busy);
    const kicks: any[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init?: any) => { kicks.push(JSON.parse(init.body)); return new Response("", { status: 202 }); }) as any;
    try {
      const res = await tickHandler(new Request("http://portal.test/tick", { method: "POST", body: "{}" }));
      const body = await res.json();
      expect(body.pending).toBe(1);
      expect(kicks).toEqual([{ user_id: e.user_id, action: "advance" }]);
      expect(body.outcomes).toEqual({ kicked: 1 });
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
