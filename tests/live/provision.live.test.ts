// LIVE provisioning rehearsal — creates a REAL Fly.io app (ff-est-<hex>), runs
// the whole state machine against the Machines/GraphQL APIs with the real
// estate image, verifies the armed posture off-box through the public origin,
// and destroys the app at the end (set FF_LIVE_KEEP=1 to keep it for a look).
//
// Skipped unless FF_LIVE_FLY=1. The token comes from FLY_API_TOKEN or, on an
// operator's machine, from ~/.fly/config.yml — read into the process, never
// printed. Cost: one shared-cpu-1x/2 GB machine + 1 GB volume for ~10 minutes.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { freshStore } from "../helpers";
import { createUser } from "../../src/lib/users";
import { FlyClient, flyConfig } from "../../src/lib/fly";
import { advanceEstate, checkEstateHealth, estateSecret, getEstate, healthJson, queueEstate, updateEstateRoster, upgradeEstateImage } from "../../src/lib/estates";

const LIVE = process.env.FF_LIVE_FLY === "1";

function flyTokenFromConfig(): string | null {
  try {
    const y = readFileSync(join(homedir(), ".fly", "config.yml"), "utf8");
    const m = y.match(/^access_token:\s*"?([^"\r\n]+)"?/m);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

const stamp = () => new Date().toISOString().slice(11, 19);

describe.skipIf(!LIVE)("LIVE Fly provisioning (creates and destroys a real ff-est app)", () => {
  it("provisions an estate end to end, verifies the armed posture off-box, and tears it down", async () => {
    const token = process.env.FLY_API_TOKEN || flyTokenFromConfig();
    expect(token, "no Fly token (FLY_API_TOKEN or ~/.fly/config.yml)").toBeTruthy();
    process.env.FLY_API_TOKEN = token!;
    process.env.FLY_ORG_SLUG = process.env.FLY_ORG_SLUG || "personal";
    process.env.FLY_ESTATE_IMAGE = process.env.FLY_ESTATE_IMAGE || "registry.fly.io/force-field-sandbox:v1-2-f-pricing-ec47f2a";
    process.env.ESTATE_SECRET_MASTER = randomBytes(32).toString("base64url");
    freshStore();
    const user = await createUser("live-test@example.com", "sufficiently-long-pass");
    const fly = new FlyClient(flyConfig()!);
    const e0 = await queueEstate(user);
    console.log(`[${stamp()}] live estate app ${e0.app} in org ${process.env.FLY_ORG_SLUG}, image ${process.env.FLY_ESTATE_IMAGE}`);

    const deadline = Date.now() + 20 * 60 * 1000;
    try {
      while (Date.now() < deadline) {
        const e = (await getEstate(user.id))!;
        const r = await advanceEstate(e, fly);
        console.log(`[${stamp()}] ${r.outcome.padEnd(10)} step=${r.estate.step} status=${r.estate.status} attempts=${r.estate.attempts} polls=${r.estate.polls} | ${r.note.slice(0, 200)}`);
        if (r.outcome === "done" || r.estate.status === "error") break;
        await new Promise((res) => setTimeout(res, r.outcome === "waiting" ? 10000 : 1500));
      }
      const e = (await getEstate(user.id))!;
      console.log(`[${stamp()}] final status ${e.status}; log tail:\n` + e.log.slice(-6).map((l) => `  ${l.at.slice(11, 19)} ${l.step}: ${l.note}`).join("\n"));
      expect(e.status).toBe("ready");
      expect(e.url).toBe(`https://${e.app}.fly.dev`);

      // Off-box evidence through the public origin (no secret needed for /health).
      const led = await healthJson(e.url!, "/ledger/health");
      const gw = await healthJson(e.url!, "/gateway/health");
      const at = await healthJson(e.url!, "/attest/health");
      console.log(`[${stamp()}] ledger ${JSON.stringify({ signing: led?.signing, require_signing: led?.require_signing, appendable: led?.appendable, fp: led?.key_fingerprint, build: led?.build_sha, events: led?.event_count })}`);
      console.log(`[${stamp()}] gateway ${JSON.stringify({ enforce: gw?.enforce, tool_check: gw?.tool_check, mock: gw?.mock })} attest ${JSON.stringify({ signing: at?.signing, fp: at?.key_fingerprint })}`);
      expect(led?.signing).toBe("on");
      expect(led?.require_signing).toBe(true);
      expect(led?.key_fingerprint).toBe(e.fingerprints["ledger-sign"]);
      expect(gw?.enforce).toBe(true);
      expect(gw?.tool_check).toBe(true);
      expect(at?.signing).toBe("on");
      expect(at?.key_fingerprint).toBe(e.fingerprints["attest-sign"]);

      // The staged secrets (shared secret + the three self-agent token ids) must
      // have reached the ARMED machine: health payloads do not expose them, so
      // ask the machine itself — presence only, never a value.
      const envProbe = await fly.exec(
        e.app,
        e.machine_id!,
        ["python3", "-c", "import os, json; print(json.dumps({k: bool(os.environ.get(k)) for k in ['FIELD_SHARED_SECRET', 'FIELD_SENTINEL_SELF_TOKEN', 'FIELD_GATEWAY_SELF_TOKEN', 'FIELD_CROSSWALK_SELF_TOKEN', 'FIELD_LEDGER_REQUIRE_SIGNING', 'FORCE_GATEWAY_ENFORCE']}))"],
        20,
      );
      const present: Record<string, boolean> = JSON.parse(envProbe.stdout.trim().split(/\r?\n/).pop() || "{}");
      console.log(`[${stamp()}] armed machine env presence (rc ${envProbe.exit_code}): ${JSON.stringify(present)}`);
      expect(envProbe.exit_code).toBe(0);
      expect(present.FIELD_SHARED_SECRET).toBe(true);
      expect(present.FIELD_SENTINEL_SELF_TOKEN).toBe(true);
      expect(present.FIELD_GATEWAY_SELF_TOKEN).toBe(true);
      expect(present.FIELD_CROSSWALK_SELF_TOKEN).toBe(true);

      // The lifecycle sweep roster (owners.csv written at bootstrap, FIELD_LIFECYCLE_ROSTER
      // in the machine env) must be armed: the last Phase F switch customer estates lacked.
      const lc = await healthJson(e.url!, "/lifecycle/health");
      console.log(`[${stamp()}] lifecycle ${JSON.stringify({ roster_configured: lc?.roster_configured, every: lc?.every })}`);
      expect(lc?.roster_configured).toBe(true);

      // The tick's health look at a ready estate.
      const h = await checkEstateHealth((await getEstate(user.id))!, fly);
      console.log(`[${stamp()}] health check outcome ${h}: ${JSON.stringify((await getEstate(user.id))!.health)}`);
      expect(h).toBe("ok");

      // The derived shared secret is the one the estate holds: an authenticated
      // sentinel check works with it and 401s without it.
      const secret = estateSecret(e.app);
      const body = JSON.stringify({ agent_id: "conformance-sentinel", action: "live.test.noop" });
      const ok = await fetch(e.url + "/sentinel/check", { method: "POST", headers: { "content-type": "application/json", "x-field-auth": secret }, body });
      const okBody: any = await ok.json().catch(() => null);
      console.log(`[${stamp()}] sentinel/check with the derived secret: HTTP ${ok.status} verdict ${okBody?.verdict ?? okBody?.decision ?? JSON.stringify(okBody).slice(0, 120)}`);
      expect(ok.status).toBe(200);
      const bad = await fetch(e.url + "/sentinel/check", { method: "POST", headers: { "content-type": "application/json", "x-field-auth": "wrong" }, body });
      console.log(`[${stamp()}] sentinel/check with a wrong secret: HTTP ${bad.status}`);
      expect(bad.status).toBe(401);

      // Gateway enforce: a perimeter-authenticated call with no agent identity is refused.
      const gwr = await fetch(e.url + "/gateway/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-field-auth": secret },
        body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 5, messages: [{ role: "user", content: "hi" }] }),
      });
      console.log(`[${stamp()}] gateway/v1/messages without identity headers: HTTP ${gwr.status}`);
      expect(gwr.status).toBe(401);

      // The roster row rewrite path (read per mint; no restart).
      const rostered = await updateEstateRoster((await getEstate(user.id))!, fly, { allowed_scope: ["live.test"], max_ttl_days: 1, max_spend_usd: null });
      console.log(`[${stamp()}] roster rewritten: ${JSON.stringify(rostered.roster)}`);
      expect(rostered.roster.allowed_scope).toEqual(["live.test"]);

      // The image-upgrade path, forced onto the same image: a real machine update in the
      // armed posture, then the posture and the SAME signing key re-verified off-box.
      const t0 = Date.now();
      const up = await upgradeEstateImage((await getEstate(user.id))!, fly, { force: true, polls: 40, sleepMs: 5000 });
      console.log(`[${stamp()}] forced image re-apply: ${up.outcome} in ${Math.round((Date.now() - t0) / 1000)} s; image ${up.estate.image}; health ${JSON.stringify(up.estate.health)}`);
      expect(up.outcome).toBe("upgraded");
      expect(up.estate.image).toBe(process.env.FLY_ESTATE_IMAGE);
      expect(up.estate.upgrade_failed_image).toBeNull();
      const ledAfter = await healthJson(e.url!, "/ledger/health");
      expect(ledAfter?.key_fingerprint).toBe(e.fingerprints["ledger-sign"]);
    } finally {
      const e = await getEstate(user.id);
      if (e && process.env.FF_LIVE_KEEP !== "1") {
        await fly.deleteApp(e.app);
        console.log(`[${stamp()}] destroyed app ${e.app} (volume and machine with it)`);
      } else {
        console.log(`[${stamp()}] KEPT app ${e?.app} (FF_LIVE_KEEP=1) — destroy it by hand: fly apps destroy ${e?.app} -y`);
      }
    }
  }, 25 * 60 * 1000);
});
