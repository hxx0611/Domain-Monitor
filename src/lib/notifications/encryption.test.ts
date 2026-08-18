/**
 * Phase 9F — AES-256-GCM encryption unit tests.
 *
 * Covers: round-trip, fresh IV per encryption, tamper detection, wrong-key
 * rejection, controlled failure on empty/invalid input, key normalization
 * and key-source resolution (env > dev file > production requirement).
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEV_KEY_FILE,
  ENCRYPTION_KEY_ENV,
  decryptSecretWithKey,
  encryptSecretWithKey,
  getEncryptionKey,
  normalizeEncryptionKey,
} from "./encryption";

// Test-only key material (never printed to reports).
const TEST_KEY_HEX = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const TEST_KEY = Buffer.from(TEST_KEY_HEX, "hex");
const OTHER_KEY = Buffer.from(
  "2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f",
  "hex",
);
const PLAINTEXT = "super-secret-token-1234567890";

describe("encryptSecretWithKey / decryptSecretWithKey", () => {
  it("round-trips a secret", () => {
    const encoded = encryptSecretWithKey(PLAINTEXT, TEST_KEY);
    expect(decryptSecretWithKey(encoded, TEST_KEY)).toBe(PLAINTEXT);
  });

  it("uses a fresh random IV per encryption (no two encodings equal)", () => {
    const a = encryptSecretWithKey(PLAINTEXT, TEST_KEY);
    const b = encryptSecretWithKey(PLAINTEXT, TEST_KEY);
    expect(a).not.toBe(b);
    const ivA = a.split(":")[0];
    const ivB = b.split(":")[0];
    expect(ivA).not.toBe(ivB);
    expect(decryptSecretWithKey(a, TEST_KEY)).toBe(PLAINTEXT);
    expect(decryptSecretWithKey(b, TEST_KEY)).toBe(PLAINTEXT);
  });

  it("rejects tampered ciphertext", () => {
    const encoded = encryptSecretWithKey(PLAINTEXT, TEST_KEY);
    const [iv, tag, ciphertext] = encoded.split(":");
    const flipped = Buffer.from(ciphertext, "base64");
    flipped[0] ^= 0x01;
    const tampered = `${iv}:${tag}:${flipped.toString("base64")}`;
    expect(() => decryptSecretWithKey(tampered, TEST_KEY)).toThrow();
  });

  it("rejects a tampered auth tag", () => {
    const encoded = encryptSecretWithKey(PLAINTEXT, TEST_KEY);
    const [iv, , ciphertext] = encoded.split(":");
    const flipped = Buffer.from(encoded.split(":")[1], "base64");
    flipped[0] ^= 0x01;
    const tampered = `${iv}:${flipped.toString("base64")}:${ciphertext}`;
    expect(() => decryptSecretWithKey(tampered, TEST_KEY)).toThrow();
  });

  it("rejects a tampered IV", () => {
    const encoded = encryptSecretWithKey(PLAINTEXT, TEST_KEY);
    const [, tag, ciphertext] = encoded.split(":");
    const flipped = Buffer.from(encoded.split(":")[0], "base64");
    flipped[0] ^= 0x01;
    const tampered = `${flipped.toString("base64")}:${tag}:${ciphertext}`;
    expect(() => decryptSecretWithKey(tampered, TEST_KEY)).toThrow();
  });

  it("fails to decrypt with the wrong key", () => {
    const encoded = encryptSecretWithKey(PLAINTEXT, TEST_KEY);
    expect(() => decryptSecretWithKey(encoded, OTHER_KEY)).toThrow();
  });

  it("fails controlled on empty / non-string input", () => {
    expect(() => encryptSecretWithKey("", TEST_KEY)).toThrow(/non-empty/i);
    expect(() => encryptSecretWithKey("", TEST_KEY)).toThrow();
    expect(() => decryptSecretWithKey("", TEST_KEY)).toThrow();
    expect(() => decryptSecretWithKey("not-an-encoded-value", TEST_KEY)).toThrow();
  });

  it("fails controlled on malformed structure and wrong segment lengths", () => {
    // Two segments instead of three.
    expect(() => decryptSecretWithKey("aGVsbG8=", TEST_KEY)).toThrow(/format/i);
    // IV that is not 12 bytes.
    const shortIv = Buffer.alloc(8).toString("base64");
    const tag = Buffer.alloc(16).toString("base64");
    const ct = Buffer.alloc(4).toString("base64");
    expect(() => decryptSecretWithKey(`${shortIv}:${tag}:${ct}`, TEST_KEY)).toThrow(/IV/i);
    // Tag that is not 16 bytes.
    expect(() =>
      decryptSecretWithKey(
        `${Buffer.alloc(12).toString("base64")}:${Buffer.alloc(8).toString("base64")}:${ct}`,
        TEST_KEY,
      ),
    ).toThrow(/tag/i);
  });

  it("rejects invalid key buffers", () => {
    expect(() => encryptSecretWithKey(PLAINTEXT, Buffer.alloc(16))).toThrow(/32-byte/i);
    expect(() => decryptSecretWithKey("a:b:c", Buffer.alloc(16))).toThrow(/32-byte/i);
  });
});

describe("normalizeEncryptionKey", () => {
  it("uses a 64-hex value verbatim as the 32-byte key", () => {
    const key = normalizeEncryptionKey(TEST_KEY_HEX);
    expect(key).toEqual(TEST_KEY);
    expect(key.length).toBe(32);
  });

  it("derives a 32-byte key from an arbitrary passphrase", () => {
    const key = normalizeEncryptionKey("correct horse battery staple");
    expect(key.length).toBe(32);
    // Deterministic: same input -> same key.
    expect(normalizeEncryptionKey("correct horse battery staple")).toEqual(key);
  });

  it("rejects an empty key", () => {
    expect(() => normalizeEncryptionKey("")).toThrow(/empty/i);
    expect(() => normalizeEncryptionKey("   ")).toThrow(/empty/i);
  });
});

describe("getEncryptionKey", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("prefers ENCRYPTION_KEY env (hex)", () => {
    vi.stubEnv(ENCRYPTION_KEY_ENV, TEST_KEY_HEX);
    expect(getEncryptionKey()).toEqual(TEST_KEY);
  });

  it("prefers ENCRYPTION_KEY env (passphrase, derived)", () => {
    vi.stubEnv(ENCRYPTION_KEY_ENV, "some-passphrase");
    expect(getEncryptionKey().length).toBe(32);
  });

  it("throws in production without ENCRYPTION_KEY", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv(ENCRYPTION_KEY_ENV, "");
    expect(() => getEncryptionKey()).toThrow(/required in production/i);
  });

  it("creates and reuses a persistent dev fallback key file", () => {
    const dir = mkdtempSync(join(tmpdir(), "dm-enc-key-"));
    try {
      vi.stubEnv("NODE_ENV", "development");
      vi.stubEnv(ENCRYPTION_KEY_ENV, "");
      const key1 = getEncryptionKey({ cwd: dir });
      expect(key1.length).toBe(32);
      const file = join(dir, DEV_KEY_FILE);
      const raw = readFileSync(file, "utf8");
      expect(raw).toMatch(/^[0-9a-f]{64}$/);
      // Second call reuses the file -> same key.
      const key2 = getEncryptionKey({ cwd: dir });
      expect(key2).toEqual(key1);
      // Stored secrets remain decryptable after a "restart" (new call).
      const encoded = encryptSecretWithKey(PLAINTEXT, key1);
      expect(decryptSecretWithKey(encoded, getEncryptionKey({ cwd: dir }))).toBe(PLAINTEXT);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reuses an existing dev fallback key file", () => {
    const dir = mkdtempSync(join(tmpdir(), "dm-enc-key-"));
    try {
      vi.stubEnv("NODE_ENV", "development");
      vi.stubEnv(ENCRYPTION_KEY_ENV, "");
      mkdirSync(join(dir, "data"), { recursive: true });
      writeFileSync(join(dir, DEV_KEY_FILE), TEST_KEY_HEX, { mode: 0o600 });
      expect(getEncryptionKey({ cwd: dir })).toEqual(TEST_KEY);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
