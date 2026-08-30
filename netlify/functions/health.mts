// health.mts — Force-Field Portal v0.1.0
// Liveness probe. estate_attached reports whether ESTATE_URL is configured —
// it does NOT probe the engine itself (Declared, not Enforced).
import type { Context, Config } from "@netlify/functions";
import { env } from "../../src/lib/store";

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
      version: "0.1.0",
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
};

export const config: Config = {
  path: "/api/health",
};
