/**
 * DNS record canonicalization.
 *
 * Raw DNS answers come back with inconsistent spelling: trailing dots,
 * mixed case, different orderings, MX priorities inline in the data string,
 * presentation-format quotes on TXT/CAA values. Before anything is compared
 * or stored, every record is reduced to one canonical form so that two
 * queries with identical DNS state always produce identical data.
 */

import { isIP } from "node:net";
import type { DnsRecord, DnsRecordType } from "./types";

/**
 * Canonicalize a DNS hostname: lowercase, no surrounding whitespace, no
 * trailing dot. The root name "." is preserved (it is a valid DNS name and
 * appears as the exchange of null MX records, RFC 7505).
 */
export function canonicalizeHostname(value: string): string {
  const trimmed = value.trim();
  if (trimmed === ".") {
    return ".";
  }
  return trimmed.toLowerCase().replace(/\.$/, "");
}

export function isIPv4Address(value: string): boolean {
  return isIP(value) === 4;
}

export function isIPv6Address(value: string): boolean {
  return isIP(value) === 6;
}

/** Parsed MX record: preference + exchange (canonicalized). */
export interface CanonicalMx {
  priority: number;
  exchange: string;
}

/** Parsed CAA record: flags, tag and value, normalized to one string. */
export type CanonicalCaa = string;

export type CanonicalRecord = { ok: true; value: string; priority?: number } | { ok: false };

/**
 * Canonicalize one raw DNS answer's `data` string for a record type.
 *
 * Rules (per spec section 六):
 * - hostnames: lowercase, trailing dot removed, root "." preserved
 * - IP addresses: validated with Node's IP parser and kept in their
 *   canonical (resolver-provided) form
 * - MX: priority parsed separately from the exchange hostname
 * - TXT: content preserved verbatim (presentation-format quotes included —
 *   it is the wire representation, not decoration)
 * - CAA: `flags tag value` with the value's wrapping quotes stripped
 *
 * Returns `{ ok: false }` when the data cannot be parsed for that type.
 */
export function canonicalizeRecord(type: DnsRecordType, data: string): CanonicalRecord {
  const trimmed = data.trim();

  switch (type) {
    case "A": {
      if (!isIPv4Address(trimmed)) {
        return { ok: false };
      }
      return { ok: true, value: trimmed };
    }
    case "AAAA": {
      if (!isIPv6Address(trimmed)) {
        return { ok: false };
      }
      return { ok: true, value: trimmed };
    }
    case "CNAME":
    case "NS": {
      const hostname = canonicalizeHostname(trimmed);
      if (hostname.length === 0 || hostname === ".") {
        return { ok: false };
      }
      return { ok: true, value: hostname };
    }
    case "MX": {
      const parsed = parseMx(trimmed);
      if (!parsed) {
        return { ok: false };
      }
      return { ok: true, value: parsed.exchange, priority: parsed.priority };
    }
    case "TXT": {
      // Keep the exact string semantics — do not strip quotes or re-encode.
      return { ok: true, value: trimmed };
    }
    case "CAA": {
      const parsed = parseCaa(trimmed);
      if (!parsed) {
        return { ok: false };
      }
      return { ok: true, value: parsed };
    }
  }
}

/** Parse `"10 mail.example.com"` → `{ priority: 10, exchange: "mail.example.com" }`. */
export function parseMx(data: string): CanonicalMx | undefined {
  const match = /^(\d{1,5})\s+(\S+)$/.exec(data);
  if (!match) {
    return undefined;
  }
  const priority = Number(match[1]);
  if (!Number.isSafeInteger(priority) || priority < 0) {
    return undefined;
  }
  const exchange = canonicalizeHostname(match[2]);
  if (exchange.length === 0) {
    return undefined;
  }
  return { priority, exchange };
}

/**
 * Parse `"0 issue \"pki.goog\""` → `"0 issue pki.goog"`.
 * The value's wrapping quotes (presentation format) are stripped; interior
 * whitespace is preserved. The tag is lowercased.
 */
export function parseCaa(data: string): CanonicalCaa | undefined {
  const match = /^(\d{1,3})\s+([a-z0-9-]+)\s*(.*)$/i.exec(data);
  if (!match) {
    return undefined;
  }
  const flags = Number(match[1]);
  if (!Number.isInteger(flags) || flags < 0 || flags > 255) {
    return undefined;
  }
  const tag = match[2].toLowerCase();
  let value = match[3].trim();
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    value = value.slice(1, -1);
  }
  const normalized = value.length > 0 ? `${flags} ${tag} ${value}` : `${flags} ${tag}`;
  return normalized;
}

/**
 * Stable record ordering (canonical form). Order is not significant for
 * diffing (keys are compared as sets) but must be deterministic so that
 * identical DNS state always produces identical storage.
 */
export function sortRecords(records: DnsRecord[]): DnsRecord[] {
  return [...records].sort(compareRecords);
}

function compareRecords(a: DnsRecord, b: DnsRecord): number {
  if (a.type !== b.type) {
    return a.type < b.type ? -1 : 1;
  }
  if (a.type === "MX" && b.type === "MX") {
    const ap = a.priority ?? 0;
    const bp = b.priority ?? 0;
    if (ap !== bp) {
      return ap - bp;
    }
  }
  if (a.value < b.value) {
    return -1;
  }
  if (a.value > b.value) {
    return 1;
  }
  return 0;
}
