/**
 * Admin authentication service (Phase 9E).
 *
 * Owns the single `admin_settings` row, session cookies and the guard
 * functions. DB access follows the project convention (injectable target
 * with the global db as default) so tests can pass an in-memory db.
 *
 * Security invariants:
 * - Passwords and recovery codes are stored ONLY as scrypt hashes.
 * - The session secret is read from SESSION_SECRET env when set, otherwise
 *   from the DB row (rotated on recovery → all old sessions die).
 * - `requireAdmin` must be called inside every mutating Server Action —
 *   page-level `requirePageAccess` is never the only line of defence.
 * - Never log or return the password, recovery code, hashes or secrets.
 */
import "server-only";

import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { adminSettings, type AdminSettingsRow, type Schema } from "@/db/schema";
import { generateRecoveryCode, hashPassword, verifyPassword } from "./password";
import {
  SESSION_COOKIE_NAME,
  createSessionValue,
  sessionCookieOptions,
  verifySessionValue,
} from "./session";

export type AdminDb = BetterSQLite3Database<Schema>;

// ---------------------------------------------------------------------------
// DB access (injectable for tests)
// ---------------------------------------------------------------------------

export function getAdminRow(target: AdminDb = db): AdminSettingsRow | undefined {
  return target.select().from(adminSettings).limit(1).get();
}

export function insertAdminRow(
  target: AdminDb = db,
  values: {
    passwordHash: string;
    recoveryCodeHash: string;
    sessionSecret: string;
    encryptionKey?: string;
  },
): void {
  target.insert(adminSettings).values(values).run();
}

export function updateAdminRow(
  target: AdminDb = db,
  id: number,
  values: Partial<{
    passwordHash: string | null;
    recoveryCodeHash: string | null;
    sessionSecret: string;
    encryptionKey: string;
    updatedAt: Date;
  }>,
): void {
  target
    .update(adminSettings)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(adminSettings.id, id))
    .run();
}

// ---------------------------------------------------------------------------
// Configuration state
// ---------------------------------------------------------------------------

/** True once the setup wizard has stored a password hash. */
export function isAdminConfigured(target: AdminDb = db): boolean {
  const row = getAdminRow(target);
  return Boolean(row?.passwordHash);
}

/**
 * HMAC key for signing session cookies. Prefers the SESSION_SECRET env var
 * (stable across restarts, recommended in production); falls back to the
 * auto-generated value persisted in the DB row (rotated on recovery so old
 * sessions die). Never exposed outside this module.
 */
export function getSessionSecret(target: AdminDb = db): string {
  const envSecret = process.env.SESSION_SECRET;
  if (envSecret) {
    return envSecret;
  }
  const row = getAdminRow(target);
  if (!row?.sessionSecret) {
    throw new Error("Admin session secret is not initialized");
  }
  return row.sessionSecret;
}

/**
 * Encryption key reserved for Phase 9F secret storage. Prefers the
 * ENCRYPTION_KEY env var; falls back to the persisted value created at
 * setup. MUST be stable across restarts (never random per-process), or
 * stored secrets become undecryptable. Not used by Phase 9E.
 */
export function getEncryptionKey(target: AdminDb = db): string {
  const envKey = process.env.ENCRYPTION_KEY;
  if (envKey) {
    return envKey;
  }
  const row = getAdminRow(target);
  if (!row?.encryptionKey) {
    throw new Error("Admin encryption key is not initialized");
  }
  return row.encryptionKey;
}

// ---------------------------------------------------------------------------
// Session cookies
// ---------------------------------------------------------------------------

export async function setAdminSessionCookie(): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE_NAME, createSessionValue(getSessionSecret()), sessionCookieOptions());
}

export async function clearAdminSessionCookie(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE_NAME);
}

export async function isAdminAuthenticated(target: AdminDb = db): Promise<boolean> {
  const store = await cookies();
  const value = store.get(SESSION_COOKIE_NAME)?.value;
  if (!value) {
    return false;
  }
  try {
    return verifySessionValue(value, getSessionSecret(target));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/**
 * Server Action guard: true only when a valid admin session cookie exists.
 * Must be called at the top of every mutating action; never rely solely on
 * page-level redirects.
 */
export async function requireAdmin(): Promise<boolean> {
  return isAdminAuthenticated();
}

/**
 * Page (RSC) guard: redirects unconfigured installs to /setup and
 * unauthenticated visitors to /login.
 */
export async function requirePageAccess(target: AdminDb = db): Promise<void> {
  if (!isAdminConfigured(target)) {
    redirect("/setup");
  }
  if (!(await isAdminAuthenticated(target))) {
    redirect("/login");
  }
}

// ---------------------------------------------------------------------------
// Flows
// ---------------------------------------------------------------------------

/**
 * First-run setup: creates the admin row, persists scrypt hashes of the
 * password and a fresh recovery code, signs a session, and returns the
 * recovery code exactly once (the caller shows it to the user).
 */
export function setupAdmin(password: string, target: AdminDb = db): { recoveryCode: string } {
  if (isAdminConfigured(target)) {
    throw new Error("Admin already configured");
  }
  const recoveryCode = generateRecoveryCode();
  insertAdminRow(target, {
    passwordHash: hashPassword(password),
    recoveryCodeHash: hashPassword(recoveryCode),
    sessionSecret: generateRecoveryCode() + generateRecoveryCode(), // 32-byte hex secret
  });
  return { recoveryCode };
}

/**
 * Password login. Returns false for BOTH "not configured" and "wrong
 * password" so the response never reveals which one occurred (no account
 * enumeration).
 */
export function loginAdmin(password: string, target: AdminDb = db): boolean {
  const row = getAdminRow(target);
  if (!row?.passwordHash) {
    return false;
  }
  if (!verifyPassword(password, row.passwordHash)) {
    return false;
  }
  return true;
}

/**
 * Recovery-code reset. Verifies the stored recovery hash, then rotates the
 * session secret (invalidating every outstanding session) and replaces both
 * the password hash and the recovery code (old code dies, new code returned
 * once). Returns false for invalid/expired codes.
 */
export function recoverAdmin(
  recoveryCode: string,
  newPassword: string,
  target: AdminDb = db,
): { ok: true; recoveryCode: string } | { ok: false } {
  const row = getAdminRow(target);
  if (!row?.recoveryCodeHash || !row.passwordHash) {
    return { ok: false };
  }
  if (!verifyPassword(recoveryCode, row.recoveryCodeHash)) {
    return { ok: false };
  }
  const nextRecoveryCode = generateRecoveryCode();
  updateAdminRow(target, row.id, {
    passwordHash: hashPassword(newPassword),
    recoveryCodeHash: hashPassword(nextRecoveryCode),
    sessionSecret: generateRecoveryCode() + generateRecoveryCode(),
  });
  return { ok: true, recoveryCode: nextRecoveryCode };
}
