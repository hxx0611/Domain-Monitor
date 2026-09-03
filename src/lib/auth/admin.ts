/**
 * Admin authentication service (Phase 9E).
 *
 * Owns the single `admin_settings` row, session cookies and the guard
 * functions. Synchronous DB access lives in `./admin-db` (a tiny module with
 * no dependency on the repository singleton) so the repository adapters can
 * reuse it without an import cycle.
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

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { Repository } from "@/db/repository";
import { getRepository } from "@/lib/runtime/repository";
import { generateRecoveryCode, hashPassword, verifyPassword } from "./password";
import {
  SESSION_COOKIE_NAME,
  createSessionValue,
  sessionCookieOptions,
  verifySessionValue,
} from "./session";

export {
  getAdminRow,
  insertAdminRow,
  updateAdminRow,
  isAdminConfigured,
  getSessionSecret,
  getEncryptionKey,
  type AdminDb,
} from "./admin-db";

// ---------------------------------------------------------------------------
// Session cookies
// ---------------------------------------------------------------------------

export async function setAdminSessionCookie(repo?: Repository): Promise<void> {
  const r = repo ?? (await getRepository());
  const store = await cookies();
  store.set(
    SESSION_COOKIE_NAME,
    createSessionValue(await r.getSessionSecret()),
    sessionCookieOptions(),
  );
}

export async function clearAdminSessionCookie(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE_NAME);
}

export async function isAdminAuthenticated(repo?: Repository): Promise<boolean> {
  const r = repo ?? (await getRepository());
  const store = await cookies();
  const value = store.get(SESSION_COOKIE_NAME)?.value;
  if (!value) {
    return false;
  }
  try {
    return verifySessionValue(value, await r.getSessionSecret());
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
export async function requireAdmin(repo?: Repository): Promise<boolean> {
  return isAdminAuthenticated(repo);
}

/**
 * Page (RSC) guard: redirects unconfigured installs to /setup and
 * unauthenticated visitors to /login.
 */
export async function requirePageAccess(repo?: Repository): Promise<void> {
  const r = repo ?? (await getRepository());
  if (!(await r.isAdminConfigured())) {
    redirect("/setup");
  }
  if (!(await isAdminAuthenticated(repo))) {
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
export async function setupAdmin(
  password: string,
  repo?: Repository,
): Promise<{ recoveryCode: string }> {
  const r = repo ?? (await getRepository());
  if (await r.isAdminConfigured()) {
    throw new Error("Admin already configured");
  }
  const recoveryCode = generateRecoveryCode();
  await r.insertAdminRow({
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
export async function loginAdmin(password: string, repo?: Repository): Promise<boolean> {
  const r = repo ?? (await getRepository());
  const row = await r.getAdminRow();
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
export async function recoverAdmin(
  recoveryCode: string,
  newPassword: string,
  repo?: Repository,
): Promise<{ ok: true; recoveryCode: string } | { ok: false }> {
  const r = repo ?? (await getRepository());
  const row = await r.getAdminRow();
  if (!row?.recoveryCodeHash || !row.passwordHash) {
    return { ok: false };
  }
  if (!verifyPassword(recoveryCode, row.recoveryCodeHash)) {
    return { ok: false };
  }
  const nextRecoveryCode = generateRecoveryCode();
  await r.updateAdminRow(row.id, {
    passwordHash: hashPassword(newPassword),
    recoveryCodeHash: hashPassword(nextRecoveryCode),
    sessionSecret: generateRecoveryCode() + generateRecoveryCode(),
  });
  return { ok: true, recoveryCode: nextRecoveryCode };
}
