/**
 * HTTP health check feature module.
 *
 * Layering (UI → action → service → client → fetch):
 * - `actions` (server actions, client-safe import)
 * - `service` (orchestration, atomic checks, error snapshots)
 * - `repository` (database, server-only)
 * - `client` (HTTP transport with SSRF guards, injectable fetch + lookup)
 * - `normalize` (pure status classification)
 *
 * UI code must never call the client or repository directly.
 */

export { checkHttp } from "./service";
export type { HttpServiceOptions } from "./service";
export { HttpError } from "./client";
export type { HttpErrorCode, HttpClientOptions, RawHttpResult } from "./client";
export { fetchHttpStatus, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_REDIRECTS } from "./client";
export { classifyHttpStatus, isResponseStatus } from "./normalize";
export type { HttpSnapshot, HttpStatus, HttpCheckResult } from "./types";
