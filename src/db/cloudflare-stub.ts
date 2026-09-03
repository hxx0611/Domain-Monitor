/**
 * Cloudflare worker build stub for `@/db` (Phase 14C-2C).
 *
 * During a Cloudflare/OpenNext build (`OPENNEXT_CLOUDFLARE=1`), the
 * tsconfig paths (`tsconfig.cf.json`) redirect `@/db` and
 * `@/db/node-singleton` to this file so the real SQLite connection
 * (`new Database(...)` → better-sqlite3) never enters the worker bundle.
 * The Cloudflare worker registers a D1 factory via `setRepositoryFactory()`
 * and never touches this stub at runtime.
 *
 * The stub keeps the exact public type of the real `@/db` module
 * (`BetterSQLite3Database<typeof schema>`) via type-only imports, so every
 * consumer (admin-db.ts, legacy feature repositories, node-singleton.ts…)
 * still type-checks in the Cloudflare build — while the type imports are
 * erased at compile time and nothing SQLite-related lands in the bundle.
 */

import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { schema } from "./schema";

type Schema = typeof schema;

function forbidden(): never {
  throw new Error(
    "CLOUDFLARE_SQLITE_FORBIDDEN: @/db must not be loaded in the Cloudflare worker runtime",
  );
}

export const db = new Proxy(
  {},
  { get: forbidden, apply: forbidden, construct: forbidden },
) as BetterSQLite3Database<Schema>;

export function closeDb(): void {
  forbidden();
}
