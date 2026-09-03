/**
 * Data access layer for HTTP snapshots.
 *
 * All HTTP database operations go through this module — UI code must never
 * touch the database directly. Functions accept an optional database handle
 * (defaulting to the app-wide instance) so tests can run against an
 * in-memory SQLite database. Mirrors the DNS/SSL repository design, but
 * for the single-table HTTP snapshot model.
 */

import "server-only";

import { desc, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { db } from "@/db";
import { httpSnapshots, type Schema } from "@/db/schema";
import { insertEventsAndGenerateDeliveries } from "@/lib/notifications/event-deliveries";
import type { NotificationEvent } from "@/lib/notifications/types";
import type { HttpSnapshot, HttpStatus } from "./types";

export type HttpDb = BetterSQLite3Database<Schema>;

/** Fields to persist for one HTTP check. */
export interface NewHttpCheckData {
  domainId: number;
  status: HttpStatus;
  httpStatus?: number;
  responseTimeMs?: number;
  redirected: boolean;
  redirectCount: number;
  finalUrl?: string;
  error?: string;
}

/**
 * Persist one HTTP check snapshot and any derived notification events
 * atomically. Returns the new snapshot id. Events are inserted in the SAME
 * transaction — if an event insert fails the snapshot rolls back too (no
 * lost events).
 */
export function createHttpSnapshot(
  data: NewHttpCheckData,
  target: HttpDb = db,
  events: NotificationEvent[] = [],
): number {
  return target.transaction((tx) => {
    const row = tx
      .insert(httpSnapshots)
      .values({
        domainId: data.domainId,
        status: data.status,
        httpStatus: data.httpStatus ?? null,
        responseTimeMs: data.responseTimeMs ?? null,
        redirected: data.redirected ? 1 : 0,
        redirectCount: data.redirectCount,
        finalUrl: data.finalUrl ?? null,
        error: data.error ?? null,
      })
      .returning({ id: httpSnapshots.id })
      .get();

    insertEventsAndGenerateDeliveries(tx, events);

    return row.id;
  });
}

/** The most recent snapshot for a domain, or `undefined` when never checked. */
export function getLatestHttpSnapshot(
  domainId: number,
  target: HttpDb = db,
): HttpSnapshot | undefined {
  const snapshot = target
    .select()
    .from(httpSnapshots)
    .where(eq(httpSnapshots.domainId, domainId))
    .orderBy(desc(httpSnapshots.checkedAt), desc(httpSnapshots.id))
    .limit(1)
    .get();

  return snapshot ? toSnapshotShape(snapshot) : undefined;
}

/**
 * The `limit` most recent snapshots for a domain, newest first.
 * Used by the HTTP history list.
 */
export function getHttpHistory(
  domainId: number,
  limit: number,
  target: HttpDb = db,
): HttpSnapshot[] {
  const snapshots = target
    .select()
    .from(httpSnapshots)
    .where(eq(httpSnapshots.domainId, domainId))
    .orderBy(desc(httpSnapshots.checkedAt), desc(httpSnapshots.id))
    .limit(limit)
    .all();

  return snapshots.map(toSnapshotShape);
}

/** Map a DB row (nullable columns) to the domain type (optional fields). */
function toSnapshotShape(snapshot: {
  id: number;
  domainId: number;
  checkedAt: Date;
  status: string;
  httpStatus: number | null;
  responseTimeMs: number | null;
  redirected: number | null;
  redirectCount: number | null;
  finalUrl: string | null;
  error: string | null;
}): HttpSnapshot {
  return {
    id: snapshot.id,
    domainId: snapshot.domainId,
    checkedAt: snapshot.checkedAt,
    status: snapshot.status as HttpStatus,
    httpStatus: snapshot.httpStatus ?? undefined,
    responseTimeMs: snapshot.responseTimeMs ?? undefined,
    redirected: snapshot.redirected === 1,
    redirectCount: snapshot.redirectCount ?? 0,
    finalUrl: snapshot.finalUrl ?? undefined,
    error: snapshot.error ?? undefined,
  };
}
