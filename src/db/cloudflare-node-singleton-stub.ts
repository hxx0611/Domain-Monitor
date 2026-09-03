/**
 * Cloudflare worker build stub for `@/db/node-singleton` (Phase 14C-2C).
 *
 * During a Cloudflare/OpenNext build (`OPENNEXT_CLOUDFLARE=1`), next.config
 * aliases `@/db/node-singleton` to this file so the real SQLite singleton
 * (and therefore `@/db` → `new Database(...)` → better-sqlite3) never
 * enters the worker bundle. The Cloudflare worker registers a D1 factory
 * via `setRepositoryFactory()` and never touches this stub at runtime.
 *
 * If code ever DOES reach it in the worker, it throws loudly instead of
 * silently accessing SQLite.
 */

import type { Repository } from "./repository";

function forbidden(): never {
  throw new Error(
    "CLOUDFLARE_SQLITE_FORBIDDEN: @/db/node-singleton must not be loaded in the Cloudflare worker runtime",
  );
}

export const nodeRepository: Repository = new Proxy({} as Repository, {
  get(): never {
    return forbidden();
  },
});
