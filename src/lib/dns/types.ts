/**
 * DNS monitoring types.
 *
 * `DnsRecord` is Domain Monitor's own canonical record shape — it never
 * mirrors the raw DoH JSON. The resolver's wire format is parsed and
 * canonicalized in the client/normalize layer; everything above this module
 * only ever sees these types.
 */

import type { DnsErrorCode } from "@/lib/monitoring/error-classifier";

/** Record types monitored in V0.3. Order doubles as display order. */
export const DNS_RECORD_TYPES = ["A", "AAAA", "CNAME", "MX", "NS", "TXT", "CAA"] as const;

export type DnsRecordType = (typeof DNS_RECORD_TYPES)[number];

/** A single canonicalized DNS record. */
export interface DnsRecord {
  type: DnsRecordType;
  /** Owner name, canonicalized (lowercase, no trailing dot). */
  name: string;
  /** Canonicalized record data (see normalize.ts). */
  value: string;
  /** MX preference only; undefined for every other record type. */
  priority?: number;
  /**
   * TTL in seconds. Persisted for display but deliberately excluded from
   * change detection — a TTL-only change must not produce a change event.
   */
  ttl?: number;
}

/** A full DNS snapshot as stored for one check. */
export interface DnsSnapshot {
  id: number;
  domainId: number;
  checkedAt: Date;
  records: DnsRecord[];
}

/** Changes are deliberately coarse: added / removed only. */
export type DnsChangeType = "RECORD_ADDED" | "RECORD_REMOVED";

export interface DnsChange {
  type: DnsChangeType;
  record: DnsRecord;
}

/** Result of a manual DNS check, as returned by the service layer. */
export type DnsCheckResult =
  | {
      ok: true;
      snapshotId: number;
      checkedAt: Date;
      /** Empty on the first check (no previous snapshot to diff against). */
      changes: DnsChange[];
    }
  | { ok: false; error: string; errorCode?: DnsErrorCode };
