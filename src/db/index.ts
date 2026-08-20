import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { schema } from "./schema";

const databaseUrl = process.env.DATABASE_URL || "./data/domain-monitor.db";

// SQLite cannot create a database file whose parent directory does not
// exist. Ensure the directory is present before opening the file, so the
// app works in a fresh checkout (e.g. CI) without manual setup.
// `:memory:` databases have no file path and are skipped.
if (databaseUrl !== ":memory:") {
  mkdirSync(dirname(databaseUrl), { recursive: true });
}

const sqlite = new Database(databaseUrl);

// SQLite disables foreign keys by default. We rely on ON DELETE CASCADE to
// clean up DNS snapshots/records when a domain is deleted, so enable them.
sqlite.pragma("foreign_keys = ON");

// V0.7: the delivery worker is a second process writing the same SQLite
// file (next server + worker). Without a busy timeout, a concurrent write
// fails immediately with SQLITE_BUSY; 5s lets the other writer finish.
sqlite.pragma("busy_timeout = 5000");

export const db = drizzle(sqlite, { schema });

/**
 * Close the module-level SQLite connection.
 *
 * Production code never calls this — the connection lives for the whole
 * process. Tests that point `DATABASE_URL` at a temp-file database must
 * call it before deleting the temp directory: Windows cannot unlink a file
 * that a native handle still holds open (EPERM), while Linux allows it and
 * masks the leak.
 */
export function closeDb(): void {
  sqlite.close();
}
