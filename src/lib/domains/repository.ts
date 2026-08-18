import "server-only";

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { domains, type Domain } from "@/db/schema";
import type { RdapDomainData, RdapOwnership } from "@/lib/rdap";

/**
 * Data access layer for domains.
 *
 * All database operations must go through this module — UI code must never
 * touch the database directly.
 */

/** Domain row with JSON-backed RDAP arrays decoded into real arrays. */
export type DomainWithRdap = Omit<Domain, "nameservers" | "rdapStatus"> & {
  nameservers: string[];
  rdapStatus: string[];
};

function decodeStringArray(raw: string | null): string[] {
  if (!raw) {
    return [];
  }
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function toDomainWithRdap(row: Domain): DomainWithRdap {
  return {
    ...row,
    nameservers: decodeStringArray(row.nameservers),
    rdapStatus: decodeStringArray(row.rdapStatus),
  };
}

export function getDomains(): DomainWithRdap[] {
  return db.select().from(domains).orderBy(domains.createdAt).all().map(toDomainWithRdap);
}

export function getDomainById(id: number): DomainWithRdap | undefined {
  const row = db.select().from(domains).where(eq(domains.id, id)).get();
  return row ? toDomainWithRdap(row) : undefined;
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

/**
 * Store normalized RDAP data for a domain. Returns `true` when the domain
 * exists and was updated. Only the fields we actually use are persisted —
 * the raw RDAP JSON is never stored.
 *
 * Ownership semantics (Phase 10D): the caller MUST pass the `ownership`
 * reported by `queryRdapWithFallback`.
 *
 *   - `"exact"` — the RDAP object belongs to this domain; all object fields
 *     (registrar, dates, nameservers, status) are stored as-is.
 *   - `"parent"` — the matched RDAP object belongs to a parent label (e.g.
 *     `eu.cc` for `opusai.eu.cc`). Parent-derived data describes the
 *     registered domain, NOT this domain, so it is NEVER written to the
 *     child's own fields: they are cleared and `rdapStatus` is marked
 *     `["no-object"]`. No schema change is needed; the check result is not
 *     persisted beyond that marker.
 */
export function updateDomainRdap(
  id: number,
  data: RdapDomainData,
  ownership: RdapOwnership,
): boolean {
  if (ownership !== "exact") {
    const row = db
      .update(domains)
      .set({
        registrar: null,
        registrationDate: null,
        expirationDate: null,
        updatedDate: null,
        rdapUpdatedAt: new Date(),
        nameservers: "[]",
        rdapStatus: JSON.stringify(["no-object"]),
      })
      .where(eq(domains.id, id))
      .returning({ id: domains.id })
      .get();

    return row !== undefined;
  }

  const row = db
    .update(domains)
    .set({
      registrar: data.registrar ?? null,
      registrationDate: data.registrationDate ?? null,
      expirationDate: data.expirationDate ?? null,
      updatedDate: data.updatedDate ?? null,
      rdapUpdatedAt: new Date(),
      nameservers: JSON.stringify(data.nameservers),
      rdapStatus: JSON.stringify(data.status),
    })
    .where(eq(domains.id, id))
    .returning({ id: domains.id })
    .get();

  return row !== undefined;
}
