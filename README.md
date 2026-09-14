# Force-Field Portal

Public SaaS portal for the **Force Field Protocol** governance platform by Spin State Labs
("Force-Field as a Service", v0.2.0).

The portal provides user registration/login, API key management, tiered rate limits, Stripe
billing for the paid tiers, automatic provisioning of one dedicated engine estate per paying
account on Fly.io, and an authenticated API gateway that proxies `/api/v1/*` to the caller's
estate (a Force Field Protocol engine: thirteen FastAPI services behind one reverse-proxy origin
with path prefixes such as `/registry`, `/ledger`, `/delegation`, `/sentinel`, `/killswitch`,
`/governor`, `/replay`, `/gateway`, `/federation`, `/lifecycle`, `/attest`, `/crosswalk`).

Every capability is **configuration-gated and reports itself honestly**: `/api/health` exposes
`estate_attached`, `billing_configured` and `provisioning_configured`; an endpoint whose
configuration is absent answers `501` with a named error code, and the landing page renders its
pricing note from those flags (see "Honest state of this deployment" below).

## Tiers

| Tier | Requests/min | Requests/day | Price (USD/mo) | Estate |
| --- | --- | --- | --- | --- |
| Sandbox | 10 | 200 | 0 | shared sandbox estate (may be wiped) |
| Operator | 60 | 5,000 | 49 | dedicated estate on Fly.io |
| Sovereign | 300 | 50,000 | 249 | dedicated estate on Fly.io |

The prices in `src/lib/tiers.ts` are display copy; what is actually billed is the Stripe Price
referenced by `STRIPE_PRICE_OPERATOR` / `STRIPE_PRICE_SOVEREIGN`. Only the Stripe webhook writes
a paid tier: a subscription in a granting status (`active`, `trialing`, `past_due`) with a known
price sets the tier; anything else drops the account to Sandbox.

## Local development

```sh
npm install
netlify dev
```

- `npm test` runs the vitest suite (unit tests; Stripe and Fly are mocked at the fetch level).
- `FF_LIVE_FLY=1 npx vitest run tests/live/provision.live.test.ts` runs the LIVE provisioning
  rehearsal: it creates a real `ff-est-*` app in the Fly org, drives the whole state machine
  against the real estate image, verifies the armed posture off-box, and destroys the app
  (`FF_LIVE_KEEP=1` keeps it). It needs `FLY_API_TOKEN` (or a `fly auth login` on the machine)
  and costs a few cents. It is skipped otherwise.
- Requires Node >= 20 and the Netlify CLI (`npm i -g netlify-cli`).
- Set `SESSION_SECRET` in your environment (or a `.env` used by `netlify dev`) before
  exercising auth locally.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `SESSION_SECRET` | Yes | HMAC secret for HS256 session JWTs. Auth endpoints fail without it. |
| `ESTATE_URL` | No | Origin of the shared sandbox estate. Unset = the gateway returns `503 estate_not_attached` for sandbox accounts. |
| `ESTATE_SHARED_SECRET` | No | Sent to the sandbox estate as `x-field-auth` on proxied requests, when set. |
| `STRIPE_SECRET_KEY` | For billing | Stripe secret key. Billing is configured only when all four `STRIPE_*` variables are set. |
| `STRIPE_WEBHOOK_SECRET` | For billing | Signing secret of the `/api/billing/webhook` endpoint (`whsec_…`). |
| `STRIPE_PRICE_OPERATOR` | For billing | Stripe Price id billed for Operator. |
| `STRIPE_PRICE_SOVEREIGN` | For billing | Stripe Price id billed for Sovereign. |
| `FLY_API_TOKEN` | For provisioning | Org-scoped Fly token (apps, volumes, machines, IPs, secrets). Provisioning is configured only when this, `FLY_ORG_SLUG`, `FLY_ESTATE_IMAGE` and `ESTATE_SECRET_MASTER` are all set. |
| `FLY_ORG_SLUG` | For provisioning | The Fly organization that owns customer estates. |
| `FLY_ESTATE_IMAGE` | For provisioning | The estate image to launch, e.g. `registry.fly.io/force-field-sandbox:<label>` — a label that was smoked and deployed on the sandbox first. |
| `ESTATE_SECRET_MASTER` | For provisioning | HMAC master; each estate's `FIELD_SHARED_SECRET` is derived from it and the app name, so no per-estate secret is stored. Changing it orphans existing estates. |
| `FLY_REGION` | No | Region for new estates (default `yyz`). |
| `FLY_ESTATE_MEMORY_MB` | No | Machine memory (default 2048; the thirteen services need it). |
| `URL` | Set by Netlify | Used for the Stripe success/cancel/return URLs; falls back to the request origin. |

## Deploy (Netlify)

- Static frontend publishes from `public/`; functions live in `netlify/functions/`
  (Functions v2, `.mts`), per `netlify.toml`. `estate-tick.mts` is a scheduled function
  (`*/2 * * * *`) that advances any provisioning estate; scheduled functions run only on the
  published production deploy.
- Persistence is Netlify Blobs: the site-wide `portal` store in the production deploy
  context, a deploy-scoped store on previews/branch deploys (preview data never touches
  production data).
- Set `SESSION_SECRET` in the Netlify environment before the first deploy. Add
  `ESTATE_URL` (and `ESTATE_SHARED_SECRET`) when a sandbox estate is ready to attach, the
  `STRIPE_*` variables to sell the paid tiers, and the `FLY_*` + `ESTATE_SECRET_MASTER`
  variables to provision estates automatically. Each group lights up on its own.

## Architecture

```
Browser ── static pages (public/, Netlify CDN)
   │
   ├─ cookie session ──> Netlify Functions: /api/auth/*  /api/me  /api/keys  /api/health
   │                      /api/billing/{checkout,portal}   /api/estate/{advance,retry,anthropic-key,roster}
   │                                        │
   │                                        └── Netlify Blobs "portal" store
   │                                            (users/, uid/, keys/, rate/, estates/, stripe_events/, stripe_customers/)
   │
   ├─ Stripe ── signed webhook ──> /api/billing/webhook  (the only writer of paid tiers)
   │
   ├─ schedule */2 ──> estate-tick ──kick──> estate-worker (BACKGROUND fn, ≤15 min: drives one
   │                                          estate's steps; Fly Machines + GraphQL APIs)
   │
   └─ x-api-key ───────> Netlify Function: /api/v1/*  (gateway)
                                            │  auth + rate limit, then route:
                                            ├─ ready dedicated estate ─> https://ff-est-<hex>.fly.dev (derived secret)
                                            └─ sandbox account ────────> ESTATE_URL (ESTATE_SHARED_SECRET)
                          Engine estate: single origin, path-prefixed services, guarded by x-field-auth
```

The gateway forwards method, body, `content-type`, and `accept`; adds `x-field-auth` (the
estate's secret) and `x-ff-tenant` (the caller's user id); and never forwards client cookies
or `Authorization` headers. A provisioning estate answers `503 estate_provisioning`, a
suspended one `403 estate_suspended`, a failed one `503 estate_error` — never a silent fall
back to the sandbox, which would mix a tenant's data.

## Billing (Stripe)

- `POST /api/billing/checkout {tier}` creates a Stripe Checkout Session (subscription mode,
  the tier's Price, `client_reference_id` = user id, metadata on the session and the
  subscription) and returns its URL. An account with a granting subscription gets
  `409 already_subscribed` (plan changes go through the portal).
- `POST /api/billing/portal` returns a Customer Portal session URL (plan switch, payment
  method, cancel).
- `POST /api/billing/webhook` verifies `Stripe-Signature` by hand (HMAC-SHA256 of
  `<t>.<raw body>`, `v1` schemes only, 300 s tolerance, constant-time compare) BEFORE reading
  the event; rejects with `400 bad_signature`. Handles `checkout.session.completed` (fetches
  the subscription) and `customer.subscription.{created,updated,deleted}`; every other type is
  acknowledged and ignored. Event ids are recorded after successful handling so redeliveries
  are no-ops; a handling failure answers `500` so Stripe retries.
- Stored per user: Stripe customer id, subscription id, status, price id, period end. Never
  card data.
- Unconfigured: every billing endpoint answers `501 billing_not_configured`.

## Dedicated estates (Fly.io)

One Fly app per paying account, `ff-est-<8 hex>` (a hash of the user id), built by a
resumable state machine (`src/lib/estates.ts`) whose steps are idempotent and short. The slow
work runs in a **background function** (`/api/estate/worker`, up to 15 minutes; synchronous
functions are limited to seconds): the dashboard kicks it and polls the record, the scheduled
tick re-kicks any estate whose worker died, and a retry kicks it again:

1. `create_app` → 2. `allocate_ips` (shared v4 + v6) → 3. `create_volume` (`ff_data`, 1 GB)
→ 4. `set_base_secrets` (`FIELD_SHARED_SECRET`, derived) → 5. `create_machine` (the estate
image, observer posture) → 6. `wait_boot` (public `/registry|/ledger|/delegation` health)
→ 7. `bootstrap` (in-machine: Ed25519 `ledger-anchor`, `ledger-sign`, `attest-sign` keys;
the three platform self-manifests into `/data/manifests`; the DOA roster with the platform
row and the customer's grantor row) → 8–10. `provision_{sentinel,gateway,crosswalk}`
(`lifecycle provision` in-machine; the token id goes straight into a Fly secret) → 11. `arm`
(machine update to the armed posture: `FIELD_LEDGER_SIGN_KEY` + `FIELD_LEDGER_REQUIRE_SIGNING=1`,
`FIELD_ATTEST_SIGNER` + `FIELD_ATTEST_SIGN_KEY`, `FORCE_GATEWAY_ENFORCE=1`,
`FORCE_GATEWAY_TOOL_CHECK=1`) → 12. `wait_armed` (ledger `signing: on`, `require_signing`,
`appendable`; gateway `enforce` + `tool_check`; attest `signing: on`; the ledger's key
fingerprint must equal the one generated at bootstrap) → `ready`.

- The customer brings their own Anthropic key (`POST /api/estate/anthropic-key`): it is set as
  a Fly secret on their estate and the machine restarts; the portal stores only the time.
- The customer's DOA roster row (`PUT /api/estate/roster`): allowed scopes, longest token,
  optional spend ceiling; grantor = the account email; rewritten in-machine, read per mint.
- Public keys and fingerprints are kept on the estate record and shown on the dashboard, so
  the customer can verify their ledger and attestation packs off-box.
- A subscription that stops granting suspends the estate: the machine is stopped, the volume
  is kept. Reactivation starts it again. Destroying an estate is a manual operator action.
- Unconfigured: estate mutations answer `501 provisioning_not_configured`; a paid account is
  recorded as `pending_manual` (provisioned by hand) and its keys keep reaching the sandbox.

## Honest state of this deployment

Enforced-vs-Declared: this section states what the code actually does and what has been
verified, not what a mature SaaS would do.

- **Billing and provisioning are configuration-gated.** With no `STRIPE_*` / `FLY_*` variables
  the portal sells nothing and provisions nothing, and says so (`501` codes, `/api/health`
  flags, the landing note).
- **Verification status (2026-09-14).** Stripe and Fly paths are covered by 75 unit tests with
  the HTTP layer mocked (request shapes, signature scheme, state transitions, idempotency,
  routing). The live provisioning rehearsal (`tests/live/`) exists but **has not yet been run
  against Fly** from this repo, and no live Stripe checkout has been performed. Until an operator
  runs both, treat "provisions automatically" as Declared, not Enforced.
- **Rate limiting is approximate.** Counters use read-increment-write blob storage with
  last-write-wins semantics, so concurrent requests can under-count. Limits are Declared,
  not Enforced hard caps.
- **Provisioning concurrency is best-effort**: a worker lease and a 25 s per-step lease on the
  blob (no compare-and-swap), a deterministic app name per user (racing writers agree on one
  app), and every step checks Fly for what already exists before creating anything.
- **Self-agent tokens expire after 30 days.** The three platform identities minted in each
  estate are renewed automatically by the scheduled tick after 25 days (one machine restart);
  if the tick is not running (previews, a paused site) they lapse and the gateway's own calls
  are refused until the next tick.
- **No email verification.** Any address matching a basic format check can register.
- **Sessions are not server-revocable.** Session JWTs are stateless; logout clears the
  cookie but an already-issued token remains valid until its 7-day expiry.
- **The sandbox estate is shared and may be wiped.** Do not store anything you need to
  keep in the sandbox estate.
- **No streaming through the gateway.** Upstream responses are buffered; requests time
  out at 30 seconds.
- **One container per estate.** As on the public sandbox, every process in a customer estate
  can read every key on its volume; per-service caller signatures (F2b) are not deployed there.
