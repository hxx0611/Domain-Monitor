/**
 * SSL check orchestration.
 *
 * One check = one snapshot:
 * - Connect to the domain's 443 port, read the leaf certificate, normalize
 *   and classify it (ok / expires soon / expired / mismatch).
 * - A TLS failure writes an ERROR snapshot — the failure is recorded in
 *   history but never overwrites or deletes a previously stored
 *   certificate.
 * - The first successful check stores a snapshot without change events.
 * - A hostname mismatch does NOT block snapshot storage: mismatches are
 *   recorded, not silently dropped.
 */

import { getDomainById } from "@/lib/domains";
import { fetchSslCertificate, SslError, type SslClientOptions } from "./client";
import { diffSslSnapshots } from "./diff";
import { classifySslStatus, toSslCertificate } from "./normalize";
import { createSslSnapshot, getLatestSslSnapshot, type SslDb } from "./repository";
import { sslChangesToEvents } from "@/lib/notifications/events";
import { classifySslError } from "@/lib/monitoring/error-classifier";
import type { SslCheckResult, SslSnapshot } from "./types";

export interface SslServiceOptions {
  /** Per-connection TLS client options — tests inject a fake socket factory. */
  clientOptions?: SslClientOptions;
  /** Injectable database (tests). */
  db?: SslDb;
}

/** In-flight guard: prevents duplicate concurrent checks per domain. */
const inFlight = new Set<number>();

/**
 * Run a full SSL check for a stored domain.
 *
 * - `domainId` must reference an existing domain; otherwise
 *   `{ ok: false, error: "Domain not found." }`.
 * - A TLS failure writes an error snapshot and returns
 *   `{ ok: false, error: "SSL monitoring unavailable." }` — the previous
 *   successful certificate is preserved in history.
 * - Concurrent checks for the same domain are rejected (simple in-process
 *   guard — no distributed locking needed at this scale).
 */
export async function checkSsl(
  domainId: number,
  options: SslServiceOptions = {},
): Promise<SslCheckResult> {
  const domain = getDomainById(domainId);
  if (!domain) {
    return { ok: false, error: "Domain not found." };
  }

  if (inFlight.has(domainId)) {
    return { ok: false, error: "An SSL check is already in progress." };
  }
  inFlight.add(domainId);

  try {
    const previous = getLatestSslSnapshot(domainId, options.db);

    let raw: Awaited<ReturnType<typeof fetchSslCertificate>>;
    try {
      raw = await fetchSslCertificate(domain.hostname, options.clientOptions);
    } catch (error) {
      // Record the failure as an error snapshot; never touch prior data.
      // The snapshot stores the machine error code — the raw error message
      // (which may contain resolved addresses) stays in the server log.
      console.error(`[ssl] check failed for domain ${domainId} (${domain.hostname}):`, error);
      const errorCode = classifySslError(error);
      try {
        createSslSnapshot({ domainId, status: "error", error: errorCode }, options.db);
      } catch (dbError) {
        console.error(`[ssl] failed to persist error snapshot for domain ${domainId}:`, dbError);
      }
      return { ok: false, error: "SSL monitoring unavailable.", errorCode };
    }

    const certificate = toSslCertificate(raw.certificate, domain.hostname);
    const status = classifySslStatus(certificate);
    const checkedAt = new Date();

    const current: SslSnapshot = {
      id: 0,
      domainId,
      checkedAt,
      tlsVersion: raw.tlsVersion,
      cipherName: raw.cipherName,
      status,
      certificate,
    };
    // First check (no previous snapshot) → no change events.
    const changes = previous ? diffSslSnapshots(previous, current) : [];

    const snapshotId = createSslSnapshot(
      {
        domainId,
        tlsVersion: raw.tlsVersion,
        cipherName: raw.cipherName,
        status,
        certificate,
      },
      options.db,
      sslChangesToEvents({
        domainId,
        changes,
        previousStatus: previous?.status,
        currentStatus: status,
        occurredAt: checkedAt,
      }),
    );

    return { ok: true, snapshotId, checkedAt, changes };
  } finally {
    inFlight.delete(domainId);
  }
}

/** Re-exported for callers that want to distinguish error kinds. */
export { SslError };
