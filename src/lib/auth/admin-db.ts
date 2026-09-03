/**
 * Admin-settings DB access — SQLite implementation layer.
 *
 * Split out of `admin.ts` so the repository adapters (sqlite.ts) can read
 * and write the single `admin_settings` row WITHOUT importing the async
 * auth flows, which depend on `@/db/repository` (an import cycle: the
 * adapters would pull in the repository singleton before the adapter class
 * itself is defined).
 *
 * Only the synchronous row operations live here. The async flows
 * (setupAdmin / loginAdmin / recoverAdmin / isAdminAuthenticated /
 * requirePageAccess / session cookies) remain in `admin.ts`.
 */
import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { db } from "@/db";
import { adminSettings, type AdminSettingsRow, type Schema } from "@/db/schema";

export type AdminDb = BetterSQLite3Database<Schema>;

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
    throw new Error("Admin session secret is not initialized. Run the setup wizard first.");
  }
  return row.sessionSecret;
}

/**
 * Key used to encrypt secrets at rest (reserved for 9F). Prefers the
 * ENCRYPTION_KEY env var; falls back to a per-process random key. If the
 * env var is not set and the DB has no key, we throw rather than silently
 * producing an unrecoverable cipher: an operator must decide.
 */
export function getEncryptionKey(target: AdminDb = db): string {
  const envKey = process.env.ENCRYPTION_KEY;
  if (envKey) {
    return envKey;
  }
  const row = getAdminRow(target);
  if (!row?.encryptionKey) {
    throw new Error("Encryption key is not initialized. Set ENCRYPTION_KEY (or run setup).");
  }
  return row.encryptionKey;
}
