/**
 * Snapshot diffing.
 *
 * `diffDnsSnapshots` is a pure function: previous and current snapshots in,
 * a flat list of `DnsChange`s out. Records are compared by canonical key
 * (type + name + priority + value). TTL is deliberately not part of the key,
 * so a TTL-only change produces no change events.
 */

import type { DnsChange, DnsRecord, DnsSnapshot } from "./types";

/**
 * Compute the difference between two snapshots.
 *
 * - A record present in `current` but not `previous` → RECORD_ADDED.
 * - A record present in `previous` but not `current` → RECORD_REMOVED.
 * - A changed value surfaces as RECORD_REMOVED (old) + RECORD_ADDED (new);
 *   no artificial RECORD_CHANGED type is produced.
 * - An undefined `previous` (first check) yields no changes at all.
 */
export function diffDnsSnapshots(
  previous: DnsSnapshot | undefined,
  current: DnsSnapshot,
): DnsChange[] {
  if (!previous) {
    return [];
  }

  const previousKeys = new Set(previous.records.map(canonicalKey));
  const currentKeys = new Set(current.records.map(canonicalKey));

  const changes: DnsChange[] = [];

  for (const record of current.records) {
    if (!previousKeys.has(canonicalKey(record))) {
      changes.push({ type: "RECORD_ADDED", record });
    }
  }

  for (const record of previous.records) {
    if (!currentKeys.has(canonicalKey(record))) {
      changes.push({ type: "RECORD_REMOVED", record });
    }
  }

  return changes;
}

/** Stable identity of a record for change detection (TTL excluded). */
function canonicalKey(record: DnsRecord): string {
  return [record.type, record.name, record.priority ?? "", record.value].join("\u0000");
}
