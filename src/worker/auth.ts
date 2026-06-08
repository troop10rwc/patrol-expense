import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { verifyAccessJwt } from "@troop10rwc/worker-kit";
import type { Identity } from "@troop10rwc/shared";

// The whole troop10rwc.org domain sits behind Cloudflare Access (Zero Trust)
// with Slack as the identity provider. Access authenticates users at the edge
// before requests reach this Worker and injects a signed JWT
// (Cf-Access-Jwt-Assertion header / CF_Authorization cookie). We verify that
// JWT and read the user's identity from it — no app-level sign-in needed.
//
// The RS256 + JWKS verification itself lives in @troop10rwc/worker-kit's
// verifyAccessJwt (shared across Troop 10 apps). This module keeps only the two
// app-specific behaviors the kit's single-AUD `withAuth` doesn't yet cover:
//   1. token source — Access forwards the JWT as a header on API calls but only
//      sets the CF_Authorization cookie on top-level navigations, so we fall
//      back to the cookie.
//   2. dual audience — production and the workers.dev preview hostnames are two
//      separate Access applications with distinct AUD tags; a token for either
//      is accepted.
// When worker-kit gains cookie-fallback + multi-AUD support, this can collapse
// onto the kit's withAuth/requireLeader directly.

// Re-export so existing importers (src/worker/index.ts) keep a single source.
export type { Identity };

export interface AuthBindings {
  DB: D1Database;
  ROSTER: D1Database;
  CF_ACCESS_TEAM_DOMAIN: string; // e.g. troop10rwc.cloudflareaccess.com
  CF_ACCESS_AUD: string; // Access application AUD tag (production)
  CF_ACCESS_AUD_PREVIEW?: string; // AUD of the Access app guarding preview hostnames
  // DEV ONLY: when "1", skip Access and treat every request as a fixed dev user.
  // Set in .dev.vars for local work (there's no Access in front locally).
  DEV_AUTH_BYPASS?: string;
}

/**
 * Verify a Cloudflare Access JWT, accepting a token issued for the production
 * app OR the preview app. Delegates the signature/claims check to worker-kit's
 * verifyAccessJwt (which throws on failure); returns the identity for the first
 * audience that validates, or null if none do.
 */
async function verifyForAnyAudience(
  token: string,
  env: AuthBindings,
): Promise<Identity | null> {
  const audiences = [env.CF_ACCESS_AUD, env.CF_ACCESS_AUD_PREVIEW].filter(
    (a): a is string => Boolean(a),
  );
  for (const audience of audiences) {
    try {
      return await verifyAccessJwt(token, {
        teamDomain: env.CF_ACCESS_TEAM_DOMAIN,
        audience,
      });
    } catch {
      // Wrong AUD (or otherwise invalid) for this app — try the next one.
    }
  }
  return null;
}

/** Require a Cloudflare Access-authenticated user; sets `user` in context. */
export const requireAuth: MiddlewareHandler<{ Bindings: AuthBindings; Variables: { user: Identity } }> = async (c, next) => {
  if (c.env.DEV_AUTH_BYPASS === "1") {
    c.set("user", { email: "dev@local", name: "Dev User" });
    return next();
  }
  const token =
    c.req.header("Cf-Access-Jwt-Assertion") || getCookie(c, "CF_Authorization");
  const id = token ? await verifyForAnyAudience(token, c.env) : null;
  if (!id) return c.json({ error: "unauthorized" }, 401);
  c.set("user", id);
  await next();
};
