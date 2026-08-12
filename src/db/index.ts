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

export const db = drizzle(sqlite, { schema });
