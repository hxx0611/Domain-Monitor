/**
 * Admin auth Server Actions (Phase 9E).
 *
 * All actions set/clear the session cookie via next/headers. Failure
 * messages are uniform dictionary keys — never raw hashes, recovery codes
 * or secrets, and login errors never reveal whether the account exists.
 */
"use server";

import {
  clearAdminSessionCookie,
  loginAdmin,
  recoverAdmin,
  setAdminSessionCookie,
  setupAdmin,
} from "./admin";
import { getRepository } from "@/lib/runtime/repository";

export type AuthActionResult = { ok: true; recoveryCode?: string } | { ok: false; error: string };

const MIN_PASSWORD_LENGTH = 10;

function validateNewPassword(
  value: unknown,
): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== "string" || value.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: "auth.errors.passwordTooShort" };
  }
  return { ok: true, value };
}

export async function setupAdminAction(input: { password: unknown }): Promise<AuthActionResult> {
  const repo = await getRepository();
  if (await repo.isAdminConfigured()) {
    return { ok: false, error: "auth.errors.alreadyConfigured" };
  }
  const password = validateNewPassword(input.password);
  if (!password.ok) {
    return password;
  }
  const { recoveryCode } = await setupAdmin(password.value);
  await setAdminSessionCookie();
  return { ok: true, recoveryCode };
}

export async function loginAdminAction(input: { password: unknown }): Promise<AuthActionResult> {
  const password = typeof input.password === "string" ? input.password : "";
  const ok = await loginAdmin(password);
  if (!ok) {
    // Uniform error — do not reveal "not configured" vs "wrong password".
    return { ok: false, error: "auth.errors.invalidCredentials" };
  }
  await setAdminSessionCookie();
  return { ok: true };
}

export async function logoutAdminAction(): Promise<{ ok: true }> {
  await clearAdminSessionCookie();
  return { ok: true };
}

export async function recoverAdminAction(input: {
  recoveryCode: unknown;
  password: unknown;
}): Promise<AuthActionResult> {
  const recoveryCode = typeof input.recoveryCode === "string" ? input.recoveryCode : "";
  const password = validateNewPassword(input.password);
  if (!password.ok) {
    return password;
  }
  const result = await recoverAdmin(recoveryCode, password.value);
  if (!result.ok) {
    return { ok: false, error: "auth.errors.invalidRecoveryCode" };
  }
  await setAdminSessionCookie();
  return { ok: true, recoveryCode: result.recoveryCode };
}
