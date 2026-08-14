/**
 * HTTP health check types.
 *
 * An HTTP check produces scalar values — status code, response time,
 * redirect metadata — so the snapshot model is a single flat row (no
 * child tables, unlike DNS records or SSL certificates).
 *
 * `HttpStatus` distinguishes "the server responded" (ok / client_error /
 * server_error) from "the server is unreachable" (down) and transport or
 * internal failures (error).
 */

/**
 * Normalized outcome of an HTTP check:
 * - `ok`            — 2xx response received
 * - `client_error`  — 4xx response received (service is up, request invalid)
 * - `server_error`  — 5xx response received (service is up but failing)
 * - `down`          — connection failed (no reachable service)
 * - `error`         — transport error / internal failure (user-safe message)
 */
export type HttpStatus = "ok" | "client_error" | "server_error" | "down" | "error";

/** One HTTP check snapshot as stored for a domain. */
export interface HttpSnapshot {
  id: number;
  domainId: number;
  checkedAt: Date;
  status: HttpStatus;
  /** Final HTTP status code (present when a response was received). */
  httpStatus?: number;
  /** Total request time in milliseconds. */
  responseTimeMs?: number;
  /** Whether any redirect was followed. */
  redirected: boolean;
  /** Number of redirects followed. */
  redirectCount: number;
  /** Final URL after redirects. */
  finalUrl?: string;
  /** User-safe message when status is "error". */
  error?: string;
}

/**
 * Result of a manual HTTP check, as returned by the service layer.
 * HTTP checks have no change events (unlike DNS/SSL): the value of a check
 * is the current availability + status + response time, compared by the UI
 * against the previous snapshot. The first check is just as meaningful as
 * any later one.
 */
export type HttpCheckResult =
  { ok: true; snapshotId: number; checkedAt: Date } | { ok: false; error: string };
