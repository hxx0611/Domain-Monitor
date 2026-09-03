/**
 * Data access layer for DNS snapshots and records.
 *
 * All DNS database operations go through this module — UI code must never
 * touch the database directly. Functions accept an optional database handle
 * (defaulting to the app-wide instance) so tests can run against an
 * in-memory SQLite database.
 */

import "server-only";

import { desc, eq, inArray } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { db } from "@/db";
import { dnsRecords, dnsSnapshots, type Schema } from "@/db/schema";
import { insertEventsAndGenerateDeliveries } from "@/lib/notifications/event-deliveries";
import type { NotificationEvent } from "@/lib/notifications/types";
import type { DnsRecord, DnsSnapshot } from "./types";

export type DnsDb = BetterSQLite3Database<Schema>;

/** Snapshot with its records decoded into `DnsRecord[]`. */
export interface DnsSnapshotWithRecords extends Omit<DnsSnapshot, "records"> {
  records: DnsRecord[];
}

/**
 * Persist one snapshot, its records, and any derived notification events
 * atomically. Returns the new snapshot id. Callers must ensure the domain
 * exists (FK enforced). Events are inserted in the SAME transaction — if
 * an event insert fails the snapshot rolls back too (no lost events).
 */
export function createDnsSnapshot(
  domainId: number,
  records: DnsRecord[],
  target: DnsDb = db,
  events: NotificationEvent[] = [],
): number {
  return target.transaction((tx) => {
    const snapshot = tx
      .insert(dnsSnapshots)
      .values({ domainId })
      .returning({ id: dnsSnapshots.id })
      .get();

    if (records.length > 0) {
      tx.insert(dnsRecords)
        .values(
          records.map((record) => ({
            snapshotId: snapshot.id,
            type: record.type,
            name: record.name,
            value: record.value,
            priority: record.priority ?? null,
            ttl: record.ttl ?? null,
          })),
        )
        .run();
    }

    insertEventsAndGenerateDeliveries(tx, events);

    return snapshot.id;
  });
}

/** The most recent snapshot for a domain, or `undefined` when never checked. */
export function getLatestDnsSnapshot(
  domainId: number,
  target: DnsDb = db,
): DnsSnapshotWithRecords | undefined {
  const snapshot = target
    .select()
    .from(dnsSnapshots)
    .where(eq(dnsSnapshots.domainId, domainId))
    .orderBy(desc(dnsSnapshots.checkedAt), desc(dnsSnapshots.id))
    .limit(1)
    .get();

  if (!snapshot) {
    return undefined;
  }

  return { ...snapshot, records: getRecordsForSnapshot(snapshot.id, target) };
}

/**
 * The `limit` most recent snapshots for a domain, newest first, each with
 * its records. Used by the history list.
 */
export function getDnsSnapshots(
  domainId: number,
  limit: number,
  target: DnsDb = db,
): DnsSnapshotWithRecords[] {
  const snapshots = target
    .select()
    .from(dnsSnapshots)
    .where(eq(dnsSnapshots.domainId, domainId))
    .orderBy(desc(dnsSnapshots.checkedAt), desc(dnsSnapshots.id))
    .limit(limit)
    .all();

  if (snapshots.length === 0) {
    return [];
  }

  const ids = snapshots.map((snapshot) => snapshot.id);
  const rows = target.select().from(dnsRecords).where(inArray(dnsRecords.snapshotId, ids)).all();

  const bySnapshot = new Map<number, DnsRecord[]>();
  for (const row of rows) {
    const list = bySnapshot.get(row.snapshotId) ?? [];
    list.push({
      type: row.type as DnsRecord["type"],
      name: row.name,
      value: row.value,
      ...(row.priority !== null ? { priority: row.priority } : {}),
      ...(row.ttl !== null ? { ttl: row.ttl } : {}),
    });
    bySnapshot.set(row.snapshotId, list);
  }

  return snapshots.map((snapshot) => ({
    ...snapshot,
    records: bySnapshot.get(snapshot.id) ?? [],
  }));
}

function getRecordsForSnapshot(snapshotId: number, target: DnsDb): DnsRecord[] {
  const rows = target.select().from(dnsRecords).where(eq(dnsRecords.snapshotId, snapshotId)).all();

  return rows.map((row) => ({
    type: row.type as DnsRecord["type"],
    name: row.name,
    value: row.value,
    ...(row.priority !== null ? { priority: row.priority } : {}),
    ...(row.ttl !== null ? { ttl: row.ttl } : {}),
  }));
}
