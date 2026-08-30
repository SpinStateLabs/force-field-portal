// me.mts — Force-Field Portal v0.1.0
// Returns the authenticated user's profile and Declared tier limits.
import type { Context, Config } from "@netlify/functions";
import { readSession } from "../../src/lib/session";
import { getUserById } from "../../src/lib/users";
import { TIERS } from "../../src/lib/tiers";

function err(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export default async (req: Request, _context: Context): Promise<Response> => {
  if (req.method !== "GET") {
    return err(405, "method_not_allowed", "Use GET for this endpoint.");
  }

  const userId = await readSession(req);
  const user = userId ? await getUserById(userId) : null;
  if (!user) {
    return err(401, "unauthenticated", "Sign in to access this endpoint.");
  }

  const tier = TIERS[user.tier];
  return new Response(
    JSON.stringify({
      email: user.email,
      tier: user.tier,
      created_at: user.created_at,
      limits: { rpm: tier.rpm, rpd: tier.rpd },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
};

export const config: Config = {
  path: "/api/me",
};
