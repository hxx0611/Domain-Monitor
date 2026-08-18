/**
 * Password hashing (Phase 9E).
 *
 * Node's built-in crypto.scrypt — no external dependency. Each hash embeds
 * its own random salt and the scrypt cost parameters, so verification never
 * hardcodes them and future cost increases stay backwards-compatible.
 *
 * Stored format (never a plaintext password):
 *   scrypt$N$r$p$saltHex$derivedHex
 *
 * The derived key comparison is constant-time (timingSafeEqual).
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SCRYPT_N = 16384; // 2^14 — ~16 MiB memory, ~50 ms
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const PREFIX = "scrypt";
const PARTS = 6; // prefix N r p salt derived

export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_LENGTH).toString("hex");
  const derived = scryptSync(password, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  }).toString("hex");
  return [PREFIX, SCRYPT_N, SCRYPT_R, SCRYPT_P, salt, derived].join("$");
}

/**
 * Constant-time password verification. Returns false (never throws) for
 * malformed stored values, so callers do not need error handling.
 */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== PARTS || parts[0] !== PREFIX) {
    return false;
  }
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = parts[4];
  const expected = Buffer.from(parts[5], "hex");
  if (!Number.isSafeInteger(N) || !Number.isSafeInteger(r) || !Number.isSafeInteger(p)) {
    return false;
  }
  if (expected.length === 0 || salt.length === 0) {
    return false;
  }
  const actual = scryptSync(password, salt, expected.length, { N, r, p });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Generates a cryptographically random recovery code (hex, 128-bit).
 * Stored only as a scrypt hash; returned to the user exactly once.
 */
export function generateRecoveryCode(): string {
  return randomBytes(16).toString("hex");
}
