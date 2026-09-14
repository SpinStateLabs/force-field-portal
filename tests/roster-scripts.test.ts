// The in-machine roster script (ROSTER_PY) is Python that runs inside a
// customer estate through the Machines exec API. This test runs it for real
// under the local Python, against a temporary roster file (FIELD_DOA_ROSTER)
// and a STUB of the estate's validator (delegation_authority.doa.load_roster)
// that applies the same rules as the real GrantorRow model: a 'grantors'
// list, no extra fields, at least one scope, a positive TTL, an 'active'
// flag. Skipped when no Python with PyYAML is available on this machine
// (the Netlify build does not run tests).
import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROSTER_PY } from "../src/lib/estates";

const STUB_DOA = [
  "import yaml",
  "class DoaRosterError(Exception): pass",
  "def load_roster(path):",
  "    doc = yaml.safe_load(open(path))",
  "    if not isinstance(doc, dict) or not isinstance(doc.get('grantors'), list):",
  "        raise DoaRosterError('roster must be a mapping with a grantors list')",
  "    for r in doc['grantors']:",
  "        extra = set(r) - {'grantor', 'allowed_scope', 'max_ttl_days', 'max_spend_usd', 'active'}",
  "        if extra: raise DoaRosterError('extra fields: %s' % sorted(extra))",
  "        if not r.get('grantor'): raise DoaRosterError('grantor required')",
  "        if not isinstance(r.get('allowed_scope'), list) or len(r['allowed_scope']) < 1:",
  "            raise DoaRosterError('allowed_scope: List should have at least 1 item')",
  "        if not all(isinstance(s, str) for s in r['allowed_scope']): raise DoaRosterError('allowed_scope: items must be strings')",
  "        if not isinstance(r.get('max_ttl_days'), int) or r['max_ttl_days'] <= 0: raise DoaRosterError('max_ttl_days')",
  "        if r.get('max_spend_usd') is not None and (not isinstance(r['max_spend_usd'], (int, float)) or r['max_spend_usd'] < 0):",
  "            raise DoaRosterError('max_spend_usd: must be >= 0')",
  "        if 'active' not in r or not isinstance(r['active'], bool): raise DoaRosterError('active required')",
  "    return doc",
  "",
].join("\n");

function findPython(): string | null {
  for (const exe of ["python3", "python"]) {
    const r = spawnSync(exe, ["-c", "import yaml; print('ok')"], { encoding: "utf8", timeout: 20000 });
    if (r.status === 0 && r.stdout.includes("ok")) return exe;
  }
  return null;
}

const PY = findPython();

describe.skipIf(!PY)("ROSTER_PY (run under the local Python with a stub of the estate validator)", () => {
  let dir: string;
  let roster: string;
  let pythonPath: string;

  function run(row: Record<string, unknown>) {
    const r = spawnSync(PY!, ["-c", ROSTER_PY, JSON.stringify(row)], {
      encoding: "utf8",
      timeout: 30000,
      env: { ...process.env, FIELD_DOA_ROSTER: roster, PYTHONPATH: pythonPath, PYTHONIOENCODING: "utf-8" },
    });
    const last = r.stdout.trim().split(/\r?\n/).pop() || "";
    return { status: r.status, out: last.startsWith("{") ? JSON.parse(last) : null, stderr: r.stderr };
  }

  function readRoster(): any {
    // Minimal YAML reader for the flat roster this script writes (PyYAML block style).
    const py = spawnSync(PY!, ["-c", "import sys, yaml, json; print(json.dumps(yaml.safe_load(open(sys.argv[1]))))", roster], { encoding: "utf8", timeout: 20000 });
    return JSON.parse(py.stdout.trim());
  }

  beforeAll(() => {
    dir = mkdtempSync(join(process.env.TMP || tmpdir(), "ff-roster-"));
    roster = join(dir, "doa-roster.yaml");
    pythonPath = join(dir, "stub");
    mkdirSync(join(pythonPath, "delegation_authority"), { recursive: true });
    writeFileSync(join(pythonPath, "delegation_authority", "__init__.py"), "");
    writeFileSync(join(pythonPath, "delegation_authority", "doa.py"), STUB_DOA);
    // The platform row bootstrap would have written.
    writeFileSync(roster, "grantors:\n- grantor: Founder & CTO, Spin State Labs\n  allowed_scope:\n  - platform.probe\n  max_ttl_days: 30\n  active: true\n");
  });

  it("omits the customer's row while it has no scopes, keeping the roster valid", () => {
    const r = run({ grantor: "owner@example.com", allowed_scope: [], max_ttl_days: 30, max_spend_usd: null });
    expect(r.status, r.stderr).toBe(0);
    expect(r.out).toEqual({ roster_rows: 1, customer_row: false });
    const doc = readRoster();
    expect(doc.grantors.map((g: any) => g.grantor)).toEqual(["Founder & CTO, Spin State Labs"]);
  });

  it("writes the customer's row once it has scopes and replaces it on the next write", () => {
    const a = run({ grantor: "owner@example.com", allowed_scope: ["read timesheets", "draft invoice"], max_ttl_days: 7, max_spend_usd: 25 });
    expect(a.status, a.stderr).toBe(0);
    expect(a.out).toEqual({ roster_rows: 2, customer_row: true });
    let doc = readRoster();
    expect(doc.grantors[1]).toEqual({ grantor: "owner@example.com", allowed_scope: ["read timesheets", "draft invoice"], max_ttl_days: 7, active: true, max_spend_usd: 25 });

    const b = run({ grantor: "owner@example.com", allowed_scope: ["read timesheets"], max_ttl_days: 3, max_spend_usd: null });
    expect(b.status, b.stderr).toBe(0);
    expect(b.out).toEqual({ roster_rows: 2, customer_row: true });
    doc = readRoster();
    expect(doc.grantors).toHaveLength(2);
    expect(doc.grantors[0].grantor).toBe("Founder & CTO, Spin State Labs");
    expect(doc.grantors[1]).toEqual({ grantor: "owner@example.com", allowed_scope: ["read timesheets"], max_ttl_days: 3, active: true });

    // Clearing the scopes removes the row again (the platform row stays).
    const c = run({ grantor: "owner@example.com", allowed_scope: [], max_ttl_days: 30, max_spend_usd: null });
    expect(c.out).toEqual({ roster_rows: 1, customer_row: false });
    expect(readRoster().grantors).toHaveLength(1);
  });

  it("leaves the live roster untouched and exits 1 when the estate validator rejects the new file", () => {
    const before = readFileSync(roster, "utf8");
    // A TTL of 0 passes the script's own int() but fails the validator (gt=0).
    const r = run({ grantor: "owner@example.com", allowed_scope: ["x"], max_ttl_days: 0, max_spend_usd: null });
    expect(r.status).toBe(1);
    expect(r.out?.error).toMatch(/rejected by the estate's validator/);
    expect(readFileSync(roster, "utf8")).toBe(before);
    expect(existsSync(join(dir, ".doa-roster.tmp"))).toBe(false);
  });
});
