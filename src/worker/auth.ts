import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { MiddlewareHandler } from "hono";
import { BASE_PATH } from "../shared/constants.ts";

// "Sign in with Slack" (OpenID Connect) + a signed session cookie. Access is
// gated to people linked to a roster member in roster-db.

export interface AuthBindings {
  DB: D1Database;
  ROSTER: D1Database;
  SLACK_CLIENT_ID: string;
  SLACK_CLIENT_SECRET: string;
  SESSION_SECRET: string;
  SLACK_TEAM_ID?: string; // optional extra check: lock to one workspace
  // DEV ONLY: when "1", skip Slack and treat every request as a fixed dev user.
  // Set in .dev.vars for local work; never set this in production.
  DEV_AUTH_BYPASS?: string;
}

export interface SessionUser {
  uid: string; // slack user id
  name: string;
  bsa: string | null; // matched roster bsa_number (if any)
  exp: number; // epoch ms
}

const SESSION_COOKIE = "pe_session";
const STATE_COOKIE = "pe_oauth_state";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const enc = new TextEncoder();

function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return b64urlEncode(new Uint8Array(sig));
}

// Constant-time string compare.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function signSession(secret: string, user: SessionUser): Promise<string> {
  const payload = b64urlEncode(enc.encode(JSON.stringify(user)));
  const sig = await hmac(secret, payload);
  return `${payload}.${sig}`;
}

async function verifySession(secret: string, token: string): Promise<SessionUser | null> {
  const dot = token.lastIndexOf(".");
  if (dot < 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = await hmac(secret, payload);
  if (!timingSafeEqual(sig, expected)) return null;
  try {
    const user = JSON.parse(new TextDecoder().decode(b64urlDecode(payload))) as SessionUser;
    if (!user.exp || user.exp < Date.now()) return null;
    return user;
  } catch {
    return null;
  }
}

const isHttps = (url: string) => new URL(url).protocol === "https:";
const redirectUri = (url: string) => `${new URL(url).origin}${BASE_PATH}/auth/callback`;

/** Decode (without signature verification) a JWT payload. The id_token comes
 *  directly from Slack's authenticated token endpoint over TLS, so its
 *  contents are trusted. */
function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length < 2) return {};
  try {
    return JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])));
  } catch {
    return {};
  }
}

/** Is this Slack user allowed in? Linked to a roster member, or an admin. */
async function resolveAccess(env: AuthBindings, slackUserId: string): Promise<{ allowed: boolean; bsa: string | null }> {
  const assoc = await env.ROSTER
    .prepare("SELECT bsa_number FROM user_member_associations WHERE slack_user_id = ?")
    .bind(slackUserId)
    .first<{ bsa_number: string }>();
  if (assoc) return { allowed: true, bsa: assoc.bsa_number };
  const admin = await env.ROSTER
    .prepare("SELECT 1 AS ok FROM admins WHERE slack_user_id = ?")
    .bind(slackUserId)
    .first<{ ok: number }>();
  return { allowed: !!admin, bsa: null };
}

export const authApp = new Hono<{ Bindings: AuthBindings }>();

// Kick off the OAuth flow.
authApp.get("/login", async (c) => {
  const url = c.req.url;
  const state = b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
  setCookie(c, STATE_COOKIE, state, {
    httpOnly: true, secure: isHttps(url), sameSite: "Lax", path: `${BASE_PATH}/auth`, maxAge: 600,
  });
  const authorize = new URL("https://slack.com/openid/connect/authorize");
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", "openid profile email");
  authorize.searchParams.set("client_id", c.env.SLACK_CLIENT_ID);
  authorize.searchParams.set("redirect_uri", redirectUri(url));
  authorize.searchParams.set("state", state);
  if (c.env.SLACK_TEAM_ID) authorize.searchParams.set("team", c.env.SLACK_TEAM_ID);
  return c.redirect(authorize.toString());
});

// OAuth callback: exchange the code, gate on roster membership, set session.
authApp.get("/callback", async (c) => {
  const url = c.req.url;
  const code = c.req.query("code");
  const state = c.req.query("state");
  const savedState = getCookie(c, STATE_COOKIE);
  deleteCookie(c, STATE_COOKIE, { path: `${BASE_PATH}/auth` });

  if (!code || !state || !savedState || state !== savedState) {
    return c.html(deniedPage("Sign-in failed (bad state). Please try again."), 400);
  }

  const tokenRes = await fetch("https://slack.com/api/openid.connect.token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: c.env.SLACK_CLIENT_ID,
      client_secret: c.env.SLACK_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri(url),
    }),
  });
  const token = (await tokenRes.json()) as { ok?: boolean; id_token?: string; error?: string };
  if (!token.ok || !token.id_token) {
    return c.html(deniedPage(`Slack sign-in error: ${token.error ?? "unknown"}`), 400);
  }

  const claims = decodeJwtPayload(token.id_token);
  const slackUserId = String(claims["https://slack.com/user_id"] ?? "");
  const teamId = String(claims["https://slack.com/team_id"] ?? "");
  const name = String(claims["name"] ?? claims["email"] ?? slackUserId);

  if (!slackUserId) return c.html(deniedPage("Slack did not return a user id."), 400);
  if (c.env.SLACK_TEAM_ID && teamId !== c.env.SLACK_TEAM_ID) {
    return c.html(deniedPage("This Slack workspace isn't authorized for Troop 10 Expenses."), 403);
  }

  const { allowed, bsa } = await resolveAccess(c.env, slackUserId);
  if (!allowed) {
    return c.html(
      deniedPage("Your Slack account isn't linked to a Troop 10 roster member, so you don't have access. Ask an admin to link you in the roster."),
      403,
    );
  }

  const user: SessionUser = { uid: slackUserId, name, bsa, exp: Date.now() + SESSION_TTL_MS };
  setCookie(c, SESSION_COOKIE, await signSession(c.env.SESSION_SECRET, user), {
    httpOnly: true, secure: isHttps(url), sameSite: "Lax", path: BASE_PATH, maxAge: SESSION_TTL_MS / 1000,
  });
  return c.redirect(`${BASE_PATH}/`);
});

authApp.get("/logout", (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: BASE_PATH });
  return c.redirect(`${BASE_PATH}/`);
});

/** Require a valid session on protected routes; sets `user` in context. */
export const requireAuth: MiddlewareHandler<{ Bindings: AuthBindings; Variables: { user: SessionUser } }> = async (c, next) => {
  if (c.env.DEV_AUTH_BYPASS === "1") {
    c.set("user", { uid: "DEV", name: "Dev User", bsa: null, exp: Date.now() + SESSION_TTL_MS });
    return next();
  }
  const token = getCookie(c, SESSION_COOKIE);
  const user = token ? await verifySession(c.env.SESSION_SECRET, token) : null;
  if (!user) return c.json({ error: "unauthorized" }, 401);
  c.set("user", user);
  await next();
};

function deniedPage(message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Troop 10 Expenses</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f6f7f9;color:#1d2530;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
.box{max-width:420px;text-align:center;padding:28px;background:#fff;border:1px solid #e3e7ec;border-radius:12px}
a{display:inline-block;margin-top:14px;color:#1f6feb}</style></head>
<body><div class="box"><h2>Access denied</h2><p>${message}</p><a href="${BASE_PATH}/">← Back</a></div></body></html>`;
}
