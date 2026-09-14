// health.mts — Force-Field Portal v0.2.0
// Liveness probe plus the deployment's capability flags. Each flag reports
// whether the variables for that capability are SET — it does not probe
// Stripe, Fly or the engine (Declared, not Enforced). The landing page renders
// its honest note from these flags, so the copy can never claim more than the
// deployment is configured for.
import type { Context, Config } from "@netlify/functions";
import { env } from "../../src/lib/store";
import { stripeConfig } from "../../src/lib/stripe";
import { flyConfig } from "../../src/lib/fly";

export const PORTAL_VERSION = "0.2.1";

export default async (req: Request, _context: Context): Promise<Response> => {
  if (req.method !== "GET") {
    return new Response(
      JSON.stringify({ error: { code: "method_not_allowed", message: "Use GET for this endpoint." } }),
      { status: 405, headers: { "content-type": "application/json" } },
    );
  }

  return new Response(
    JSON.stringify({
      ok: true,
      estate_attached: Boolean(env("ESTATE_URL")),
      billing_configured: stripeConfig() !== null,
      provisioning_configured: flyConfig() !== null,
      version: PORTAL_VERSION,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
};

export const config: Config = {
  path: "/api/health",
};
