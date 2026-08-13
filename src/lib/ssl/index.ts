/**
 * SSL monitoring feature module.
 *
 * Layering (UI → action → service → client → TLS):
 * - `actions` (server actions, client-safe import)
 * - `service` (orchestration, atomic checks, error snapshots)
 * - `repository` (database, server-only)
 * - `client` (TLS transport, injectable socket factory)
 * - `normalize` / `diff` (pure functions)
 *
 * UI code must never call the client or repository directly.
 */

export { checkSsl } from "./service";
export type { SslServiceOptions } from "./service";
export { SslError } from "./client";
export type { SslErrorCode, SslClientOptions, RawSslResult } from "./client";
export { fetchSslCertificate } from "./client";
export {
  toSslCertificate,
  classifySslStatus,
  daysRemaining,
  parseSan,
  parseCertDate,
  normalizeFingerprint,
  EXPIRY_WARNING_DAYS,
} from "./normalize";
export type { RawCertificateLike } from "./normalize";
export { diffSslSnapshots } from "./diff";
export type {
  SslCertificate,
  SslSnapshot,
  SslStatus,
  SslChange,
  SslChangeType,
  SslCheckResult,
} from "./types";
