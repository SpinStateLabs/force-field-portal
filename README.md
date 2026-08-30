# Force-Field Portal

Public SaaS portal for the **Force Field Protocol** governance platform by Spin State Labs
("Force-Field as a Service", v0.1.0).

The portal provides user registration/login, API key management, tiered rate limits, and an
authenticated API gateway that proxies `/api/v1/*` to a Force Field Protocol engine estate
(10 FastAPI services behind one reverse-proxy origin with path prefixes such as `/registry`,
`/ledger`, `/delegation`, `/sentinel`, `/killswitch`, `/governor`, `/replay`, `/gateway`,
`/federation`).

The engine estate is **not yet publicly hosted**. Until `ESTATE_URL` is configured, the
gateway answers `503 estate_not_attached` with an honest message rather than pretending to
serve engine responses.

## Tiers

| Tier | Requests/min | Requests/day | Price (USD/mo) |
| --- | --- | --- | --- |
| Sandbox | 10 | 200 | 0 |
| Operator | 60 | 5,000 | 49 |
| Sovereign | 300 | 50,000 | 249 |

Prices are **launch placeholders subject to change**. Nothing is billed in v0 — the billing
endpoints return `501 billing_not_configured` (see "Stripe wiring plan" below). Sandbox uses
a shared sandbox estate; Operator and Sovereign estates are provisioned manually in v0.

## Local development

```sh
npm install
netlify dev
```

- `npm test` runs the vitest suite.
- Requires Node >= 20 and the Netlify CLI (`npm i -g netlify-cli`).
- Set `SESSION_SECRET` in your environment (or a `.env` used by `netlify dev`) before
  exercising auth locally.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `SESSION_SECRET` | Yes | HMAC secret for HS256 session JWTs. Auth endpoints fail without it. |
| `ESTATE_URL` | No | Origin of the engine estate reverse proxy. Unset = gateway returns `503 estate_not_attached`. |
| `ESTATE_SHARED_SECRET` | No | Sent to the estate as `x-field-auth` on proxied requests, when set. |
| `STRIPE_*` | No | Reserved for the documented billing plan. Not read by any code in v0. |

## Deploy (Netlify)

- Static frontend publishes from `public/`; functions live in `netlify/functions/`
  (Functions v2, `.mts`), per `netlify.toml`.
- Persistence is Netlify Blobs: the site-wide `portal` store in the production deploy
  context, a deploy-scoped store on previews/branch deploys (preview data never touches
  production data).
- Set `SESSION_SECRET` in the Netlify environment before the first deploy. Add
  `ESTATE_URL` (and `ESTATE_SHARED_SECRET`) when an estate is ready to attach.

## Architecture

```
Browser ── static pages (public/, Netlify CDN)
   │
   ├─ cookie session ──> Netlify Functions: /api/auth/*  /api/me  /api/keys  /api/billing/*  /api/health
   │                                        │
   │                                        └── Netlify Blobs "portal" store
   │                                            (users/, uid/, keys/, rate/)
   │
   └─ x-api-key ───────> Netlify Function: /api/v1/*  (gateway)
                                            │  auth + rate limit, then proxy
                                            ▼
                          Engine estate: single origin, path-prefixed services
                          (/registry /ledger /delegation /sentinel /killswitch
                           /governor /replay /gateway /federation)
                          guarded by x-field-auth shared secret
```

The gateway forwards method, body, `content-type`, and `accept`; adds `x-field-auth`
(when configured) and `x-ff-tenant` (the caller's user id); and never forwards client
cookies or `Authorization` headers.

## Limits (honest, v0)

Enforced-vs-Declared: this section states what the portal actually does, not what a
mature SaaS would do.

- **Rate limiting is approximate.** Counters use read-increment-write blob storage with
  last-write-wins semantics, so concurrent requests can under-count. Limits are Declared,
  not Enforced hard caps.
- **No email verification.** Any address matching a basic format check can register.
- **Sessions are not server-revocable.** Session JWTs are stateless; logout clears the
  cookie but an already-issued token remains valid until its 7-day expiry.
- **Billing is stubbed.** `/api/billing/*` returns `501 billing_not_configured`. No
  payment is collected; tier upgrades are manual.
- **Estate provisioning is manual.** Operator/Sovereign dedicated estates are set up by
  hand in v0; there is no automated provisioning.
- **The sandbox estate is shared and may be wiped.** Do not store anything you need to
  keep in the sandbox estate.
- **No streaming through the gateway.** Upstream responses are buffered; requests time
  out at 30 seconds.

## Stripe wiring plan — NOT IMPLEMENTED

Documented here so the stub endpoints have a concrete successor; none of this exists in
v0 and no Stripe code ships in this repo.

1. Create Stripe Products/Prices for Operator and Sovereign; reference them by price id
   from `POST /api/billing/checkout`, which would create a Stripe Checkout Session and
   return its URL.
2. `POST /api/billing/webhook` would handle `checkout.session.completed` by upgrading
   the paying user's tier in the portal store.
3. Webhook signature verification (`Stripe-Signature` with the endpoint's signing
   secret) is **required** before any webhook handling logic runs.

Until the above is implemented and tested, both endpoints intentionally return
`501 billing_not_configured`.
