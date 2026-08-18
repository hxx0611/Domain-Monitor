/**
 * Admin session cookies (Phase 9E).
 *
 * A session is a self-contained signed value:
 *   <version>.<expiryBase36>.<entropyBase64Url>.HMAC-SHA256(payload, sessionSecret)
 *
 * The payload embeds an absolute expiry, so a stolen cookie cannot be made
 * valid forever by replaying it; the HMAC prevents forgery/ tampering.
 * Rotating `sessionSecret` (password recovery / credential reset) invalidates
 * every outstanding session at once.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE_NAME = "dm_admin_session";

const VERSION = "1";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const ENTROPY_LENGTH = 24;
const PARTS = 4; // version expiry entropy signature

export function createSessionValue(sessionSecret: string, now: number = Date.now()): string {
  const expiry = now + SESSION_TTL_MS;
  const payload = [
    VERSION,
    expiry.toString(36),
    randomBytes(ENTROPY_LENGTH).toString("base64url"),
  ].join(".");
  const signature = sign(payload, sessionSecret);
  return `${payload}.${signature}`;
}

export function verifySessionValue(
  value: string,
  sessionSecret: string,
  now: number = Date.now(),
): boolean {
  const parts = value.split(".");
  if (parts.length !== PARTS) {
    return false;
  }
  const [version, expiryBase36, entropy, signature] = parts;
  if (version !== VERSION || entropy.length === 0) {
    return false;
  }
  const expiry = Number.parseInt(expiryBase36, 36);
  if (!Number.isSafeInteger(expiry) || expiry <= now) {
    return false;
  }
  const payload = `${version}.${expiryBase36}.${entropy}`;
  const expected = sign(payload, sessionSecret);
  const a = Buffer.from(signature, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function sign(payload: string, sessionSecret: string): string {
  return createHmac("sha256", sessionSecret).update(payload).digest("base64url");
}

export interface SessionCookieOptions {
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: "/";
  maxAge: number;
}

/**
 * Cookie attributes: HttpOnly + SameSite=Lax + Secure (production only).
 * SameSite=Lax blocks cross-site POSTs (CSRF) while keeping top-level
 * navigations working; Server Actions add their own origin check.
 */
export function sessionCookieOptions(secure?: boolean): SessionCookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: secure ?? process.env.NODE_ENV === "production",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  };
}
