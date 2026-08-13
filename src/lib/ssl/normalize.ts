/**
 * SSL certificate normalization.
 *
 * Pure functions that convert a raw certificate (Node's X509Certificate
 * shape, or any object with the same fields) into Domain Monitor's canonical
 * `SslCertificate`, and classify its validity. No network, no database.
 *
 * The input is deliberately duck-typed (`RawCertificateLike`) so tests can
 * pass plain objects instead of real X509Certificate instances.
 */

import type { SslCertificate, SslStatus } from "./types";

/** The subset of Node's X509Certificate API that normalize needs. */
export interface RawCertificateLike {
  fingerprint256: string;
  subject?: string;
  issuer?: string;
  validFrom?: string;
  validTo?: string;
  serialNumber?: string;
  subjectAltName?: string;
  /** true when the certificate is self-signed. */
  ca?: boolean;
  /** Returns the matched SAN entry, or undefined when no match. */
  checkHost(hostname: string): string | undefined;
}

/** Days before expiry at which a certificate counts as "expires soon". */
export const EXPIRY_WARNING_DAYS = 30;

/**
 * Convert a raw certificate into the canonical `SslCertificate`.
 * `hostnameMatched` is derived from `checkHost` — a certificate whose SAN
 * does not cover the queried hostname is still stored (monitoring must
 * surface mismatches, not silently drop them).
 */
export function toSslCertificate(raw: RawCertificateLike, hostname: string): SslCertificate {
  return {
    fingerprint256: normalizeFingerprint(raw.fingerprint256),
    subject: raw.subject || undefined,
    issuer: raw.issuer || undefined,
    validFrom: parseCertDate(raw.validFrom),
    validTo: parseCertDate(raw.validTo),
    serialNumber: raw.serialNumber || undefined,
    san: parseSan(raw.subjectAltName),
    isSelfSigned: raw.ca === true,
    hostnameMatched: raw.checkHost(hostname) !== undefined,
  };
}

/**
 * Classify the overall check status from a normalized certificate.
 * A hostname mismatch takes precedence over validity — a mismatched
 * certificate is the more actionable signal. Otherwise the certificate is
 * classified by its remaining validity.
 */
export function classifySslStatus(
  cert: SslCertificate,
  now: Date = new Date(),
  warnDays: number = EXPIRY_WARNING_DAYS,
): SslStatus {
  if (!cert.hostnameMatched) {
    return "mismatch";
  }
  if (!cert.validTo) {
    return "ok";
  }
  const remaining = daysRemaining(new Date(cert.validTo), now);
  if (remaining < 0) {
    return "expired";
  }
  if (remaining <= warnDays) {
    return "expires_soon";
  }
  return "ok";
}

/**
 * Whole days between now and the certificate's expiry. Negative when
 * already expired; 0 means the certificate expires today (still valid, but
 * within the warning window).
 */
export function daysRemaining(validTo: Date, now: Date = new Date()): number {
  const ms = validTo.getTime() - now.getTime();
  return Math.floor(ms / 86_400_000);
}

/**
 * Parse a certificate date string into ISO 8601 (UTC).
 * Node's X509Certificate returns dates like "Oct 21 16:55:01 2026 GMT";
 * `new Date` parses that. Returns undefined for empty/unparseable input.
 */
export function parseCertDate(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  return date.toISOString();
}

/**
 * Parse a subjectAltName string into a canonical array of entries.
 * Input looks like "DNS:mozilla.org, DNS:www.mozilla.org, IP Address:1.2.3.4".
 * Entries are trimmed, deduplicated, and sorted for stable output.
 */
export function parseSan(subjectAltName?: string): string[] {
  if (!subjectAltName) {
    return [];
  }
  const entries = subjectAltName
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return [...new Set(entries)].sort();
}

/**
 * Normalize a SHA-256 fingerprint to canonical form:
 * uppercase, colon-separated hex octets ("AA:BB:..."). Accepts common
 * variants (lowercase, no separators, space-separated) and returns the
 * input unchanged if it cannot be parsed.
 */
export function normalizeFingerprint(fingerprint: string): string {
  const compact = fingerprint.replace(/[^0-9a-fA-F]/g, "");
  if (compact.length !== 64) {
    return fingerprint;
  }
  return compact.toUpperCase().match(/.{2}/g)!.join(":");
}
