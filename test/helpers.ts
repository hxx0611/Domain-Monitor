/**
 * Test helper: in-memory SQLite database with the full migration history
 * applied. Used by repository and service tests.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { schema } from "@/db/schema";
import type { DnsDb } from "@/lib/dns/repository";

export function createTestDb(): DnsDb {
  const sqlite = new Database(":memory:");

  const migrationsDir = path.join(process.cwd(), "src/db/migrations");
  const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  for (const file of files) {
    sqlite.exec(readFileSync(path.join(migrationsDir, file), "utf8"));
  }

  sqlite.pragma("foreign_keys = ON");
  return drizzle(sqlite, { schema });
}
