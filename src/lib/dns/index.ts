/**
 * DNS monitoring feature module.
 *
 * Layering (UI → action → service → client → resolver):
 * - `actions` (server actions, client-safe import)
 * - `service` (orchestration, atomic checks)
 * - `repository` (database, server-only)
 * - `client` (DoH transport, injectable)
 * - `normalize` / `diff` (pure functions)
 *
 * UI code must never call the client or repository directly.
 */

export { checkDns } from "./service";
export type { DnsServiceOptions } from "./service";
export { DnsError } from "./client";
export type { DnsErrorCode, DnsClientOptions } from "./client";
export { queryDnsRecords, DEFAULT_DOH_ENDPOINT, ALTERNATE_DOH_ENDPOINT } from "./client";
export {
  canonicalizeHostname,
  canonicalizeRecord,
  parseMx,
  parseCaa,
  sortRecords,
  isIPv4Address,
  isIPv6Address,
} from "./normalize";
export type { CanonicalMx, CanonicalCaa, CanonicalRecord } from "./normalize";
export { diffDnsSnapshots } from "./diff";
export { DNS_RECORD_TYPES } from "./types";
export type {
  DnsRecord,
  DnsRecordType,
  DnsSnapshot,
  DnsChange,
  DnsChangeType,
  DnsCheckResult,
} from "./types";
