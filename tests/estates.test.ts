import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { freshStore } from "./helpers";
import { createUser, type User } from "../src/lib/users";
import {
  BOOTSTRAP_PY,
  MAX_ATTEMPTS,
  PROVISION_SH,
  ROSTER_PY,
  SELF_AGENTS,
  STEPS,
  advanceEstate,
  estateSecret,
  getEstate,
  newAppName,
  publicEstate,
  queueEstate,
  resolveRoute,
  resumeEstate,
  retryEstate,
  saveEstate,
  setEstateAnthropicKey,
  suspendEstate,
  updateEstateRoster,
  validateAnthropicKey,
  validateRoster,
} from "../src/lib/estates";

const FLY_ENV = { FLY_API_TOKEN: "fo1_test", FLY_ORG_SLUG: "personal", FLY_ESTATE_IMAGE: "registry.fly.io/force-field-sandbox:test", ESTATE_SECRET_MASTER: "master-secret-0123456789" };

const BOOTSTRAP_OUT = {
  keys: {
    "ledger-anchor": { pub: "-----BEGIN PUBLIC KEY-----\nA\n-----END PUBLIC KEY-----\n", fingerprint: "fa" },
    "ledger-sign": { pub: "-----BEGIN PUBLIC KEY-----\nS\n-----END PUBLIC KEY-----\n", fingerprint: "fs" },
    "attest-sign": { pub: "-----BEGIN PUBLIC KEY-----\nT\n-----END PUBLIC KEY-----\n", fingerprint: "ft" },
  },
  manifests: ["conformance-sentinel", "force-gateway", "compliance-crosswalk"],
  // A new account has no scopes yet, so bootstrap writes the platform row only.
  roster_rows: 1,
  customer_row: false,
};

/** In-memory stand-in for FlyClient; records every call. */
class FakeFly {
  calls: { m: string; args: any[] }[] = [];
  apps = new Set<string>();
  ips: Record<string, { address: string; type: string }[]> = {};
  volumes: Record<string, any[]> = {};
  machines: Record<string, any[]> = {};
  secrets: Record<string, Record<string, string>> = {};
  failOn: Record<string, number> = {};
  execs: string[][] = [];
  execHandler: (cmd: string[]) => { exit_code: number; stdout: string; stderr: string } = (cmd) => {
    if (cmd[0] === "python3" && cmd[2] === BOOTSTRAP_PY) return { exit_code: 0, stdout: "private key: never\n" + JSON.stringify(BOOTSTRAP_OUT) + "\n", stderr: "" };
    if (cmd[0] === "python3" && cmd[2] === ROSTER_PY) {
      const row = JSON.parse(cmd[3]);
      const present = Array.isArray(row.allowed_scope) && row.allowed_scope.length > 0;
      return { exit_code: 0, stdout: JSON.stringify({ roster_rows: present ? 2 : 1, customer_row: present }) + "\n", stderr: "" };
    }
    if (cmd[0] === "sh" && cmd[2] === PROVISION_SH) return { exit_code: 0, stdout: "provision ok\n" + JSON.stringify({ token_id: "tok-" + cmd[4], ok: true, steps: [] }) + "\n", stderr: "" };
    return { exit_code: 127, stdout: "", stderr: "unknown command" };
  };

  private rec(m: string, ...args: any[]) {
    this.calls.push({ m, args });
    if ((this.failOn[m] ?? 0) > 0) {
      this.failOn[m] -= 1;
      throw new Error("fake " + m + " failed");
    }
  }
  async createApp(name: string) { this.rec("createApp", name); this.apps.add(name); }
  async listIps(app: string) { this.rec("listIps", app); return this.ips[app] ?? []; }
  async allocateIp(app: string, type: string) {
    this.rec("allocateIp", app, type);
    const a = type === "v6" ? "2a09:8280::1" : "66.241.1.1";
    (this.ips[app] ??= []).push({ address: a, type });
    return a;
  }
  async listVolumes(app: string) { this.rec("listVolumes", app); return this.volumes[app] ?? []; }
  async createVolume(app: string, name: string, size_gb: number) {
    this.rec("createVolume", app, name, size_gb);
    const v = { id: "vol_" + name, name };
    (this.volumes[app] ??= []).push(v);
    return { id: v.id };
  }
  async setSecrets(app: string, s: Record<string, string>) { this.rec("setSecrets", app, Object.keys(s)); Object.assign((this.secrets[app] ??= {}), s); }
  async listMachines(app: string) { this.rec("listMachines", app); return this.machines[app] ?? []; }
  async createMachine(app: string, name: string, config: any) {
    this.rec("createMachine", app, name);
    const m = { id: "m_1", name, config };
    (this.machines[app] ??= []).push(m);
    return m;
  }
  async getMachine(app: string, id: string) { this.rec("getMachine", app, id); return this.machines[app]?.find((m) => m.id === id) ?? null; }
  async updateMachine(app: string, id: string, config: any) {
    this.rec("updateMachine", app, id);
    const m = this.machines[app]?.find((x) => x.id === id);
    if (m) m.config = config;
    return m;
  }
  async exec(app: string, id: string, command: string[], timeout: number) {
    this.rec("exec", app, id, command[0], timeout);
    this.execs.push(command);
    return this.execHandler(command);
  }
  async stopMachine(app: string, id: string) { this.rec("stopMachine", app, id); }
  async startMachine(app: string, id: string) { this.rec("startMachine", app, id); }
  count(m: string) { return this.calls.filter((c) => c.m === m).length; }
}

function healthFetch(map: Record<string, any>) {
  return async (url: string) => {
    const path = new URL(url).pathname;
    const body = map[path];
    return body ? new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }) : new Response("", { status: 503 });
  };
}

describe("dedicated estates", () => {
  let user: User;

  beforeEach(async () => {
    freshStore();
    Object.assign(process.env, FLY_ENV);
    user = await createUser("owner@example.com", "sufficiently-long-pass");
  });

  afterEach(() => {
    for (const k of Object.keys(FLY_ENV)) delete process.env[k];
  });

  it("derives a stable per-app secret from the master and never stores it", () => {
    const a = estateSecret("ff-est-aaaaaaaa", "m");
    expect(a).toBe(estateSecret("ff-est-aaaaaaaa", "m"));
    expect(a).not.toBe(estateSecret("ff-est-bbbbbbbb", "m"));
    expect(a).not.toBe(estateSecret("ff-est-aaaaaaaa", "other"));
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("provisions end to end, one idempotent step per call, and ends armed and ready", async () => {
    const e0 = await queueEstate(user);
    expect(e0.status).toBe("provisioning");
    expect(e0.step).toBe("create_app");
    expect(e0.app).toMatch(/^ff-est-[0-9a-f]{8}$/);
    expect(e0.app).toBe(newAppName(user.id)); // deterministic per user
    expect(e0.grantor).toBe("owner@example.com");
    expect(await queueEstate(user)).toMatchObject({ app: e0.app }); // idempotent

    const fly = new FakeFly();
    const health: Record<string, any> = {};
    const fetchImpl = healthFetch(health);
    const run = async () => advanceEstate((await getEstate(user.id))!, fly as any, { fetchImpl });

    for (const next of ["allocate_ips", "create_volume", "set_base_secrets", "create_machine", "wait_boot"]) {
      const r = await run();
      expect(r.outcome).toBe("progressed");
      expect(r.estate.step).toBe(next);
    }
    expect(fly.apps.has(e0.app)).toBe(true);
    expect(fly.ips[e0.app].map((i) => i.type).sort()).toEqual(["shared_v4", "v6"]);
    expect(fly.secrets[e0.app].FIELD_SHARED_SECRET).toBe(estateSecret(e0.app));
    const bootCfg = fly.machines[e0.app][0].config;
    expect(bootCfg.env.FORCE_GATEWAY_ENFORCE).toBeUndefined();
    expect(bootCfg.mounts[0].volume).toBe("vol_ff_data");

    // wait_boot: unhealthy -> waiting, then healthy -> bootstrap
    let r = await run();
    expect(r.outcome).toBe("waiting");
    expect(r.estate.step).toBe("wait_boot");
    expect(r.estate.polls).toBe(1);
    health["/registry/health"] = { ok: true };
    health["/ledger/health"] = { build_sha: "abc" };
    health["/delegation/health"] = { ok: true };
    r = await run();
    expect(r.estate.step).toBe("bootstrap");

    r = await run();
    expect(r.estate.step).toBe("provision_sentinel");
    expect(r.estate.fingerprints).toEqual({ "ledger-anchor": "fa", "ledger-sign": "fs", "attest-sign": "ft" });
    expect(r.estate.public_keys["ledger-sign"]).toContain("BEGIN PUBLIC KEY");
    const bootstrapCmd = fly.execs[0];
    expect(bootstrapCmd[0]).toBe("python3");
    expect(JSON.parse(bootstrapCmd[3])).toMatchObject({ grantor: "owner@example.com", allowed_scope: [], max_ttl_days: 30 });

    for (const agent of SELF_AGENTS) {
      r = await run();
      expect(fly.secrets[e0.app][agent.secret]).toBe("tok-" + agent.id);
    }
    expect(r.estate.step).toBe("arm");
    expect(Object.keys(r.estate.self_agents).sort()).toEqual(["compliance-crosswalk", "conformance-sentinel", "force-gateway"]);
    // token ids never land on the record
    expect(JSON.stringify(await getEstate(user.id))).not.toContain("tok-");
    // the provision exec carries the derived secret as $0 and the agent id as $1
    const prov = fly.execs[1];
    expect(prov.slice(0, 2)).toEqual(["sh", "-c"]);
    expect(prov[3]).toBe(estateSecret(e0.app));
    expect(prov[4]).toBe("conformance-sentinel");

    r = await run();
    expect(r.estate.step).toBe("wait_armed");
    expect(fly.count("updateMachine")).toBe(1);
    const armedCfg = fly.machines[e0.app][0].config;
    expect(armedCfg.env).toMatchObject({ FORCE_GATEWAY_ENFORCE: "1", FORCE_GATEWAY_TOOL_CHECK: "1", FIELD_LEDGER_REQUIRE_SIGNING: "1", FIELD_LEDGER_SIGN_KEY: "/data/keys/ledger-sign.pem", FIELD_ATTEST_SIGN_KEY: "/data/keys/attest-sign.pem" });
    expect(r.estate.posture).toEqual({ enforce: true, tool_check: true, require_signing: true, attest_signing: true });

    r = await run();
    expect(r.outcome).toBe("waiting"); // the machine is restarting; health not yet armed
    health["/ledger/health"] = { signing: "on", require_signing: true, appendable: true, key_fingerprint: "fs" };
    health["/gateway/health"] = { enforce: true, tool_check: true };
    health["/attest/health"] = { signing: "on" };
    r = await run();
    expect(r.outcome).toBe("done");
    expect(r.estate.status).toBe("ready");
    expect(r.estate.url).toBe(`https://${e0.app}.fly.dev`);
    expect(r.estate.step).toBe("done");

    const route = resolveRoute(user, r.estate);
    expect(route).toEqual({ kind: "estate", url: `https://${e0.app}.fly.dev`, secret: estateSecret(e0.app) });
    expect(fly.count("createVolume")).toBe(1);
    expect(fly.count("createMachine")).toBe(1);
    const pub = publicEstate(r.estate);
    expect(pub).not.toHaveProperty("lease_until");
    expect((pub as any).self_agents).toHaveLength(3);
  });

  it("refuses to declare ready when the ledger reports a different signing key", async () => {
    const e = await queueEstate(user);
    e.step = "wait_armed";
    e.fingerprints["ledger-sign"] = "fs";
    e.machine_id = "m_1";
    e.volume_id = "vol_1";
    await saveEstate(e);
    const health = {
      "/ledger/health": { signing: "on", require_signing: true, appendable: true, key_fingerprint: "someone-else" },
      "/gateway/health": { enforce: true, tool_check: true },
      "/attest/health": { signing: "on" },
    };
    const r = await advanceEstate((await getEstate(user.id))!, new FakeFly() as any, { fetchImpl: healthFetch(health) });
    expect(r.outcome).toBe("error");
    expect(r.estate.error).toContain("signing key");
    expect(r.estate.status).toBe("provisioning");
  });

  it("reuses an existing volume and machine instead of creating a second one", async () => {
    const e = await queueEstate(user);
    const fly = new FakeFly();
    fly.volumes[e.app] = [{ id: "vol_existing", name: "ff_data" }];
    fly.machines[e.app] = [{ id: "m_existing", name: "estate", config: {} }];
    fly.ips[e.app] = [{ address: "1.2.3.4", type: "shared_v4" }, { address: "::2", type: "v6" }];
    const run = async () => advanceEstate((await getEstate(user.id))!, fly as any, { fetchImpl: healthFetch({}) });
    for (let i = 0; i < 5; i++) await run();
    const now = (await getEstate(user.id))!;
    expect(now.step).toBe("wait_boot");
    expect(now.volume_id).toBe("vol_existing");
    expect(now.machine_id).toBe("m_existing");
    expect(fly.count("createVolume")).toBe(0);
    expect(fly.count("createMachine")).toBe(0);
    expect(fly.count("allocateIp")).toBe(0);
  });

  it("retries a failing step, gives up after MAX_ATTEMPTS, and can be retried by hand", async () => {
    await queueEstate(user);
    const fly = new FakeFly();
    fly.failOn.createApp = 100;
    let r;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      r = await advanceEstate((await getEstate(user.id))!, fly as any, { fetchImpl: healthFetch({}) });
      expect(r.outcome).toBe("error");
    }
    expect(r!.estate.status).toBe("error");
    expect(r!.estate.attempts).toBe(MAX_ATTEMPTS);
    expect(r!.estate.step).toBe("create_app");
    expect(resolveRoute(user, r!.estate)).toMatchObject({ kind: "refuse", status: 503, code: "estate_error" });
    const idle = await advanceEstate((await getEstate(user.id))!, fly as any, { fetchImpl: healthFetch({}) });
    expect(idle.outcome).toBe("idle");

    fly.failOn.createApp = 0;
    const back = await retryEstate((await getEstate(user.id))!);
    expect(back.status).toBe("provisioning");
    expect(back.attempts).toBe(0);
    const r2 = await advanceEstate((await getEstate(user.id))!, fly as any, { fetchImpl: healthFetch({}) });
    expect(r2.outcome).toBe("progressed");
    expect(r2.estate.step).toBe("allocate_ips");
  });

  it("a live lease keeps a second driver from running the same step", async () => {
    const e = await queueEstate(user);
    e.lease_until = new Date(Date.now() + 10000).toISOString();
    await saveEstate(e);
    const fly = new FakeFly();
    const r = await advanceEstate((await getEstate(user.id))!, fly as any, { fetchImpl: healthFetch({}) });
    expect(r.outcome).toBe("waiting");
    expect(fly.calls).toHaveLength(0);
  });

  it("queues as pending_manual without provisioning config, routes to the sandbox, and starts once configured", async () => {
    delete process.env.FLY_API_TOKEN;
    const e = await queueEstate(user);
    expect(e.status).toBe("pending_manual");
    expect(resolveRoute(user, e)).toEqual({ kind: "sandbox" });
    const idle = await advanceEstate(e, null, { fetchImpl: healthFetch({}) });
    expect(idle.outcome).toBe("idle");
    process.env.FLY_API_TOKEN = "fo1_test";
    const fly = new FakeFly();
    const r = await advanceEstate((await getEstate(user.id))!, fly as any, { fetchImpl: healthFetch({}) });
    expect(r.outcome).toBe("progressed");
    expect(r.estate.status).toBe("provisioning");
    expect(fly.count("createApp")).toBe(1);
  });

  it("routes provisioning and suspended estates to honest refusals", async () => {
    const e = await queueEstate(user);
    expect(resolveRoute(user, e)).toMatchObject({ kind: "refuse", status: 503, code: "estate_provisioning" });
    expect(resolveRoute(user, null)).toEqual({ kind: "sandbox" });
    e.status = "suspended";
    expect(resolveRoute(user, e)).toMatchObject({ kind: "refuse", status: 403, code: "estate_suspended" });
  });

  it("suspends by stopping the machine (data kept) and resumes to the prior status", async () => {
    const e = await queueEstate(user);
    e.status = "ready";
    e.step = "done";
    e.machine_id = "m_1";
    e.url = `https://${e.app}.fly.dev`;
    await saveEstate(e);
    const fly = new FakeFly();
    const s = await suspendEstate((await getEstate(user.id))!, fly as any, new Date(), "subscription canceled");
    expect(s.status).toBe("suspended");
    expect(s.suspended_from).toBe("ready");
    expect(fly.calls).toEqual([{ m: "stopMachine", args: [e.app, "m_1"] }]);
    const back = await resumeEstate((await getEstate(user.id))!, fly as any);
    expect(back.status).toBe("ready");
    expect(back.suspended_at).toBeNull();
    expect(fly.calls[1]).toEqual({ m: "startMachine", args: [e.app, "m_1"] });
  });

  it("places the Anthropic key as an estate secret, restarts the machine and stores only the time", async () => {
    const e = await queueEstate(user);
    e.status = "ready";
    e.step = "done";
    e.machine_id = "m_1";
    await saveEstate(e);
    const fly = new FakeFly();
    fly.machines[e.app] = [{ id: "m_1", name: "estate", config: { image: "img", env: { A: "1" } } }];
    const key = "sk-ant-api03-" + "x".repeat(60);
    await setEstateAnthropicKey((await getEstate(user.id))!, fly as any, key);
    expect(fly.secrets[e.app].ANTHROPIC_API_KEY).toBe(key);
    expect(fly.count("updateMachine")).toBe(1);
    const stored = JSON.stringify(await getEstate(user.id));
    expect(stored).not.toContain("sk-ant-");
    expect((await getEstate(user.id))!.anthropic_key_set_at).toBeTruthy();
    await expect(setEstateAnthropicKey((await getEstate(user.id))!, fly as any, "nope")).rejects.toMatchObject({ code: "bad_key" });
    e.status = "provisioning";
    await saveEstate(e);
    await expect(setEstateAnthropicKey((await getEstate(user.id))!, fly as any, key)).rejects.toMatchObject({ code: "estate_not_ready" });
  });

  it("rewrites the customer's roster row on a ready estate and stores it for bootstrap otherwise", async () => {
    const e = await queueEstate(user);
    const fly = new FakeFly();
    const stored = await updateEstateRoster((await getEstate(user.id))!, fly as any, { allowed_scope: ["read timesheets", "read timesheets", " draft invoice "], max_ttl_days: 7, max_spend_usd: "25" });
    expect(stored.roster).toEqual({ allowed_scope: ["read timesheets", "draft invoice"], max_ttl_days: 7, max_spend_usd: 25 });
    expect(fly.count("exec")).toBe(0);
    e.status = "ready";
    e.step = "done";
    e.machine_id = "m_1";
    await saveEstate(e);
    const live = await updateEstateRoster((await getEstate(user.id))!, fly as any, { allowed_scope: ["a"], max_ttl_days: 30, max_spend_usd: null });
    expect(fly.count("exec")).toBe(1);
    expect(JSON.parse(fly.execs[0][3])).toEqual({ grantor: "owner@example.com", allowed_scope: ["a"], max_ttl_days: 30, max_spend_usd: null });
    expect(live.roster.allowed_scope).toEqual(["a"]);
    expect(live.log.at(-1)!.note).toMatch(/rewritten .*2 rows/);

    // No scopes: the row is removed (an empty scope list would invalidate the whole roster) and the log says so.
    const cleared = await updateEstateRoster((await getEstate(user.id))!, fly as any, { allowed_scope: [], max_ttl_days: 30, max_spend_usd: null });
    expect(cleared.roster.allowed_scope).toEqual([]);
    expect(cleared.log.at(-1)!.note).toMatch(/removed: no scopes/);

    // The estate's validator rejected the file: nothing is stored, the error names the cause.
    fly.execHandler = () => ({ exit_code: 1, stdout: JSON.stringify({ error: "roster rejected by the estate's validator, live roster untouched: max_ttl_days" }) + "\n", stderr: "" });
    await expect(updateEstateRoster((await getEstate(user.id))!, fly as any, { allowed_scope: ["b"], max_ttl_days: 5, max_spend_usd: null })).rejects.toMatchObject({
      code: "roster_failed",
      message: expect.stringContaining("rejected by the estate's validator"),
    });
    expect((await getEstate(user.id))!.roster.allowed_scope).toEqual([]);
  });

  it("validates roster rows and Anthropic keys", () => {
    expect(() => validateRoster({ allowed_scope: "x", max_ttl_days: 1 })).toThrow(/allowed_scope/);
    expect(() => validateRoster({ allowed_scope: [], max_ttl_days: 0 })).toThrow(/max_ttl_days/);
    expect(() => validateRoster({ allowed_scope: [], max_ttl_days: 366 })).toThrow(/max_ttl_days/);
    expect(() => validateRoster({ allowed_scope: ["ok"], max_ttl_days: 30, max_spend_usd: -1 })).toThrow(/max_spend_usd/);
    expect(() => validateRoster({ allowed_scope: ["bad\u0000"], max_ttl_days: 30 })).toThrow(/printable/);
    expect(validateRoster({ allowed_scope: ["ok"], max_ttl_days: 30, max_spend_usd: "" })).toEqual({ allowed_scope: ["ok"], max_ttl_days: 30, max_spend_usd: null });
    expect(validateAnthropicKey("  sk-ant-api03-" + "a".repeat(40) + " ")).toBe("sk-ant-api03-" + "a".repeat(40));
    expect(() => validateAnthropicKey("sk-live-x")).toThrow(/Anthropic/);
    expect(() => validateAnthropicKey(42)).toThrow();
  });

  it("lists every step in order, ending in done", () => {
    expect(STEPS[0]).toBe("create_app");
    expect(STEPS[STEPS.length - 1]).toBe("done");
    expect(new Set(STEPS).size).toBe(STEPS.length);
  });
});
