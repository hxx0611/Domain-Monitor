/**
 * Node (self-hosted) SQLite repository singleton (Phase 14C-2C).
 *
 * This module MUST stay out of the Cloudflare worker bundle: it imports
 * `@/db`, which opens a better-sqlite3 native connection at module load
 * (`new Database(...)`). Only the Node runtime may import it — via the
 * lazy default branch of `getRepository()` in `@/lib/runtime/repository`
 * or via an explicit `setRepositoryFactory()` in the Node entry point.
 *
 * Tests that need their own repository instance should call
 * `createSQLiteRepository(createTestDb())` instead of this singleton.
 */

import { db } from "@/db";
import { createSQLiteRepository } from "./adapters/sqlite";
import type { Repository } from "./repository";

/** Process-lifetime SQLite repository for the Node runtime. */
export const nodeRepository: Repository = createSQLiteRepository(db);
