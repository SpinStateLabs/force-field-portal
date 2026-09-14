// Force-Field Portal — dedicated estates.
//
// One Fly.io app per paying account (`ff-est-<8 hex>`), created and armed by
// a resumable state machine: every step is idempotent, short (one or two Fly
// calls), and recorded on the estate blob "estates/<user_id>" so a step can be
// driven by the dashboard's poll, by the scheduled tick, or by a retry after an
// error. The posture that results is the Phase F product posture of the
// public sandbox (ledger per-event signing REQUIRED, served attestations
// signed, gateway enforce + tool check, DOA roster mint gate).
//
// Secrets: the estate's shared secret is DERIVED (HMAC of ESTATE_SECRET_MASTER
// over the app name) so nothing per-estate is stored; self-agent token ids are
// minted in the estate and pushed straight into Fly secrets, never persisted
// here; the customer's Anthropic key goes to Fly secrets and is never stored.
// Only PUBLIC keys leave the estate (kept on the record so the customer can
// verify their ledger and attestations off-box).

import { createHash, createHmac } from "node:crypto";
import { env, portalStore } from "./store";
import type { User } from "./users";
import { estateMachineConfig, estateOrigin, flyConfig, type FetchLike, type FlyClient } from "./fly";

export type EstateStatus = "pending_manual" | "provisioning" | "ready" | "suspended" | "error";

export const STEPS = [
  "create_app",
  "allocate_ips",
  "create_volume",
  "set_base_secrets",
  "create_machine",
  "wait_boot",
  "bootstrap",
  "provision_sentinel",
  "provision_gateway",
  "provision_crosswalk",
  "arm",
  "wait_armed",
  "done",
] as const;
export type EstateStep = (typeof STEPS)[number];

export type RosterRow = {
  allowed_scope: string[];
  max_ttl_days: number;
  max_spend_usd: number | null;
};

export type Estate = {
  user_id: string;
  app: string;
  region: string;
  status: EstateStatus;
  step: EstateStep;
  attempts: number;
  polls: number;
  error: string | null;
  log: { at: string; step: string; note: string }[];
  volume_id: string | null;
  machine_id: string | null;
  ips: string[];
  url: string | null;
  grantor: string;
  roster: RosterRow;
  public_keys: Record<string, string>;
  fingerprints: Record<string, string>;
  self_agents: Record<string, { provisioned_at: string }>;
  posture: { enforce: boolean; tool_check: boolean; require_signing: boolean; attest_signing: boolean } | null;
  anthropic_key_set_at: string | null;
  suspended_from: EstateStatus | null;
  lease_until: string | null;
  worker_until: string | null;
  created_at: string;
  updated_at: string;
  ready_at: string | null;
  suspended_at: string | null;
};

export const SELF_GRANTOR = "Founder & CTO, Spin State Labs";
export const SELF_OWNER = "Spin State Labs (platform self-agent)";
export const SELF_AGENTS: { id: string; step: EstateStep; secret: string }[] = [
  { id: "conformance-sentinel", step: "provision_sentinel", secret: "FIELD_SENTINEL_SELF_TOKEN" },
  { id: "force-gateway", step: "provision_gateway", secret: "FIELD_GATEWAY_SELF_TOKEN" },
  { id: "compliance-crosswalk", step: "provision_crosswalk", secret: "FIELD_CROSSWALK_SELF_TOKEN" },
];
export const MAX_ATTEMPTS = 6;
export const MAX_POLLS = 90;
export const LEASE_MS = 25000;
export const MAX_LOG = 60;
export const DEFAULT_ROSTER: RosterRow = { allowed_scope: [], max_ttl_days: 30, max_spend_usd: null };

export class EstateError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

// --- records ------------------------------------------------------------------

export function estateKey(userId: string): string {
  return "estates/" + userId;
}

export async function getEstate(userId: string): Promise<Estate | null> {
  const store = await portalStore();
  return ((await store.get(estateKey(userId), { type: "json" })) as Estate | null) ?? null;
}

export async function saveEstate(e: Estate, now: Date = new Date()): Promise<void> {
  e.updated_at = now.toISOString();
  if (e.log.length > MAX_LOG) e.log = e.log.slice(e.log.length - MAX_LOG);
  const store = await portalStore();
  await store.setJSON(estateKey(e.user_id), e);
}

export async function listEstates(): Promise<Estate[]> {
  const store = await portalStore();
  const { blobs } = await store.list({ prefix: "estates/" });
  const out: Estate[] = [];
  for (const b of blobs) {
    const e = (await store.get(b.key, { type: "json" })) as Estate | null;
    if (e) out.push(e);
  }
  return out;
}

export function logEstate(e: Estate, step: string, note: string, now: Date = new Date()): void {
  e.log.push({ at: now.toISOString(), step, note });
}

/**
 * Fly app name for a user: lowercase, digits, dashes; DETERMINISTIC (a hash of
 * the user id), so two racing writers of the same estate record (a webhook
 * redelivery, a concurrent driver) agree on one app instead of orphaning one.
 */
export function newAppName(userId: string): string {
  return "ff-est-" + createHash("sha256").update("estate-app:" + userId).digest("hex").slice(0, 8);
}

/** The estate's shared secret, derived — never stored. base64url, 43 chars. */
export function estateSecret(app: string, master: string | undefined = env("ESTATE_SECRET_MASTER")): string {
  if (!master) throw new EstateError(501, "provisioning_not_configured", "ESTATE_SECRET_MASTER is not set.");
  return createHmac("sha256", master).update("estate-secret:" + app).digest("base64url");
}

export function attestSigner(grantor: string): string {
  return `Force-Field estate key for ${grantor} (provisioned by Spin State Labs — standing attestation)`;
}

/** Create the estate record for a paying user, or return the existing one. */
export async function queueEstate(user: User, now: Date = new Date()): Promise<Estate> {
  const existing = await getEstate(user.id);
  if (existing) return existing;
  const configured = flyConfig() !== null;
  const e: Estate = {
    user_id: user.id,
    app: newAppName(user.id),
    region: flyConfig()?.region ?? "yyz",
    status: configured ? "provisioning" : "pending_manual",
    step: "create_app",
    attempts: 0,
    polls: 0,
    error: null,
    log: [],
    volume_id: null,
    machine_id: null,
    ips: [],
    url: null,
    grantor: user.email,
    roster: { ...DEFAULT_ROSTER, allowed_scope: [] },
    public_keys: {},
    fingerprints: {},
    self_agents: {},
    posture: null,
    anthropic_key_set_at: null,
    suspended_from: null,
    lease_until: null,
    worker_until: null,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    ready_at: null,
    suspended_at: null,
  };
  logEstate(e, "queue", configured ? "queued for automatic provisioning" : "queued; provisioning is not configured on this deployment (manual)", now);
  await saveEstate(e, now);
  return e;
}

// --- in-machine scripts -----------------------------------------------------------

/**
 * Shared by the bootstrap and roster scripts. The estate's DOA roster is
 * FAIL-CLOSED: a row with no scopes (or any other invalid row) makes the whole
 * file invalid and the delegation service then refuses EVERY mint with 503 —
 * including the platform self-agents (the live rehearsal of 2026-09-14 failed
 * at `lifecycle provision` for exactly this: the customer's default row had an
 * empty scope list). So: a customer row is written only once it has scopes,
 * and the file is validated with the estate's own loader before it replaces
 * the live roster. The roster path is the one the delegation service reads
 * (FIELD_DOA_ROSTER, inherited by exec; /data/doa-roster.yaml on an estate).
 */
export const ROSTER_LIB_PY = `
import json, os, sys
import yaml
from delegation_authority.doa import load_roster
ROSTER = os.environ.get("FIELD_DOA_ROSTER") or "/data/doa-roster.yaml"
def customer_row(c):
    scopes = [s for s in (c.get("allowed_scope") or []) if s]
    if not scopes: return None
    row = {"grantor": c["grantor"], "allowed_scope": scopes, "max_ttl_days": int(c["max_ttl_days"]), "active": True}
    if c.get("max_spend_usd") is not None: row["max_spend_usd"] = float(c["max_spend_usd"])
    return row
def write_roster(rows):
    tmp = os.path.join(os.path.dirname(ROSTER) or ".", ".doa-roster.tmp")
    with open(tmp, "w") as f: yaml.safe_dump({"grantors": rows}, f, sort_keys=False, allow_unicode=True)
    os.chmod(tmp, 0o600)
    try:
        load_roster(tmp)
    except Exception as e:
        os.unlink(tmp)
        print(json.dumps({"error": "roster rejected by the estate's validator, live roster untouched: %s" % str(e)[:300]})); sys.exit(1)
    os.replace(tmp, ROSTER)
`;

/** argv[1] = JSON {grantor, allowed_scope, max_ttl_days, max_spend_usd}. Prints one JSON line. */
export const BOOTSTRAP_PY = ROSTER_LIB_PY + `
import base64, hashlib, subprocess, importlib.resources as r
os.makedirs("/data/keys", exist_ok=True); os.makedirs("/data/manifests", exist_ok=True)
out = {"keys": {}, "manifests": []}
for name in ("ledger-anchor", "ledger-sign", "attest-sign"):
    priv = "/data/keys/%s.pem" % name
    if not os.path.exists(priv):
        p = subprocess.run([sys.executable, "/platform/tools/volume_admin.py", "keys", "generate", "--dir", "/data/keys", name], capture_output=True, text=True)
        if p.returncode != 0:
            print(json.dumps({"error": "keygen %s rc=%d: %s" % (name, p.returncode, p.stderr[-300:])})); sys.exit(1)
    pub = open("/data/keys/%s.pub.pem" % name).read()
    der = base64.b64decode("".join(l for l in pub.splitlines() if not l.startswith("-----")))
    out["keys"][name] = {"pub": pub, "fingerprint": hashlib.sha256(der[-32:]).hexdigest()}
pairs = (("conformance-sentinel", "conformance_sentinel"), ("force-gateway", "force_gateway"), ("compliance-crosswalk", "compliance_crosswalk"))
for mid, pkg in pairs:
    src = r.files(pkg) / "self_manifest.yaml"
    with open("/data/manifests/%s.yaml" % mid, "w") as f: f.write(src.read_text())
    out["manifests"].append(mid)
self_name = "Founder & CTO, Spin State Labs"; scopes = []
for mid, _ in pairs:
    m = yaml.safe_load(open("/data/manifests/%s.yaml" % mid))
    assert m["identity"]["principal"] == self_name, m["identity"]["principal"]
    for s in m["delegation"]["scope"]:
        if s not in scopes: scopes.append(s)
c = json.loads(sys.argv[1])
rows = [{"grantor": self_name, "allowed_scope": scopes, "max_ttl_days": 30, "active": True}]
crow = customer_row(c)
if crow: rows.append(crow)
write_roster(rows)
out["roster_rows"] = len(rows); out["customer_row"] = bool(crow)
print(json.dumps(out))
`;

/** argv[1] = JSON row (grantor, allowed_scope, max_ttl_days, max_spend_usd): replace that grantor's row, keep the rest. */
export const ROSTER_PY = ROSTER_LIB_PY + `
c = json.loads(sys.argv[1])
doc = yaml.safe_load(open(ROSTER)) if os.path.exists(ROSTER) else {"grantors": []}
rows = [x for x in ((doc or {}).get("grantors") or []) if x.get("grantor") != c["grantor"]]
crow = customer_row(c)
if crow: rows.append(crow)
write_roster(rows)
print(json.dumps({"roster_rows": len(rows), "customer_row": bool(crow)}))
`;

/** $0 = shared secret, $1 = self-agent id, $2 = owner. Prints one JSON line with the token id; on failure, the report's steps. */
export const PROVISION_SH = `
set -e
export FIELD_SHARED_SECRET="$0" FIELD_REGISTRY_URL=http://127.0.0.1:8001 FIELD_LEDGER_URL=http://127.0.0.1:8002 FIELD_DELEGATION_URL=http://127.0.0.1:8003 FIELD_GOVERNOR_URL=http://127.0.0.1:8006 FIELD_LIFECYCLE_URL=http://127.0.0.1:8012
id="$1"; owner="$2"
lifecycle provision --manifest "/data/manifests/$id.yaml" --owner "$owner" --domain platform --grantor "Founder & CTO, Spin State Labs" --ttl-days 30 --manifest-ref "/data/manifests/$id.yaml" --out "/tmp/prov-$id.json" > "/tmp/prov-$id.out" 2>&1 || {
  tail -c 300 "/tmp/prov-$id.out" || true
  python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print('steps:', [[s['step'], s['outcome'], str(s.get('detail') or '')[:200]] for s in d.get('steps', [])])" "/tmp/prov-$id.json" 2>/dev/null || true
  exit 1
}
python3 -c "import json,sys; d=json.load(open('/tmp/prov-'+sys.argv[1]+'.json')); print(json.dumps({'token_id': d['token_id'], 'ok': d.get('ok'), 'steps': [[s['step'], s['outcome']] for s in d.get('steps', [])]}))" "$id"
rm -f "/tmp/prov-$id.json"
`;

// --- helpers ---------------------------------------------------------------------

/** Replace every occurrence of a secret in captured output before it is logged, stored or served. */
export function redactSecret(text: string, secret: string | null | undefined): string {
  if (!secret || !text) return text ?? "";
  return text.split(secret).join("[redacted]");
}

export function lastJsonLine(text: string): any | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith("{")) {
      try {
        return JSON.parse(lines[i]);
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

export async function healthJson(origin: string, path: string, fetchImpl: FetchLike = fetch): Promise<any | null> {
  try {
    const res = await fetchImpl(origin + path, { method: "GET", signal: AbortSignal.timeout(6000) });
    if (res.status !== 200) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export function validateRoster(input: any): RosterRow {
  const scopes = input?.allowed_scope;
  if (!Array.isArray(scopes) || scopes.length > 64) throw new EstateError(400, "bad_roster", "allowed_scope must be a list of at most 64 scope strings.");
  const cleaned: string[] = [];
  for (const s of scopes) {
    if (typeof s !== "string") throw new EstateError(400, "bad_roster", "Every scope must be a string.");
    const t = s.trim();
    if (!t || t.length > 120 || /[\u0000-\u001f\u007f]/.test(t)) throw new EstateError(400, "bad_roster", "Scopes are 1–120 printable characters.");
    if (!cleaned.includes(t)) cleaned.push(t);
  }
  const ttl = Number(input?.max_ttl_days);
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > 365) throw new EstateError(400, "bad_roster", "max_ttl_days must be an integer from 1 to 365.");
  let spend: number | null = null;
  if (input?.max_spend_usd !== null && input?.max_spend_usd !== undefined && input?.max_spend_usd !== "") {
    spend = Number(input.max_spend_usd);
    if (!Number.isFinite(spend) || spend <= 0 || spend > 1_000_000) throw new EstateError(400, "bad_roster", "max_spend_usd must be a positive number (or empty for no ceiling).");
  }
  return { allowed_scope: cleaned, max_ttl_days: ttl, max_spend_usd: spend };
}

export function validateAnthropicKey(key: any): string {
  if (typeof key !== "string") throw new EstateError(400, "bad_key", "key must be a string.");
  const k = key.trim();
  if (!/^sk-ant-[A-Za-z0-9_-]{30,220}$/.test(k)) throw new EstateError(400, "bad_key", "That does not look like an Anthropic API key (sk-ant-…).");
  return k;
}

// --- the state machine ----------------------------------------------------------

export type AdvanceOutcome = "progressed" | "waiting" | "done" | "error" | "idle";
export type AdvanceResult = { estate: Estate; outcome: AdvanceOutcome; note: string };

function nextStep(e: Estate, note: string, now: Date): void {
  const i = STEPS.indexOf(e.step);
  logEstate(e, e.step, note, now);
  e.step = STEPS[Math.min(i + 1, STEPS.length - 1)];
  e.attempts = 0;
  e.polls = 0;
  e.error = null;
}

/**
 * Run ONE provisioning step. Safe to call from several drivers: a short lease
 * on the record keeps two callers from running the same step at once, and each
 * step checks Fly for what already exists before creating anything.
 */
export async function advanceEstate(
  e: Estate,
  fly: FlyClient | null,
  opts: { now?: Date; fetchImpl?: FetchLike } = {},
): Promise<AdvanceResult> {
  const now = opts.now ?? new Date();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const cfg = flyConfig();

  if (e.status === "pending_manual" && fly && cfg) {
    e.status = "provisioning";
    logEstate(e, "queue", "provisioning became configured; starting", now);
    await saveEstate(e, now);
  }
  if (e.status !== "provisioning") return { estate: e, outcome: "idle", note: `estate is ${e.status}` };
  if (!fly || !cfg) return { estate: e, outcome: "idle", note: "provisioning is not configured on this deployment" };
  if (e.lease_until && new Date(e.lease_until).getTime() > now.getTime()) {
    return { estate: e, outcome: "waiting", note: "another driver holds the step lease" };
  }
  if (e.step === "done") {
    e.status = "ready";
    await saveEstate(e, now);
    return { estate: e, outcome: "done", note: "ready" };
  }

  e.lease_until = new Date(now.getTime() + LEASE_MS).toISOString();
  await saveEstate(e, now);
  const origin = estateOrigin(e.app);
  const signer = attestSigner(e.grantor);
  const step = e.step;

  try {
    switch (step) {
      case "create_app": {
        await fly.createApp(e.app);
        nextStep(e, `app ${e.app} present in org ${cfg.org}`, now);
        break;
      }
      case "allocate_ips": {
        const have = await fly.listIps(e.app);
        const types = new Set(have.map((i) => i.type.toLowerCase()));
        const addrs = have.map((i) => i.address);
        if (![...types].some((t) => t.includes("v4"))) addrs.push(await fly.allocateIp(e.app, "shared_v4"));
        if (![...types].some((t) => t === "v6" || t.includes("v6"))) addrs.push(await fly.allocateIp(e.app, "v6"));
        e.ips = addrs.filter(Boolean);
        nextStep(e, `public IPs: ${e.ips.length}`, now);
        break;
      }
      case "create_volume": {
        if (!e.volume_id) {
          const vols = await fly.listVolumes(e.app);
          const existing = vols.find((v) => v.name === "ff_data");
          e.volume_id = existing ? existing.id : (await fly.createVolume(e.app, "ff_data", 1)).id;
        }
        nextStep(e, `volume ${e.volume_id} (ff_data, 1 GB, ${cfg.region})`, now);
        break;
      }
      case "set_base_secrets": {
        await fly.setSecrets(e.app, { FIELD_SHARED_SECRET: estateSecret(e.app) });
        nextStep(e, "FIELD_SHARED_SECRET set (derived; not stored in the portal)", now);
        break;
      }
      case "create_machine": {
        if (!e.machine_id) {
          const machines = await fly.listMachines(e.app);
          const existing = machines.find((m) => m.name === "estate");
          e.machine_id = existing ? existing.id : (await fly.createMachine(e.app, "estate", estateMachineConfig(cfg, e.volume_id!, "boot", signer))).id;
        }
        nextStep(e, `machine ${e.machine_id} launched from ${cfg.image} (observer posture for bootstrap)`, now);
        break;
      }
      case "wait_boot": {
        const [reg, led, del] = await Promise.all([
          healthJson(origin, "/registry/health", fetchImpl),
          healthJson(origin, "/ledger/health", fetchImpl),
          healthJson(origin, "/delegation/health", fetchImpl),
        ]);
        if (reg && led && del) {
          nextStep(e, `estate answering at ${origin} (build ${led.build_sha ?? "?"})`, now);
        } else {
          e.polls += 1;
          if (e.polls > MAX_POLLS) throw new EstateError(504, "boot_timeout", "the estate did not become healthy in time");
          e.lease_until = null;
          await saveEstate(e, now);
          return { estate: e, outcome: "waiting", note: `booting (poll ${e.polls})` };
        }
        break;
      }
      case "bootstrap": {
        const row = { grantor: e.grantor, ...e.roster };
        const r = await fly.exec(e.app, e.machine_id!, ["python3", "-c", BOOTSTRAP_PY, JSON.stringify(row)], 25);
        const out = lastJsonLine(r.stdout);
        if (r.exit_code !== 0 || !out || out.error) {
          throw new EstateError(502, "bootstrap_failed", `bootstrap rc=${r.exit_code}: ${(out?.error ?? r.stderr ?? r.stdout).toString().slice(-300)}`);
        }
        for (const [name, k] of Object.entries<any>(out.keys ?? {})) {
          e.public_keys[name] = String(k.pub ?? "");
          e.fingerprints[name] = String(k.fingerprint ?? "");
        }
        nextStep(e, `keys ${Object.keys(out.keys ?? {}).join(", ")}; manifests ${(out.manifests ?? []).length}; roster rows ${out.roster_rows} (customer row ${out.customer_row ? "present" : "omitted until it has scopes"})`, now);
        break;
      }
      case "provision_sentinel":
      case "provision_gateway":
      case "provision_crosswalk": {
        const agent = SELF_AGENTS.find((a) => a.step === step)!;
        const secret = estateSecret(e.app);
        const r = await fly.exec(e.app, e.machine_id!, ["sh", "-c", PROVISION_SH, secret, agent.id, SELF_OWNER], 25);
        const out = lastJsonLine(r.stdout);
        if (r.exit_code !== 0 || !out?.token_id) {
          // The exec environment carries the shared secret; never let captured output leak it.
          throw new EstateError(502, "self_agent_failed", `provision ${agent.id} rc=${r.exit_code}: ${redactSecret((r.stdout + r.stderr).slice(-300), secret)}`);
        }
        await fly.setSecrets(e.app, { [agent.secret]: String(out.token_id) });
        e.self_agents[agent.id] = { provisioned_at: now.toISOString() };
        nextStep(e, `${agent.id} registered, capped and tokened (30 d); ${agent.secret} set`, now);
        break;
      }
      case "arm": {
        await fly.updateMachine(e.app, e.machine_id!, estateMachineConfig(cfg, e.volume_id!, "armed", signer));
        e.posture = { enforce: true, tool_check: true, require_signing: true, attest_signing: true };
        nextStep(e, "machine updated to the armed posture (signing required, attest signing, gateway enforce + tool check); restarting", now);
        break;
      }
      case "wait_armed": {
        const [led, gw, at] = await Promise.all([
          healthJson(origin, "/ledger/health", fetchImpl),
          healthJson(origin, "/gateway/health", fetchImpl),
          healthJson(origin, "/attest/health", fetchImpl),
        ]);
        const armed =
          led?.signing === "on" && led?.require_signing === true && led?.appendable === true &&
          gw?.enforce === true && gw?.tool_check === true &&
          at?.signing === "on";
        if (armed) {
          const fp = String(led?.key_fingerprint ?? "");
          if (e.fingerprints["ledger-sign"] && fp && fp !== e.fingerprints["ledger-sign"]) {
            throw new EstateError(500, "fingerprint_mismatch", "the ledger reports a signing key that is not the one generated at bootstrap");
          }
          e.status = "ready";
          e.url = origin;
          e.ready_at = now.toISOString();
          nextStep(e, `armed and healthy at ${origin}`, now);
        } else {
          e.polls += 1;
          if (e.polls > MAX_POLLS) throw new EstateError(504, "arm_timeout", "the estate did not report the armed posture in time");
          e.lease_until = null;
          await saveEstate(e, now);
          return { estate: e, outcome: "waiting", note: `arming (poll ${e.polls})` };
        }
        break;
      }
    }
  } catch (err: any) {
    e.attempts += 1;
    e.polls = 0; // a fresh polling window per attempt
    e.error = redactSecret(String(err?.message ?? err), cfg ? estateSecret(e.app) : null).slice(0, 400);
    logEstate(e, step, `attempt ${e.attempts} failed: ${e.error}`, now);
    if (e.attempts >= MAX_ATTEMPTS) {
      e.status = "error";
      logEstate(e, step, "giving up; retry from the dashboard once the cause is fixed", now);
    }
    e.lease_until = null;
    await saveEstate(e, now);
    return { estate: e, outcome: "error", note: e.error };
  }

  e.lease_until = null;
  await saveEstate(e, now);
  if (e.status === "ready") return { estate: e, outcome: "done", note: "ready" };
  return { estate: e, outcome: "progressed", note: `next: ${e.step}` };
}

/** Reset a failed estate so the driver retries its current step. */
export async function retryEstate(e: Estate, now: Date = new Date()): Promise<Estate> {
  if (e.status !== "error") throw new EstateError(409, "not_failed", "Only a failed estate can be retried.");
  e.status = "provisioning";
  e.attempts = 0;
  e.polls = 0;
  e.error = null;
  logEstate(e, e.step, "retry requested", now);
  await saveEstate(e, now);
  return e;
}

/** Stop the machine; keep the volume (no data is destroyed here). */
export async function suspendEstate(e: Estate, fly: FlyClient | null, now: Date = new Date(), reason = "suspended"): Promise<Estate> {
  if (e.status === "suspended") return e;
  if (fly && e.machine_id) {
    try {
      await fly.stopMachine(e.app, e.machine_id);
      logEstate(e, "suspend", `machine ${e.machine_id} stopped: ${reason}`, now);
    } catch (err: any) {
      logEstate(e, "suspend", `stop failed (${String(err?.message ?? err).slice(0, 200)}); marked suspended anyway — gateway refuses`, now);
    }
  } else {
    logEstate(e, "suspend", `marked suspended: ${reason}` + (fly ? "" : " (provisioning not configured; no machine to stop)"), now);
  }
  e.suspended_from = e.status;
  e.status = "suspended";
  e.suspended_at = now.toISOString();
  e.lease_until = null;
  await saveEstate(e, now);
  return e;
}

/** Start the machine again and return to the status it had before suspension. */
export async function resumeEstate(e: Estate, fly: FlyClient | null, now: Date = new Date()): Promise<Estate> {
  if (e.status !== "suspended") return e;
  if (fly && e.machine_id) {
    await fly.startMachine(e.app, e.machine_id);
    logEstate(e, "resume", `machine ${e.machine_id} started`, now);
  } else {
    logEstate(e, "resume", "resumed" + (fly ? "" : " (provisioning not configured; nothing to start)"), now);
  }
  e.status = e.suspended_from ?? "ready";
  if (e.status === "suspended") e.status = "ready";
  e.suspended_from = null;
  e.suspended_at = null;
  await saveEstate(e, now);
  return e;
}

/** Place the customer's Anthropic key as an estate secret (never stored in the portal); the machine restarts. */
export async function setEstateAnthropicKey(e: Estate, fly: FlyClient, key: string, now: Date = new Date()): Promise<Estate> {
  if (e.status !== "ready") throw new EstateError(409, "estate_not_ready", "The estate must be ready before a key can be placed.");
  const k = validateAnthropicKey(key);
  await fly.setSecrets(e.app, { ANTHROPIC_API_KEY: k });
  const m = await fly.getMachine(e.app, e.machine_id!);
  if (!m?.config) throw new EstateError(502, "machine_missing", "The estate machine could not be read.");
  await fly.updateMachine(e.app, e.machine_id!, m.config);
  e.anthropic_key_set_at = now.toISOString();
  logEstate(e, "anthropic_key", "ANTHROPIC_API_KEY set on the estate; machine restarted to apply", now);
  await saveEstate(e, now);
  return e;
}

/** Rewrite the customer's DOA roster row on the estate (read per mint — no restart). */
export async function updateEstateRoster(e: Estate, fly: FlyClient, input: any, now: Date = new Date()): Promise<Estate> {
  const row = validateRoster(input);
  if (e.status === "ready") {
    const r = await fly.exec(e.app, e.machine_id!, ["python3", "-c", ROSTER_PY, JSON.stringify({ grantor: e.grantor, ...row })], 20);
    const out = lastJsonLine(r.stdout);
    if (r.exit_code !== 0 || !out || out.error) {
      throw new EstateError(502, "roster_failed", `roster rewrite rc=${r.exit_code}: ${redactSecret(String(out?.error ?? (r.stdout + r.stderr).slice(-300)), estateSecret(e.app))}`);
    }
    logEstate(
      e,
      "roster",
      out.customer_row
        ? `roster row for ${e.grantor} rewritten (${row.allowed_scope.length} scopes, ttl ${row.max_ttl_days} d); ${out.roster_rows} rows`
        : `roster row for ${e.grantor} removed: no scopes, so nothing can be minted under that grantor until scopes are added; ${out.roster_rows} rows`,
      now,
    );
  } else {
    logEstate(e, "roster", `roster row stored; applied at bootstrap (estate is ${e.status})`, now);
  }
  e.roster = row;
  await saveEstate(e, now);
  return e;
}

// --- gateway routing ---------------------------------------------------------------

export type Route =
  | { kind: "sandbox" }
  | { kind: "estate"; url: string; secret: string }
  | { kind: "refuse"; status: number; code: string; message: string };

export function resolveRoute(user: User, estate: Estate | null): Route {
  if (!estate || estate.status === "pending_manual") return { kind: "sandbox" };
  if (estate.status === "ready" && estate.url) return { kind: "estate", url: estate.url, secret: estateSecret(estate.app) };
  if (estate.status === "suspended") {
    return { kind: "refuse", status: 403, code: "estate_suspended", message: "Your dedicated estate is suspended (subscription not active). Its data is kept; reactivate billing to resume." };
  }
  if (estate.status === "error") {
    return { kind: "refuse", status: 503, code: "estate_error", message: "Your dedicated estate failed to provision; retry from the dashboard or contact Spin State Labs." };
  }
  return { kind: "refuse", status: 503, code: "estate_provisioning", message: `Your dedicated estate is being provisioned (step ${estate.step}); try again in a few minutes.` };
}

/** True while a background worker holds the estate and has written recently. */
export function workerActive(e: Estate, now: Date = new Date()): boolean {
  if (!e.worker_until) return false;
  if (new Date(e.worker_until).getTime() <= now.getTime()) return false;
  return now.getTime() - new Date(e.updated_at).getTime() < 90_000;
}

/** The record as the dashboard sees it: no lease, log capped, nothing secret (there is nothing secret on it). */
export function publicEstate(e: Estate, now: Date = new Date()): Record<string, unknown> {
  return {
    app: e.app,
    worker_active: workerActive(e, now),
    region: e.region,
    status: e.status,
    step: e.step,
    steps: STEPS,
    attempts: e.attempts,
    error: e.error,
    url: e.url,
    grantor: e.grantor,
    roster: e.roster,
    fingerprints: e.fingerprints,
    public_keys: e.public_keys,
    self_agents: Object.keys(e.self_agents),
    posture: e.posture,
    anthropic_key_set_at: e.anthropic_key_set_at,
    created_at: e.created_at,
    updated_at: e.updated_at,
    ready_at: e.ready_at,
    suspended_at: e.suspended_at,
    log: e.log.slice(-20),
  };
}
