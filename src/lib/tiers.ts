// Force-Field Portal — tier definitions.
//
// price_usd_month values are LAUNCH PLACEHOLDERS subject to change; they are
// not billed anywhere in v0 (billing endpoints return 501 until Stripe is
// wired per the README plan).
//
// rpm/rpd are Declared limits enforced approximately by src/lib/ratelimit.ts
// (see the concurrency note there).

export const TIERS = {
  sandbox:   { label: "Sandbox",   rpm: 10,  rpd: 200,   price_usd_month: 0 },
  operator:  { label: "Operator",  rpm: 60,  rpd: 5000,  price_usd_month: 49 },
  sovereign: { label: "Sovereign", rpm: 300, rpd: 50000, price_usd_month: 249 },
} as const;
