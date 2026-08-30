// Force-Field Portal — dashboard client (vanilla ES module).
// All user-derived strings are rendered via textContent / createElement —
// never innerHTML with data.

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// fetch helpers
// ---------------------------------------------------------------------------

async function api(path, opts = {}) {
  const init = {
    method: opts.method || "GET",
    credentials: "same-origin",
    headers: {},
  };
  if (opts.body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    return { status: 0, ok: false, data: null };
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    // 204 or non-JSON body — leave data null.
  }
  return { status: res.status, ok: res.ok, data };
}

// Prefer the server's honest { error: { code, message } } body; fall back to
// a plain HTTP description. 501 (billing not configured) and 503 (estate not
// attached) carry their own honest messages from the backend.
function errMessage(status, data) {
  if (data && data.error && typeof data.error.message === "string" && data.error.message) {
    return data.error.message;
  }
  if (status === 0) return "Network error — the portal could not be reached.";
  if (status === 503) return "Service unavailable (503).";
  if (status === 501) return "Not implemented yet (501).";
  return "Request failed (HTTP " + status + ").";
}

function show(el) { el.classList.remove("hidden"); }
function hide(el) { el.classList.add("hidden"); }

function setError(el, msg) {
  if (msg) {
    el.textContent = msg;
    show(el);
  } else {
    el.textContent = "";
    hide(el);
  }
}

// ---------------------------------------------------------------------------
// state machine: unauthed <-> dashboard
// ---------------------------------------------------------------------------

let authMode = "login";
let healthChecked = false; // health is polled once per page load

async function boot() {
  const me = await api("/api/me");
  hide($("boot-note"));
  if (me.status === 200 && me.data) {
    enterDashboard(me.data);
  } else {
    showAuthView();
  }
}

function showAuthView() {
  hide($("boot-note"));
  hide($("dash-view"));
  show($("auth-view"));
  $("keys-body").replaceChildren();
  $("auth-email").focus();
}

function enterDashboard(me) {
  hide($("boot-note"));
  hide($("auth-view"));
  show($("dash-view"));

  $("acct-email").textContent = me.email || "";
  const tierChip = $("acct-tier");
  tierChip.className = "chip chip-ok";
  tierChip.textContent = me.tier || "";

  const lim = me.limits || {};
  const rpm = typeof lim.rpm === "number" ? lim.rpm : "?";
  const rpd = typeof lim.rpd === "number" ? lim.rpd : "?";
  $("acct-limits").textContent = rpm + " req/min · " + rpd + " req/day";

  renderQuickstart();
  refreshKeys();
  if (!healthChecked) {
    healthChecked = true;
    checkHealth();
  }
}

// ---------------------------------------------------------------------------
// auth: register / login / logout
// ---------------------------------------------------------------------------

function setAuthMode(mode) {
  authMode = mode;
  const login = $("tab-login");
  const reg = $("tab-register");
  login.classList.toggle("active", mode === "login");
  reg.classList.toggle("active", mode === "register");
  login.setAttribute("aria-selected", String(mode === "login"));
  reg.setAttribute("aria-selected", String(mode === "register"));
  $("auth-submit").textContent = mode === "login" ? "Log in" : "Create account";
  $("auth-password").setAttribute(
    "autocomplete",
    mode === "login" ? "current-password" : "new-password"
  );
  setError($("auth-error"), "");
}

async function submitAuth(ev) {
  ev.preventDefault();
  const email = $("auth-email").value.trim();
  const password = $("auth-password").value;
  const btn = $("auth-submit");
  btn.disabled = true;
  const path = authMode === "login" ? "/api/auth/login" : "/api/auth/register";
  const res = await api(path, { method: "POST", body: { email, password } });
  btn.disabled = false;
  if (res.status === 200 || res.status === 201) {
    $("auth-password").value = "";
    setError($("auth-error"), "");
    const me = await api("/api/me");
    if (me.status === 200 && me.data) {
      enterDashboard(me.data);
    } else {
      setError($("auth-error"), errMessage(me.status, me.data));
    }
  } else {
    setError($("auth-error"), errMessage(res.status, res.data));
  }
}

async function logout() {
  await api("/api/auth/logout", { method: "POST" });
  showAuthView();
}

// ---------------------------------------------------------------------------
// API keys: list / create / revoke
// ---------------------------------------------------------------------------

async function refreshKeys() {
  const res = await api("/api/keys");
  if (res.status === 401) {
    showAuthView();
    return;
  }
  if (res.status !== 200 || !res.data) {
    setError($("keys-error"), errMessage(res.status, res.data));
    return;
  }
  setError($("keys-error"), "");
  renderKeys(Array.isArray(res.data.keys) ? res.data.keys : []);
}

function renderKeys(keys) {
  const body = $("keys-body");
  body.replaceChildren();

  if (keys.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 5;
    td.className = "empty-cell";
    td.textContent = "No keys yet — create one below.";
    tr.appendChild(td);
    body.appendChild(tr);
    return;
  }

  for (const k of keys) {
    const tr = document.createElement("tr");

    const tdLabel = document.createElement("td");
    tdLabel.textContent = String(k.label ?? "");
    tr.appendChild(tdLabel);

    const tdPrefix = document.createElement("td");
    const code = document.createElement("code");
    code.textContent = String(k.prefix ?? "") + "…";
    tdPrefix.appendChild(code);
    tr.appendChild(tdPrefix);

    const tdCreated = document.createElement("td");
    tdCreated.textContent = String(k.created_at ?? "").slice(0, 10);
    tr.appendChild(tdCreated);

    const tdStatus = document.createElement("td");
    const chip = document.createElement("span");
    chip.className = "chip " + (k.revoked ? "chip-err" : "chip-ok");
    chip.textContent = k.revoked ? "revoked" : "active";
    tdStatus.appendChild(chip);
    tr.appendChild(tdStatus);

    const tdAction = document.createElement("td");
    if (!k.revoked) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn btn-danger btn-small";
      btn.textContent = "Revoke";
      btn.addEventListener("click", () => revokeKey(String(k.id ?? ""), btn));
      tdAction.appendChild(btn);
    }
    tr.appendChild(tdAction);

    body.appendChild(tr);
  }
}

async function createKey(ev) {
  ev.preventDefault();
  const input = $("new-key-label");
  const label = input.value.trim();
  if (!label) {
    setError($("keys-error"), "Enter a label for the new key.");
    input.focus();
    return;
  }
  const btn = $("new-key-btn");
  btn.disabled = true;
  const res = await api("/api/keys", { method: "POST", body: { label } });
  btn.disabled = false;
  if (res.status === 201 && res.data && typeof res.data.key === "string") {
    input.value = "";
    setError($("keys-error"), "");
    openKeyModal(res.data.key);
    refreshKeys();
  } else if (res.status === 401) {
    showAuthView();
  } else {
    setError($("keys-error"), errMessage(res.status, res.data));
  }
}

async function revokeKey(hash, btn) {
  if (!window.confirm("Revoke this key? Requests using it will be rejected.")) return;
  btn.disabled = true;
  const res = await api("/api/keys/" + encodeURIComponent(hash), { method: "DELETE" });
  if (res.status === 200) {
    refreshKeys();
  } else if (res.status === 401) {
    showAuthView();
  } else {
    btn.disabled = false;
    setError($("keys-error"), errMessage(res.status, res.data));
  }
}

// ---------------------------------------------------------------------------
// one-time key modal — the plaintext exists only here, never in a list
// ---------------------------------------------------------------------------

function openKeyModal(plaintext) {
  $("key-modal-value").textContent = plaintext;
  const copyBtn = $("key-copy-btn");
  copyBtn.textContent = "Copy key";
  copyBtn.disabled = false;
  show($("key-modal"));
  $("key-copy-btn").focus();
}

// Only the Done button closes the modal — no backdrop/Escape close, so the
// once-only key cannot be dismissed by accident.
function closeKeyModal() {
  $("key-modal-value").textContent = "";
  hide($("key-modal"));
}

async function copyKey() {
  const value = $("key-modal-value").textContent;
  const btn = $("key-copy-btn");
  try {
    await navigator.clipboard.writeText(value);
    btn.textContent = "Copied";
  } catch {
    btn.textContent = "Copy failed — select the key text manually";
  }
}

// ---------------------------------------------------------------------------
// health — polled once; drives the estate status chip
// ---------------------------------------------------------------------------

async function checkHealth() {
  const chip = $("estate-chip");
  const res = await api("/api/health");
  if (res.status === 200 && res.data && res.data.ok === true) {
    if (res.data.estate_attached) {
      chip.className = "chip chip-ok";
      chip.textContent = "estate attached";
    } else {
      chip.className = "chip chip-warn";
      chip.textContent = "sandbox estate not attached yet";
    }
  } else {
    chip.className = "chip chip-err";
    chip.textContent = "health check unavailable";
  }
}

// ---------------------------------------------------------------------------
// quickstart
// ---------------------------------------------------------------------------

function renderQuickstart() {
  const origin = window.location.origin;
  $("quickstart-code").textContent = [
    "curl -X POST " + origin + "/api/v1/sentinel/check \\",
    '  -H "x-api-key: ff_live_YOUR_KEY" \\',
    '  -H "content-type: application/json" \\',
    "  -d '{\"agent_id\": \"my-agent\", \"action\": \"example.action\"}'",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------

$("tab-login").addEventListener("click", () => setAuthMode("login"));
$("tab-register").addEventListener("click", () => setAuthMode("register"));
$("auth-form").addEventListener("submit", submitAuth);
$("logout-btn").addEventListener("click", logout);
$("new-key-form").addEventListener("submit", createKey);
$("key-copy-btn").addEventListener("click", copyKey);
$("key-modal-close").addEventListener("click", closeKeyModal);

boot();
