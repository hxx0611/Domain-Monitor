/**
 * DNS check orchestration.
 *
 * One check = one atomic snapshot:
 * - All monitored record types are queried in parallel.
 * - If ANY type fails (network, timeout, resolver error), the whole check
 *   fails and NO snapshot is written — the previous snapshot is preserved
 *   and no change events are produced. This prevents a transient failure
 *   from looking like records were deleted.
 * - The first check for a domain stores a snapshot without change events.
 */

import type { Repository } from "@/db/repository";
import { getRepository } from "@/lib/runtime/repository";
import { queryDnsRecords, DnsError, type DnsClientOptions } from "./client";
import { diffDnsSnapshots } from "./diff";
import { sortRecords } from "./normalize";
import { dnsChangesToEvents } from "@/lib/notifications/events";
import { classifyDnsError } from "@/lib/monitoring/error-classifier";
import { DNS_RECORD_TYPES, type DnsCheckResult, type DnsRecord } from "./types";

export interface DnsServiceOptions {
  /** Per-query DoH client options (endpoint/timeout/fetch) — tests inject mocks here. */
  clientOptions?: DnsClientOptions;
  /** Injectable repository (tests). */
  repo?: Repository;
}

/** In-flight guard: prevents duplicate concurrent checks per domain. */
const inFlight = new Set<number>();

/**
 * Run a full DNS check for a stored domain.
 *
 * - `domainId` must reference an existing domain; otherwise
 *   `{ ok: false, error: "Domain not found." }`.
 * - All record types must succeed; any failure → `{ ok: false }` with a
 *   user-safe message and no database writes.
 * - Concurrent checks for the same domain are rejected (simple in-process
 *   guard — no distributed locking needed at this scale).
 */
export async function checkDns(
  domainId: number,
  options: DnsServiceOptions = {},
): Promise<DnsCheckResult> {
  const target = options.repo ?? (await getRepository());
  const domain = await target.getDomainById(domainId);
  if (!domain) {
    return { ok: false, error: "Domain not found." };
  }

  if (inFlight.has(domainId)) {
    return { ok: false, error: "A DNS check is already in progress." };
  }
  inFlight.add(domainId);

  try {
    // Parallel queries; any rejection fails the whole check.
    let grouped: DnsRecord[][];
    try {
      grouped = await Promise.all(
        DNS_RECORD_TYPES.map((type) =>
          queryDnsRecords(domain.hostname, type, options.clientOptions),
        ),
      );
    } catch (error) {
      console.error(`[dns] check failed for domain ${domainId} (${domain.hostname}):`, error);
      return {
        ok: false,
        error: "DNS monitoring unavailable.",
        errorCode: classifyDnsError(error),
      };
    }

    const records = sortRecords(grouped.flat());
    const checkedAt = new Date();

    const previous = await target.getLatestDnsSnapshot(domainId);
    const current = { id: 0, domainId, checkedAt, records };
    // First check (no previous snapshot) → no change events.
    const changes = previous ? diffDnsSnapshots(previous, current) : [];

    const snapshotId = await target.createDnsSnapshot(
      domainId,
      records,
      dnsChangesToEvents(domainId, changes, checkedAt),
    );

    return { ok: true, snapshotId, checkedAt, changes };
  } finally {
    inFlight.delete(domainId);
  }
}

/** Re-exported for callers that want to distinguish error kinds. */
export { DnsError };
