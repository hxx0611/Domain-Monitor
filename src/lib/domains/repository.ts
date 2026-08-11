import "server-only";

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { domains, type Domain } from "@/db/schema";

/**
 * Data access layer for domains.
 *
 * All database operations must go through this module — UI code must never
 * touch the database directly.
 */

export function getDomains(): Domain[] {
  return db.select().from(domains).orderBy(domains.createdAt).all();
}

export function getDomainById(id: number): Domain | undefined {
  return db.select().from(domains).where(eq(domains.id, id)).get();
}

export function getDomainByHostname(hostname: string): Domain | undefined {
  return db.select().from(domains).where(eq(domains.hostname, hostname)).get();
}

/**
 * Insert a domain. Callers must pass a hostname already normalized by
 * `normalizeHostname`. Returns the created row, or `undefined` when the
 * hostname already exists (unique constraint).
 */
export function createDomain(hostname: string): Domain | undefined {
  const existing = getDomainByHostname(hostname);
  if (existing) {
    return undefined;
  }

  return db.insert(domains).values({ hostname }).returning().get();
}

/** Returns `true` when a row was deleted, `false` when the id did not exist. */
export function deleteDomain(id: number): boolean {
  const row = db.delete(domains).where(eq(domains.id, id)).returning({ id: domains.id }).get();

  return row !== undefined;
}
