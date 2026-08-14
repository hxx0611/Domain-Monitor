/**
 * HTTP status classification.
 *
 * Pure functions that map raw HTTP outcomes to Domain Monitor's canonical
 * `HttpStatus`. No network, no database.
 *
 * `classifyHttpStatus` handles the case where a response WAS received;
 * `down` is not produced here — it is assigned by the service layer when
 * the connection itself fails (no response at all).
 */

import type { HttpStatus } from "./types";

/**
 * Classify an HTTP status code into the canonical outcome.
 *
 * - 2xx → `ok`
 * - 4xx → `client_error` (the server responded; the request was rejected)
 * - 5xx → `server_error` (the server responded but is failing)
 * - 3xx → `error` (a redirect as the FINAL response is a protocol anomaly —
 *   the client resolves redirects before this classifier runs, so a 3xx
 *   here means the redirect policy misbehaved)
 * - 1xx / 6xx / non-integer → `error` (not a valid final response)
 *
 * Note: `down` is intentionally not produced here — it describes a failed
 * connection, which has no status code. The service layer decides `down`
 * vs `error` based on the transport failure.
 */
export function classifyHttpStatus(statusCode: number): HttpStatus {
  if (!Number.isInteger(statusCode)) {
    return "error";
  }
  if (statusCode >= 200 && statusCode < 300) {
    return "ok";
  }
  if (statusCode >= 400 && statusCode < 500) {
    return "client_error";
  }
  if (statusCode >= 500 && statusCode < 600) {
    return "server_error";
  }
  return "error";
}

/** True when the normalized status means "the server responded". */
export function isResponseStatus(status: HttpStatus): boolean {
  return status === "ok" || status === "client_error" || status === "server_error";
}
