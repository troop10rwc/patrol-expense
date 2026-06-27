import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { d1SessionLookup, SESSION_COOKIE_NAME } from "@troop10rwc/worker-kit";
import type { Identity } from "@troop10rwc/shared";

// Auth is self-hosted member sessions (the kit's current model) — no Cloudflare
// Access, no app-level sign-in, no JWT verification here. The shared identity
// service at id.troop10rwc.org (AUTH_ORIGIN) signs members in (Slack enrollment +
// passkeys), writes the session to the shared IDDB (troop10-id) D1, and sets the
// `__Secure-troop_session` cookie. This Worker is a pure consumer: it reads that
// cookie and resolves it against IDDB via the kit's d1SessionLookup.
//
// The cookie is scoped to Domain=troop10rwc.org, so EVERY host that serves this
// app — production and any preview alike — must live under *.troop10rwc.org for
// the cookie to arrive (a *.workers.dev host can never carry it). DEV_AUTH_BYPASS=1
// stands in for a signed-in member locally (there's no identity service in front
// of dev).

// Re-export so existing importers (src/worker/index.ts) keep a single source.
export type { Identity };

export interface AuthBindings {
  DB: D1Database;
  ROSTER: D1Database;
  // Shared identity DB (troop10-id), owned by the auth service at
  // id.troop10rwc.org. Read-only from here: the session cookie is looked up in
  // its `sessions`/`users` tables. Never write to it or add migrations for it.
  IDDB: D1Database;
  // Origin of the identity service (login/logout + session issuer),
  // e.g. https://id.troop10rwc.org.
  AUTH_ORIGIN: string;
  // DEV ONLY: when "1", skip the session check and treat every request as a
  // fixed dev user. Set in .dev.vars for local work; NEVER set in production.
  DEV_AUTH_BYPASS?: string;
}

/**
 * Require a signed-in member. Validates the `__Secure-troop_session` cookie
 * against the shared identity DB and exposes the identity as `c.var.user`.
 *
 * An unauthenticated API call gets a 401 carrying `authOrigin` so the SPA can
 * bounce the browser to the identity service's login page (the SPA, not the
 * Worker, owns the redirect because only it knows the page the member is on).
 */
export const requireAuth: MiddlewareHandler<{
  Bindings: AuthBindings;
  Variables: { user: Identity };
}> = async (c, next) => {
  if (c.env.DEV_AUTH_BYPASS === "1") {
    c.set("user", { email: "dev@local", name: "Dev User" });
    return next();
  }

  const token = getCookie(c, SESSION_COOKIE_NAME);
  let session: Awaited<ReturnType<ReturnType<typeof d1SessionLookup>>> = null;
  if (token) {
    try {
      session = await d1SessionLookup(c.env.IDDB)(token);
    } catch (e) {
      console.warn("session lookup failed:", (e as Error).message);
    }
  }

  // Identity stays email-keyed (snapshots record created_by by email); a session
  // without an email can't be attributed, so treat it as unauthenticated.
  if (!session?.email) {
    return c.json({ error: "unauthorized", authOrigin: c.env.AUTH_ORIGIN }, 401);
  }

  c.set("user", { email: session.email, name: session.name ?? session.email });
  await next();
};
