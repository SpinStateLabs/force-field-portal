// billing.mts — Force-Field Portal v0.1.0
// v0 STUBS. Payments are intentionally NOT implemented — no half-wired Stripe.
// Both endpoints answer 501 with an honest message until billing ships.
import type { Context, Config } from "@netlify/functions";

function err(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export default async (req: Request, _context: Context): Promise<Response> => {
  if (req.method !== "POST") {
    return err(405, "method_not_allowed", "Use POST for this endpoint.");
  }

  // Honest stub: no checkout session is created and no webhook is processed.
  return err(
    501,
    "billing_not_configured",
    "Payments are not wired yet; Stripe integration is documented in the README.",
  );
};

export const config: Config = {
  path: ["/api/billing/checkout", "/api/billing/webhook"],
};
