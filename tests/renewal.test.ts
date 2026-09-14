import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { freshStore } from "./helpers";
import { createUser, type User } from "../src/lib/users";
import { SELF_AGENTS, estateSecret, getEstate, queueEstate, saveEstate } from "../src/lib/estates";
import { RENEW_AFTER_DAYS, RENEW_PY, renewSelfAgents, renewalDue } from "../src/lib/renewal";

const FLY_ENV = { FLY_API_TOKEN: "fo1_test", FLY_ORG_SLUG: "personal", FLY_ESTATE_IMAGE: "registry.fly.io/x:y", ESTATE_SECRET_MASTER: "master-0123456789" };

class RenewFly {
  calls: string[] = [];
  execs: string[][] = [];
  secrets: Record<string, string> = {};
  updates = 0;
  fail = false;
  async exec(_app: string, _id: string, command: string[]) {
    this.calls.push("exec");
    this.execs.push(command);
    if (this.fail) return { exit_code: 1, stdout: JSON.stringify({ error: "HTTP 403: D.grantor" }) + "\n", stderr: "" };
    return { exit_code: 0, stdout: JSON.stringify({ token_id: "new-" + command[4], expires_at: "later" }) + "\n", stderr: "" };
  }
  async setSecrets(_app: string, s: Record<string, string>) { this.calls.push("setSecrets"); Object.assign(this.secrets, s); }
  async getMachine() { this.calls.push("getMachine"); return { id: "m_1", config: { image: "img", env: { A: "1" } } }; }
  async updateMachine() { this.calls.push("updateMachine"); this.updates += 1; return { id: "m_1" }; }
}

const daysAgo = (d: number) => new Date(Date.now() - d * 86400 * 1000).toISOString();

describe("self-agent token renewal", () => {
  let user: User;

  beforeEach(async () => {
    freshStore();
    Object.assign(process.env, FLY_ENV);
    user = await createUser("renew@example.com", "sufficiently-long-pass");
  });

  afterEach(() => {
    for (const k of Object.keys(FLY_ENV)) delete process.env[k];
  });

  async function readyEstate(ageDays: number) {
    const e = await queueEstate(user);
    e.status = "ready";
    e.step = "done";
    e.machine_id = "m_1";
    e.url = `https://${e.app}.fly.dev`;
    for (const a of SELF_AGENTS) e.self_agents[a.id] = { provisioned_at: daysAgo(ageDays) };
    await saveEstate(e);
    return (await getEstate(user.id))!;
  }

  it("is due only for ready estates whose tokens are older than the renewal age", async () => {
    expect(renewalDue(await readyEstate(RENEW_AFTER_DAYS - 1))).toBe(false);
    expect(renewalDue(await readyEstate(RENEW_AFTER_DAYS + 1))).toBe(true);
    const e = await readyEstate(RENEW_AFTER_DAYS + 1);
    e.status = "suspended";
    expect(renewalDue(e)).toBe(false);
    e.status = "ready";
    delete e.self_agents["force-gateway"];
    expect(renewalDue(e)).toBe(true);
  });

  it("mints all three in-machine, sets the secrets, restarts once, and keeps no token id", async () => {
    const e = await readyEstate(26);
    const fly = new RenewFly();
    const before = new Date();
    const out = await renewSelfAgents(e, fly as any);
    expect(fly.execs).toHaveLength(3);
    for (const [i, a] of SELF_AGENTS.entries()) {
      expect(fly.execs[i].slice(0, 3)).toEqual(["python3", "-c", RENEW_PY]);
      expect(fly.execs[i][3]).toBe(estateSecret(e.app));
      expect(fly.execs[i][4]).toBe(a.id);
      expect(fly.secrets[a.secret]).toBe("new-" + a.id);
    }
    expect(fly.calls.filter((c) => c === "setSecrets")).toHaveLength(1);
    expect(fly.updates).toBe(1);
    for (const a of SELF_AGENTS) expect(new Date(out.self_agents[a.id].provisioned_at).getTime()).toBeGreaterThanOrEqual(before.getTime() - 5);
    expect(renewalDue(out)).toBe(false);
    expect(JSON.stringify(await getEstate(user.id))).not.toContain("new-");
    expect(RENEW_PY).toContain('"ttl_seconds": 2591940');
  });

  it("fails closed when a mint is refused: no secrets set, no restart, failure logged", async () => {
    const e = await readyEstate(26);
    const fly = new RenewFly();
    fly.fail = true;
    await expect(renewSelfAgents(e, fly as any)).rejects.toMatchObject({ code: "renew_failed" });
    expect(fly.calls).toEqual(["exec"]);
    expect(fly.updates).toBe(0);
    const stored = (await getEstate(user.id))!;
    expect(stored.log.at(-1)?.note).toContain("D.grantor");
    expect(renewalDue(stored)).toBe(true);
  });

  it("refuses to renew an estate that is not ready", async () => {
    const e = await readyEstate(26);
    e.status = "provisioning";
    await expect(renewSelfAgents(e, new RenewFly() as any)).rejects.toMatchObject({ code: "estate_not_ready" });
  });
});
