/**
 * Data access layer for SSL snapshots and certificates.
 *
 * All SSL database operations go through this module — UI code must never
 * touch the database directly. Functions accept an optional database handle
 * (defaulting to the app-wide instance) so tests can run against an
 * in-memory SQLite database. Mirrors the DNS repository design.
 */

import "server-only";

import { desc, eq, inArray } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { db } from "@/db";
import { sslCertificates, sslSnapshots, type Schema } from "@/db/schema";
import { insertNotificationEvents } from "@/lib/notifications/repository";
import type { NotificationEvent } from "@/lib/notifications/types";
import type { SslCertificate, SslSnapshot, SslStatus } from "./types";

export type SslDb = BetterSQLite3Database<Schema>;

/** Snapshot with its leaf certificate decoded into `SslCertificate`. */
export interface SslSnapshotWithCertificate extends Omit<SslSnapshot, "certificate"> {
  certificate?: SslCertificate;
}

/** Fields to persist for one SSL check. */
export interface NewSslCheckData {
  domainId: number;
  tlsVersion?: string;
  cipherName?: string;
  status: SslStatus;
  error?: string;
  certificate?: SslCertificate;
}

/**
 * Persist one SSL snapshot, its certificate, and any derived notification
 * events atomically. Returns the new snapshot id. A certificate is written
 * only when present (failed checks store just the snapshot row). Events are
 * inserted in the SAME transaction — if an event insert fails the snapshot
 * rolls back too (no lost events).
 */
export function createSslSnapshot(
  data: NewSslCheckData,
  target: SslDb = db,
  events: NotificationEvent[] = [],
): number {
  return target.transaction((tx) => {
    const snapshot = tx
      .insert(sslSnapshots)
      .values({
        domainId: data.domainId,
        tlsVersion: data.tlsVersion ?? null,
        cipherName: data.cipherName ?? null,
        status: data.status,
        error: data.error ?? null,
      })
      .returning({ id: sslSnapshots.id })
      .get();

    if (data.certificate) {
      tx.insert(sslCertificates)
        .values({
          snapshotId: snapshot.id,
          fingerprint256: data.certificate.fingerprint256,
          subject: data.certificate.subject ?? null,
          issuer: data.certificate.issuer ?? null,
          validFrom: data.certificate.validFrom ?? null,
          validTo: data.certificate.validTo ?? null,
          serialNumber: data.certificate.serialNumber ?? null,
          san: JSON.stringify(data.certificate.san),
          isSelfSigned: data.certificate.isSelfSigned ? 1 : 0,
          hostnameMatched: data.certificate.hostnameMatched ? 1 : 0,
        })
        .run();
    }

    insertNotificationEvents(tx, events);

    return snapshot.id;
  });
}

/** The most recent snapshot for a domain, or `undefined` when never checked. */
export function getLatestSslSnapshot(
  domainId: number,
  target: SslDb = db,
): SslSnapshotWithCertificate | undefined {
  const snapshot = target
    .select()
    .from(sslSnapshots)
    .where(eq(sslSnapshots.domainId, domainId))
    .orderBy(desc(sslSnapshots.checkedAt), desc(sslSnapshots.id))
    .limit(1)
    .get();

  if (!snapshot) {
    return undefined;
  }

  return {
    ...toSnapshotShape(snapshot),
    certificate: getCertificateForSnapshot(snapshot.id, target),
  };
}

/**
 * The `limit` most recent snapshots for a domain, newest first, each with
 * its certificate. Used by the SSL history list.
 */
export function getSslHistory(
  domainId: number,
  limit: number,
  target: SslDb = db,
): SslSnapshotWithCertificate[] {
  const snapshots = target
    .select()
    .from(sslSnapshots)
    .where(eq(sslSnapshots.domainId, domainId))
    .orderBy(desc(sslSnapshots.checkedAt), desc(sslSnapshots.id))
    .limit(limit)
    .all();

  if (snapshots.length === 0) {
    return [];
  }

  const ids = snapshots.map((snapshot) => snapshot.id);
  const rows = target
    .select()
    .from(sslCertificates)
    .where(inArray(sslCertificates.snapshotId, ids))
    .all();

  const bySnapshot = new Map<number, SslCertificate>();
  for (const row of rows) {
    bySnapshot.set(row.snapshotId, decodeCertificateRow(row));
  }

  return snapshots.map((snapshot) => ({
    ...toSnapshotShape(snapshot),
    certificate: bySnapshot.get(snapshot.id),
  }));
}

/** Map a DB snapshot row (nullable columns) to the domain type (optional fields). */
function toSnapshotShape(snapshot: {
  id: number;
  domainId: number;
  checkedAt: Date;
  tlsVersion: string | null;
  cipherName: string | null;
  status: string;
  error: string | null;
}): Omit<SslSnapshotWithCertificate, "certificate"> {
  return {
    id: snapshot.id,
    domainId: snapshot.domainId,
    checkedAt: snapshot.checkedAt,
    tlsVersion: snapshot.tlsVersion ?? undefined,
    cipherName: snapshot.cipherName ?? undefined,
    status: snapshot.status as SslStatus,
    error: snapshot.error ?? undefined,
  };
}

function getCertificateForSnapshot(snapshotId: number, target: SslDb): SslCertificate | undefined {
  const row = target
    .select()
    .from(sslCertificates)
    .where(eq(sslCertificates.snapshotId, snapshotId))
    .get();

  return row ? decodeCertificateRow(row) : undefined;
}

function decodeCertificateRow(row: {
  fingerprint256: string;
  subject: string | null;
  issuer: string | null;
  validFrom: string | null;
  validTo: string | null;
  serialNumber: string | null;
  san: string | null;
  isSelfSigned: number | null;
  hostnameMatched: number | null;
}): SslCertificate {
  return {
    fingerprint256: row.fingerprint256,
    subject: row.subject ?? undefined,
    issuer: row.issuer ?? undefined,
    validFrom: row.validFrom ?? undefined,
    validTo: row.validTo ?? undefined,
    serialNumber: row.serialNumber ?? undefined,
    san: decodeStringArray(row.san),
    isSelfSigned: row.isSelfSigned === 1,
    hostnameMatched: row.hostnameMatched === 1,
  };
}

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
