import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { schema } from "./schema";

// In Phase 2+, connection options (e.g. WAL mode, pragmas) will live here.
const sqlite = new Database(process.env.DATABASE_URL || "./data/domain-monitor.db");

export const db = drizzle(sqlite, { schema });
