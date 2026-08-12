/**
 * DNS-over-HTTPS client.
 *
 * The resolver is deliberately abstracted: the business layer only sees
 * `queryDnsRecords(hostname, type)`. The default endpoint is Cloudflare's
 * public DoH JSON service (stable, free, no API key, fair-use policy), and
 * it can be swapped via `DNS_DOH_ENDPOINT` or per-call options without
 * touching any other layer.
 *
 * SSRF guard: the queried hostname always comes from an already-stored,
 * validated domain — never from free-form user input — and the endpoint
 * comes from trusted configuration, never from the caller.
 */

import { canonicalizeHostname, canonicalizeRecord, sortRecords } from "./normalize";
import type { DnsRecord, DnsRecordType } from "./types";

/** Default public DoH JSON endpoint (Cloudflare). */
export const DEFAULT_DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";

/** Alternate endpoint accepted by the same client (Google, format-compatible). */
export const ALTERNATE_DOH_ENDPOINT = "https://dns.google/resolve";

/** DNS wire record type numbers (RFC 1035 / RFC 3596 / RFC 6844). */
export const DNS_TYPE_NUMBERS: Record<DnsRecordType, number> = {
  A: 1,
  NS: 2,
  CNAME: 5,
  MX: 15,
  TXT: 16,
  AAAA: 28,
  CAA: 257,
};

export type DnsErrorCode = "network" | "timeout" | "invalid-response" | "resolver-error";

export class DnsError extends Error {
  readonly code: DnsErrorCode;

  constructor(message: string, code: DnsErrorCode) {
    super(message);
    this.name = "DnsError";
    this.code = code;
  }
}

export interface DnsClientOptions {
  /** DoH base URL. Defaults to `DNS_DOH_ENDPOINT` env or Cloudflare. */
  endpoint?: string;
  /** Hard timeout per request (default 8s). */
  timeoutMs?: number;
  /** Injectable fetch for tests. */
  fetchFn?: typeof fetch;
}

/**
 * Query one record type for a hostname over DoH.
 * Returns canonicalized records (sorted), or an empty array when the name
 * has no records of that type. Throws `DnsError` on transport errors,
 * resolver errors (SERVFAIL/REFUSED), or malformed responses.
 */
export async function queryDnsRecords(
  hostname: string,
  type: DnsRecordType,
  options: DnsClientOptions = {},
): Promise<DnsRecord[]> {
  const endpoint = options.endpoint ?? process.env.DNS_DOH_ENDPOINT ?? DEFAULT_DOH_ENDPOINT;
  const { timeoutMs = 8_000, fetchFn = fetch } = options;

  const url = `${endpoint.replace(/\/+$/, "")}?name=${encodeURIComponent(hostname)}&type=${
    DNS_TYPE_NUMBERS[type]
  }`;

  let response: Response;
  try {
    response = await fetchFn(url, {
      headers: { Accept: "application/dns-json" },
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  } catch (error) {
    throw mapFetchError(error);
  }

  if (!response.ok) {
    throw new DnsError(`DoH server returned HTTP ${response.status}.`, "network");
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new DnsError("DoH server returned invalid JSON.", "invalid-response");
  }

  return parseDoHResponse(raw, hostname, type);
}

/**
 * Parse a DoH JSON response into canonical records for the requested type.
 * Status 0 (NOERROR) and 3 (NXDOMAIN) are treated as successful queries —
 * the latter simply means "no records". Any other status is a resolver
 * error, which must fail the whole check (atomic snapshot requirement).
 */
export function parseDoHResponse(raw: unknown, hostname: string, type: DnsRecordType): DnsRecord[] {
  if (!isRecord(raw)) {
    throw new DnsError("DoH response is not an object.", "invalid-response");
  }

  const status = raw.Status;
  if (typeof status !== "number") {
    throw new DnsError("DoH response has no numeric Status.", "invalid-response");
  }
  if (status !== 0 && status !== 3) {
    throw new DnsError(`DoH resolver returned status ${status}.`, "resolver-error");
  }

  const answers = raw.Answer;
  if (!Array.isArray(answers)) {
    return [];
  }

  const name = canonicalizeHostname(hostname);
  const records: DnsRecord[] = [];

  for (const answer of answers) {
    if (!isRecord(answer) || answer.type !== DNS_TYPE_NUMBERS[type]) {
      continue;
    }
    if (typeof answer.data !== "string" || answer.data.length === 0) {
      continue;
    }

    const canonical = canonicalizeRecord(type, answer.data);
    if (!canonical.ok) {
      continue;
    }

    records.push({
      type,
      name,
      value: canonical.value,
      ...(canonical.priority !== undefined ? { priority: canonical.priority } : {}),
      ...(typeof answer.TTL === "number" && Number.isFinite(answer.TTL) ? { ttl: answer.TTL } : {}),
    });
  }

  return sortRecords(records);
}

function mapFetchError(error: unknown): DnsError {
  if (error instanceof Error) {
    // AbortSignal.timeout() rejects with a DOMException named "TimeoutError".
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return new DnsError("DoH request timed out.", "timeout");
    }
  }
  return new DnsError("DoH request failed (network error).", "network");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
