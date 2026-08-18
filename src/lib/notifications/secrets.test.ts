/**
 * Phase 9F — secret repository tests against a real in-memory SQLite DB
 * (full migration history + foreign_keys=ON), proving:
 *   - set/get round-trip and upsert semantics
 *   - no plaintext ever lands in the DB
 *   - per-channel and per-key isolation
 *   - channel deletion cascades to secrets
 *   - wrong-key decryption fails loudly (never masked as "no secret")
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { notificationChannels, notificationSecrets } from "@/db/schema";
import { createTestDb } from "../../../test/helpers";
import { ENCRYPTION_KEY_ENV } from "./encryption";
import { getChannelSecret, hasChannelSecret, setChannelSecret, type SecretsDb } from "./secrets";

const TEST_KEY_HEX = "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";
const PLAINTEXT = "telegram-bot-token-abcdef123456";

let db: SecretsDb;

function createChannel(): number {
  return db
    .insert(notificationChannels)
    .values({ type: "webhook", name: "chan", config: "{}", enabled: 1 })
    .returning({ id: notificationChannels.id })
    .get().id;
}

function storedRows(channel: number, key: string) {
  return db
    .select()
    .from(notificationSecrets)
    .where(and(eq(notificationSecrets.channelId, channel), eq(notificationSecrets.key, key)))
    .all();
}

beforeAll(() => {
  // Deterministic key for the whole suite; never printed.
  vi.stubEnv(ENCRYPTION_KEY_ENV, TEST_KEY_HEX);
  db = createTestDb();
});

afterEach(() => {
  // Reset all tables between tests.
  db.delete(notificationSecrets).run();
  db.delete(notificationChannels).run();
});

describe("setChannelSecret / getChannelSecret", () => {
  it("round-trips a secret and stores only ciphertext", () => {
    const id = createChannel();
    setChannelSecret(id, "token", PLAINTEXT, db);
    expect(getChannelSecret(id, "token", db)).toBe(PLAINTEXT);
    const rows = storedRows(id, "token");
    expect(rows).toHaveLength(1);
    const stored = rows[0].encryptedValue;
    expect(stored).not.toContain(PLAINTEXT);
    expect(stored.split(":")).toHaveLength(3);
  });

  it("re-encrypts with a fresh IV on update (upsert keeps one row)", () => {
    const id = createChannel();
    setChannelSecret(id, "token", "first-value", db);
    const first = storedRows(id, "token")[0].encryptedValue;
    setChannelSecret(id, "token", "second-value", db);
    const rows = storedRows(id, "token");
    expect(rows).toHaveLength(1);
    expect(rows[0].encryptedValue).not.toBe(first);
    expect(getChannelSecret(id, "token", db)).toBe("second-value");
  });

  it("unsets a secret with null / empty value", () => {
    const id = createChannel();
    setChannelSecret(id, "token", PLAINTEXT, db);
    setChannelSecret(id, "token", null, db);
    expect(getChannelSecret(id, "token", db)).toBeNull();
    expect(storedRows(id, "token")).toHaveLength(0);
    // Empty string is also "unset".
    setChannelSecret(id, "token", PLAINTEXT, db);
    setChannelSecret(id, "token", "", db);
    expect(getChannelSecret(id, "token", db)).toBeNull();
  });

  it("returns null for an unset secret (never throws)", () => {
    const id = createChannel();
    expect(getChannelSecret(id, "token", db)).toBeNull();
    expect(hasChannelSecret(id, "token", db)).toBe(false);
  });

  it("rejects an empty key or invalid channel id", () => {
    const id = createChannel();
    expect(() => setChannelSecret(id, "", PLAINTEXT, db)).toThrow(/non-empty/i);
    expect(() => setChannelSecret(0, "token", PLAINTEXT, db)).toThrow(/positive/i);
  });
});

describe("isolation", () => {
  it("keeps secrets isolated across channels", () => {
    const a = createChannel();
    const b = createChannel();
    setChannelSecret(a, "token", PLAINTEXT, db);
    expect(getChannelSecret(a, "token", db)).toBe(PLAINTEXT);
    expect(getChannelSecret(b, "token", db)).toBeNull();
    expect(hasChannelSecret(b, "token", db)).toBe(false);
  });

  it("keeps different keys isolated on the same channel", () => {
    const id = createChannel();
    setChannelSecret(id, "token", PLAINTEXT, db);
    setChannelSecret(id, "api_key", "another-secret-9876", db);
    expect(getChannelSecret(id, "token", db)).toBe(PLAINTEXT);
    expect(getChannelSecret(id, "api_key", db)).toBe("another-secret-9876");
    expect(storedRows(id, "token")).toHaveLength(1);
    expect(storedRows(id, "api_key")).toHaveLength(1);
  });
});

describe("cascade on channel deletion", () => {
  it("deletes channel secrets via FK ON DELETE CASCADE", () => {
    const id = createChannel();
    setChannelSecret(id, "token", PLAINTEXT, db);
    setChannelSecret(id, "api_key", "another-secret-9876", db);
    expect(storedRows(id, "token")).toHaveLength(1);
    db.delete(notificationChannels).where(eq(notificationChannels.id, id)).run();
    expect(storedRows(id, "token")).toHaveLength(0);
    expect(storedRows(id, "api_key")).toHaveLength(0);
  });
});

describe("wrong key / tampered blob", () => {
  it("throws when decrypting with a different key (never returns null)", () => {
    const id = createChannel();
    setChannelSecret(id, "token", PLAINTEXT, db);
    vi.stubEnv(
      ENCRYPTION_KEY_ENV,
      "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    );
    // Different key -> auth tag fails -> getChannelSecret must throw.
    expect(() => getChannelSecret(id, "token", db)).toThrow();
    vi.stubEnv(ENCRYPTION_KEY_ENV, TEST_KEY_HEX);
    // Original key still works afterwards.
    expect(getChannelSecret(id, "token", db)).toBe(PLAINTEXT);
  });

  it("throws on a tampered stored blob", () => {
    const id = createChannel();
    setChannelSecret(id, "token", PLAINTEXT, db);
    const [iv, tag, ct] = storedRows(id, "token")[0].encryptedValue.split(":");
    const flipped = Buffer.from(ct, "base64");
    flipped[0] ^= 0x01;
    db.update(notificationSecrets)
      .set({ encryptedValue: `${iv}:${tag}:${flipped.toString("base64")}` })
      .where(eq(notificationSecrets.channelId, id))
      .run();
    expect(() => getChannelSecret(id, "token", db)).toThrow();
  });
});
