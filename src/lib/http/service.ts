/**
 * HTTP health check orchestration.
 *
 * One check = one snapshot:
 * - GET `https://<hostname>/` and classify the outcome (ok / client_error /
 *   server_error / down).
 * - A transport / DNS / timeout / SSRF-blocked failure writes an ERROR
 *   snapshot — the failure is recorded in history but never overwrites or
 *   deletes a previously stored snapshot.
 *
 * SSRF posture: the hostname comes ONLY from the stored domain
 * (`getDomainById`). The service never accepts or constructs arbitrary
 * URLs — it hands the hostname to the client, whose per-hop SSRF guards
 * (manual redirects, DNS-resolved IP checks, same-host policy) remain the
 * second line of defense. This layer must not bypass or relax them.
 */

import type { Repository } from "@/db/repository";
import { getRepository } from "@/lib/runtime/repository";
import { fetchHttpStatus, HttpError, type HttpClientOptions } from "./client";
import { classifyHttpStatus } from "./normalize";
import { httpStatusChangeEvent } from "@/lib/notifications/events";
import { classifyHttpError } from "@/lib/monitoring/error-classifier";
import type { HttpCheckResult, HttpSnapshot } from "./types";

export interface HttpServiceOptions {
  /** Per-request client options — tests inject a fake fetch + lookup. */
  clientOptions?: HttpClientOptions;
  /** Injectable repository (tests). */
  repo?: Repository;
}

/** In-flight guard: prevents duplicate concurrent checks per domain. */
const inFlight = new Set<number>();

/**
 * Run a full HTTP check for a stored domain.
 *
 * - `domainId` must reference an existing domain; otherwise
 *   `{ ok: false, error: "Domain not found." }`.
 * - A transport failure writes an error snapshot and returns
 *   `{ ok: false, error: "HTTP monitoring unavailable." }` — the previous
 *   successful snapshot is preserved in history.
 * - A response IS recorded even for 4xx/5xx (the service is reachable);
 *   only connection-level failures produce `down`.
 * - Concurrent checks for the same domain are rejected (in-process guard).
 */
export async function checkHttp(
  domainId: number,
  options: HttpServiceOptions = {},
): Promise<HttpCheckResult> {
  const target = options.repo ?? (await getRepository());
  const domain = await target.getDomainById(domainId);
  if (!domain) {
    return { ok: false, error: "Domain not found." };
  }

  if (inFlight.has(domainId)) {
    return { ok: false, error: "An HTTP check is already in progress." };
  }
  inFlight.add(domainId);

  try {
    const previous = await target.getLatestHttpSnapshot(domainId);

    let raw: Awaited<ReturnType<typeof fetchHttpStatus>>;
    try {
      // hostname comes exclusively from the stored domain row.
      raw = await fetchHttpStatus(domain.hostname, options.clientOptions);
    } catch (error) {
      // Transport/DNS/timeout/SSRF-blocked → record an error snapshot;
      // never touch prior data. The status transition to "error" is still
      // an event-worthy change (e.g. ok → error). The snapshot stores the
      // machine error code only — the raw HttpError message may contain a
      // resolved address (blocked-redirect) and must never leave the log.
      console.error(`[http] check failed for domain ${domainId} (${domain.hostname}):`, error);
      const errorCode = classifyHttpError(error);
      const errorSnapshot: HttpSnapshot = {
        id: 0,
        domainId,
        checkedAt: new Date(),
        status: "error",
        redirected: false,
        redirectCount: 0,
        error: errorCode,
      };
      const errorEvent = httpStatusChangeEvent(
        domainId,
        previous,
        errorSnapshot,
        errorSnapshot.checkedAt,
      );
      try {
        await target.createHttpSnapshot(
          {
            domainId,
            status: "error",
            redirected: false,
            redirectCount: 0,
            error: errorCode,
          },
          errorEvent ? [errorEvent] : [],
        );
      } catch (dbError) {
        console.error(`[http] failed to persist error snapshot for domain ${domainId}:`, dbError);
      }
      return { ok: false, error: "HTTP monitoring unavailable.", errorCode };
    }

    const status = classifyHttpStatus(raw.status);
    const checkedAt = new Date();
    const current: HttpSnapshot = {
      id: 0,
      domainId,
      checkedAt,
      status,
      httpStatus: raw.status,
      responseTimeMs: raw.responseTimeMs,
      redirected: raw.redirected,
      redirectCount: raw.redirectCount,
      finalUrl: raw.finalUrl,
    };
    const event = httpStatusChangeEvent(domainId, previous, current, checkedAt);
    const snapshotId = await target.createHttpSnapshot(
      {
        domainId,
        status,
        httpStatus: raw.status,
        responseTimeMs: raw.responseTimeMs,
        redirected: raw.redirected,
        redirectCount: raw.redirectCount,
        finalUrl: raw.finalUrl,
      },
      event ? [event] : [],
    );

    return { ok: true, snapshotId, checkedAt };
  } finally {
    inFlight.delete(domainId);
  }
}

/** Re-exported for callers that want to distinguish error kinds. */
export { HttpError };
