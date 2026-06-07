import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";

// The whole troop10rwc.org domain sits behind Cloudflare Access (Zero Trust)
// with Slack as the identity provider. Access authenticates users at the edge
// before requests reach this Worker and injects a signed JWT
// (Cf-Access-Jwt-Assertion header / CF_Authorization cookie). We verify that
// JWT and read the user's identity from it — no app-level sign-in needed.

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

export interface Identity {
  email: string;
  name: string;
}

// JWKS for the Access team, cached per isolate.
let jwksCache: { keys: JsonWebKey[]; expires: number } | null = null;

async function getSigningKeys(teamDomain: string): Promise<JsonWebKey[]> {
  if (jwksCache && jwksCache.expires > Date.now()) return jwksCache.keys;
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  const data = (await res.json()) as { keys?: JsonWebKey[] };
  jwksCache = { keys: data.keys ?? [], expires: Date.now() + 60 * 60 * 1000 };
  return jwksCache.keys;
}

function b64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function decodeSegment<T = Record<string, unknown>>(s: string): T {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));
}

/** Verify a Cloudflare Access JWT and return the user's identity, or null. */
async function verifyAccessJwt(token: string, env: AuthBindings): Promise<Identity | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;

  let header: { kid?: string; alg?: string };
  let payload: { iss?: string; aud?: string | string[]; exp?: number; email?: string; custom?: Record<string, unknown> };
  try {
    header = decodeSegment(h);
    payload = decodeSegment(p);
  } catch {
    return null;
  }

  // Claims. Accept a token issued for the production app OR the preview app, so
  // the same Worker authenticates on troop10rwc.org and on the workers.dev
  // preview hostnames (each Access application has its own AUD tag).
  if (payload.iss !== `https://${env.CF_ACCESS_TEAM_DOMAIN}`) return null;
  const aud = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [];
  const allowedAud = [env.CF_ACCESS_AUD, env.CF_ACCESS_AUD_PREVIEW].filter(Boolean);
  if (!aud.some((a) => allowedAud.includes(a))) return null;
  if (!payload.exp || payload.exp * 1000 < Date.now()) return null;

  // Signature (RS256).
  const jwk = (await getSigningKeys(env.CF_ACCESS_TEAM_DOMAIN)).find(
    (k) => (k as JsonWebKey & { kid?: string }).kid === header.kid,
  );
  if (!jwk) return null;
  const key = await crypto.subtle.importKey(
    "jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"],
  );
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5", key, b64urlToBytes(sig), new TextEncoder().encode(`${h}.${p}`),
  );
  if (!ok) return null;

  const email = String(payload.email ?? "");
  if (!email) return null;
  const name = String((payload.custom?.name as string) ?? email);
  return { email, name };
}

/** Require a Cloudflare Access-authenticated user; sets `user` in context. */
export const requireAuth: MiddlewareHandler<{ Bindings: AuthBindings; Variables: { user: Identity } }> = async (c, next) => {
  if (c.env.DEV_AUTH_BYPASS === "1") {
    c.set("user", { email: "dev@local", name: "Dev User" });
    return next();
  }
  const token =
    c.req.header("Cf-Access-Jwt-Assertion") || getCookie(c, "CF_Authorization");
  const id = token ? await verifyAccessJwt(token, c.env) : null;
  if (!id) return c.json({ error: "unauthorized" }, 401);
  c.set("user", id);
  await next();
};
