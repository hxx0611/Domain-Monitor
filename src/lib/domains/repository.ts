import "server-only";

import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { db } from "@/db";
import {
  domains,
  expirationReminders,
  type Domain,
  type ExpirationReminder,
  type Schema,
} from "@/db/schema";
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

export function getDomains(target: BetterSQLite3Database<Schema> = db): DomainWithRdap[] {
  return target.select().from(domains).orderBy(domains.createdAt).all().map(toDomainWithRdap);
}

export function getDomainById(
  id: number,
  target: BetterSQLite3Database<Schema> = db,
): DomainWithRdap | undefined {
  const row = target.select().from(domains).where(eq(domains.id, id)).get();
  return row ? toDomainWithRdap(row) : undefined;
}

export function getDomainByHostname(
  hostname: string,
  target: BetterSQLite3Database<Schema> = db,
): Domain | undefined {
  return target.select().from(domains).where(eq(domains.hostname, hostname)).get();
}

/**
 * Insert a domain. Callers must pass a hostname already normalized by
 * `normalizeHostname`. Returns the created row, or `undefined` when the
 * hostname already exists (unique constraint).
 *
 * Phase 11A: optional manual-expiration fields. When `expirationSource` is
 * `"manual"`, the operator-supplied dates are persisted immediately; when
 * omitted, the domain starts as `"rdap"` (automatic) with no dates.
 */
export function createDomain(
  hostname: string,
  fields?: {
    expirationSource?: "rdap" | "manual";
    registrationDate?: string | null;
    expirationDate?: string | null;
    registrationProvider?: string | null;
    registrationProviderUrl?: string | null;
  },
  target: BetterSQLite3Database<Schema> = db,
): Domain | undefined {
  const existing = getDomainByHostname(hostname, target);
  if (existing) {
    return undefined;
  }

  const manual = fields?.expirationSource === "manual";
  return target
    .insert(domains)
    .values({
      hostname,
      expirationSource: manual ? "manual" : "rdap",
      registrationDate: manual ? (fields?.registrationDate ?? null) : null,
      expirationDate: manual ? (fields?.expirationDate ?? null) : null,
      registrationProvider: fields?.registrationProvider ?? null,
      registrationProviderUrl: fields?.registrationProviderUrl ?? null,
    })
    .returning()
    .get();
}

/**
 * Update a domain's manual-expiration and registration-platform fields
 * (Phase 11A). Returns `true` when the domain exists and was updated.
 *
 * - `expirationSource` "manual": the supplied `registrationDate` /
 *   `expirationDate` are stored (both optional, validated by the caller).
 * - `expirationSource` "rdap": manual dates are cleared and RDAP owns the
 *   dates again (a subsequent Refresh re-populates them).
 * - `registrationProvider` / `registrationProviderUrl`: free-form; URL is
 *   validated by the caller.
 */
export function updateDomain(
  id: number,
  fields: {
    expirationSource: "rdap" | "manual";
    registrationDate?: string | null;
    expirationDate?: string | null;
    registrationProvider?: string | null;
    registrationProviderUrl?: string | null;
  },
  target: BetterSQLite3Database<Schema> = db,
): boolean {
  const manual = fields.expirationSource === "manual";
  const row = target
    .update(domains)
    .set({
      expirationSource: manual ? "manual" : "rdap",
      registrationDate: manual ? (fields.registrationDate ?? null) : null,
      expirationDate: manual ? (fields.expirationDate ?? null) : null,
      registrationProvider: fields.registrationProvider ?? null,
      registrationProviderUrl: fields.registrationProviderUrl ?? null,
      updatedAt: new Date(),
    })
    .where(eq(domains.id, id))
    .returning({ id: domains.id })
    .get();

  return row !== undefined;
}

// ---------------------------------------------------------------------------
// Expiration reminders (Phase 11A-7/8)
// ---------------------------------------------------------------------------

/** All reminders for a domain, ascending by days-before. */
export function getExpirationReminders(
  domainId: number,
  target: BetterSQLite3Database<Schema> = db,
): ExpirationReminder[] {
  return target
    .select()
    .from(expirationReminders)
    .where(eq(expirationReminders.domainId, domainId))
    .orderBy(expirationReminders.daysBefore)
    .all();
}

/**
 * Replace a domain's reminder set atomically (delete + insert in one
 * transaction). Duplicate days are impossible (unique index + caller
 * normalization). An empty list clears all reminders. Returns the number
 * of reminders saved.
 */
export function setExpirationReminders(
  domainId: number,
  days: number[],
  target: BetterSQLite3Database<Schema> = db,
): number {
  return target.transaction((tx) => {
    tx.delete(expirationReminders).where(eq(expirationReminders.domainId, domainId)).run();
    if (days.length === 0) {
      return 0;
    }
    const inserted = tx
      .insert(expirationReminders)
      .values(days.map((daysBefore) => ({ domainId, daysBefore })))
      .returning({ id: expirationReminders.id })
      .all();
    return inserted.length;
  });
}

/** All (domainId → reminder days) pairs for domains with reminders. */
export function getAllExpirationReminders(
  target: BetterSQLite3Database<Schema> = db,
): { domainId: number; daysBefore: number }[] {
  return target
    .select({ domainId: expirationReminders.domainId, daysBefore: expirationReminders.daysBefore })
    .from(expirationReminders)
    .all();
}

/** Returns `true` when a row was deleted, `false` when the id did not exist. */
export function deleteDomain(id: number, target: BetterSQLite3Database<Schema> = db): boolean {
  const row = target.delete(domains).where(eq(domains.id, id)).returning({ id: domains.id }).get();

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
 *
 * Manual-expiration protection (Phase 11A-6): when `expirationSource` is
 * `"manual"`, the operator-maintained `expirationDate` (and its companion
 * `registrationDate`) are NEVER modified by an RDAP refresh — not by an
 * `exact` object, and especially not by a `parent` fallback (a parent's
 * expiration must never be attributed to the child). RDAP metadata
 * (`registrar`, `updatedDate`, `nameservers`, `rdapStatus`,
 * `rdapUpdatedAt`) is still refreshed under the same ownership rules.
 */
export function updateDomainRdap(
  id: number,
  data: RdapDomainData,
  ownership: RdapOwnership,
  target: BetterSQLite3Database<Schema> = db,
): boolean {
  const current = target.select().from(domains).where(eq(domains.id, id)).get();
  if (!current) {
    return false;
  }

  const manual = current.expirationSource === "manual";

  if (ownership !== "exact") {
    const row = target
      .update(domains)
      .set({
        registrar: null,
        // 10D: parent RDAP data never becomes the child's own dates. With a
        // manual source, the operator's dates are authoritative and stay.
        registrationDate: manual ? current.registrationDate : null,
        expirationDate: manual ? current.expirationDate : null,
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

  const row = target
    .update(domains)
    .set({
      registrar: data.registrar ?? null,
      // Manual source: operator dates win over RDAP dates (exact object).
      registrationDate: manual ? current.registrationDate : (data.registrationDate ?? null),
      expirationDate: manual ? current.expirationDate : (data.expirationDate ?? null),
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
