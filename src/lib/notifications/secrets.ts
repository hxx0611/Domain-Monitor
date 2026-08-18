/**
 * Secret repository (Phase 9F).
 *
 * Persists channel secrets (e.g. Telegram bot tokens) ENCRYPTED with
 * AES-256-GCM. Plaintext never touches the DB, UI, RSC payloads, logs or
 * error messages — only the `iv:tag:ciphertext` blob is stored.
 *
 * - `setChannelSecret(channelId, key, value)` upserts one secret; passing
 *   null/"" unsets it (deletes the row).
 * - `getChannelSecret(channelId, key)` returns the plaintext or null.
 *   Decryption failure (wrong key / tampered blob) THROWS so callers
 *   (Phase 9H senders) can decide how to surface it — it is never masked
 *   as "no secret".
 * - Deleting a channel removes its secrets via the FK ON DELETE CASCADE
 *   on `notification_secrets.channel_id` (foreign_keys=ON in db/index.ts).
 *
 * Follows the repository convention: every function takes an optional DB
 * target for testability (`createTestDb()` in-memory SQLite).
 */

import "server-only";

import { and, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { db } from "@/db";
import { notificationSecrets, type Schema } from "@/db/schema";
import { decryptSecretWithKey, encryptSecretWithKey, getEncryptionKey } from "./encryption";

export type SecretsDb = BetterSQLite3Database<Schema>;

/** Upsert one encrypted secret for a channel. null/"" removes it. */
export function setChannelSecret(
  channelId: number,
  key: string,
  value: string | null,
  target: SecretsDb = db,
): void {
  if (typeof key !== "string" || key.length === 0) {
    throw new Error("secret key must be a non-empty string");
  }
  if (channelId < 1 || !Number.isInteger(channelId)) {
    throw new Error("channel id must be a positive integer");
  }
  if (value === null || value === undefined || value === "") {
    target
      .delete(notificationSecrets)
      .where(and(eq(notificationSecrets.channelId, channelId), eq(notificationSecrets.key, key)))
      .run();
    return;
  }
  const encryptedValue = encryptSecretWithKey(value, getEncryptionKey());
  target
    .insert(notificationSecrets)
    .values({ channelId, key, encryptedValue })
    .onConflictDoUpdate({
      target: [notificationSecrets.channelId, notificationSecrets.key],
      set: { encryptedValue, updatedAt: new Date() },
    })
    .run();
}

/**
 * Read a channel secret in plaintext. Returns null when unset; throws when
 * the stored blob cannot be decrypted (wrong/rotated key, corruption).
 */
export function getChannelSecret(
  channelId: number,
  key: string,
  target: SecretsDb = db,
): string | null {
  const row = target
    .select({ encryptedValue: notificationSecrets.encryptedValue })
    .from(notificationSecrets)
    .where(and(eq(notificationSecrets.channelId, channelId), eq(notificationSecrets.key, key)))
    .get();
  if (!row) {
    return null;
  }
  return decryptSecretWithKey(row.encryptedValue, getEncryptionKey());
}

/** True when a secret row exists for the channel+key. */
export function hasChannelSecret(channelId: number, key: string, target: SecretsDb = db): boolean {
  const row = target
    .select({ id: notificationSecrets.id })
    .from(notificationSecrets)
    .where(and(eq(notificationSecrets.channelId, channelId), eq(notificationSecrets.key, key)))
    .get();
  return row !== undefined;
}
