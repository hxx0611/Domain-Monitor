/**
 * AES-256-GCM secret encryption (Phase 9F).
 *
 * Stored format: `iv:tag:ciphertext`, each segment base64.
 *   - iv:   random 12-byte IV (per encryption, never reused)
 *   - tag:  16-byte GCM authentication tag (detects tampering / wrong key)
 *   - ciphertext: AES-256-GCM output
 *
 * Key handling:
 *   - `ENCRYPTION_KEY` env var wins. A 64-hex value is used verbatim
 *     (32 bytes); any other non-empty string is derived to 32 bytes via
 *     SHA-256 (so an arbitrary passphrase still yields a valid AES-256 key).
 *   - In production the env var is REQUIRED — missing it throws instead of
 *     silently degrading (which would lock existing secrets after a
 *     restart with a different key).
 *   - In development, when no env var is set, a persistent key file
 *     (`data/encryption.key`, mode 0600) is used: created once with random
 *     32 bytes, reused forever after. Its lifecycle is tied to the file:
 *     deleting it invalidates every stored secret. The file never enters
 *     Git (data/ is gitignored).
 *
 * The key never enters the DB, Git, client bundles, HTML, RSC payloads,
 * logs, or error messages.
 */

import "server-only";

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const ENCRYPTION_KEY_ENV = "ENCRYPTION_KEY";
export const DEV_KEY_FILE = "data/encryption.key";
export const KEY_BYTES = 32;
export const IV_BYTES = 12;
export const TAG_BYTES = 16;
const PARTS = 3;

/** Derive a 32-byte AES-256 key from a user-supplied string. */
export function normalizeEncryptionKey(input: string): Buffer {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new Error("encryption key must not be empty");
  }
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }
  return createHash("sha256").update(trimmed, "utf8").digest();
}

export interface EncryptionKeyOptions {
  env?: NodeJS.ProcessEnv;
  /** Base directory for the dev fallback key file (defaults to cwd). */
  cwd?: string;
}

/**
 * Resolve the AES-256 key. ENCRYPTION_KEY env wins; production requires it;
 * development falls back to a persistent `data/encryption.key` file.
 * No caching: the caller controls the source on every call, which keeps
 * tests (and restart semantics) predictable.
 */
export function getEncryptionKey(options: EncryptionKeyOptions = {}): Buffer {
  const env = options.env ?? process.env;
  const envKey = env[ENCRYPTION_KEY_ENV];
  if (envKey && envKey.trim().length > 0) {
    return normalizeEncryptionKey(envKey);
  }
  const isProduction = env.NODE_ENV === "production";
  if (isProduction) {
    throw new Error(
      `${ENCRYPTION_KEY_ENV} is required in production: set it before starting the server ` +
        "(existing encrypted secrets become undecryptable if the key changes).",
    );
  }
  const base = options.cwd ?? process.cwd();
  const file = join(base, DEV_KEY_FILE);
  if (existsSync(file)) {
    return normalizeEncryptionKey(readFileSync(file, "utf8"));
  }
  const key = randomBytes(KEY_BYTES);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, key.toString("hex"), { mode: 0o600 });
  return key;
}

/**
 * Encrypt a non-empty secret. Returns `iv:tag:ciphertext` (base64).
 * Throws on empty / non-string input (controlled failure — callers decide
 * whether to surface it).
 */
export function encryptSecretWithKey(plaintext: string, key: Buffer): string {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new Error("secret must be a non-empty string");
  }
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new Error("encryption key must be a 32-byte buffer");
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ciphertext].map((part) => part.toString("base64")).join(":");
}

/**
 * Decrypt an `iv:tag:ciphertext` value. Throws on malformed input, wrong
 * key, or tampering (GCM auth tag verification). Callers must catch — the
 * error message deliberately contains no secret material.
 */
export function decryptSecretWithKey(encoded: string, key: Buffer): string {
  if (typeof encoded !== "string" || encoded.length === 0) {
    throw new Error("invalid encrypted secret");
  }
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new Error("encryption key must be a 32-byte buffer");
  }
  const parts = encoded.split(":");
  if (parts.length !== PARTS) {
    throw new Error("invalid encrypted secret format");
  }
  const iv = Buffer.from(parts[0], "base64");
  const tag = Buffer.from(parts[1], "base64");
  const ciphertext = Buffer.from(parts[2], "base64");
  if (iv.length !== IV_BYTES) {
    throw new Error("invalid IV length");
  }
  if (tag.length !== TAG_BYTES) {
    throw new Error("invalid auth tag length");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plain.toString("utf8");
}

/** Convenience wrappers using the resolved key. */
export function encryptSecret(plaintext: string): string {
  return encryptSecretWithKey(plaintext, getEncryptionKey());
}

export function decryptSecret(encoded: string): string {
  return decryptSecretWithKey(encoded, getEncryptionKey());
}
