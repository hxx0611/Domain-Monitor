/**
 * RDAP query orchestration.
 *
 * `queryRdap` wires bootstrap → client → parser into a single call:
 * hostname in, normalized `RdapDomainData` out. Options are injectable for
 * tests (mock bootstrap map + mock fetch).
 *
 * `queryRdapWithFallback` adds registered-domain resolution: when the full
 * hostname is not the registration level (e.g. a subdomain), it retries the
 * parent labels (e.g. `opusai.eu.cc` → `eu.cc`) and returns the first
 * successful result that carries an expiration date.
 */

import { loadBootstrapMap, findRdapEndpoint, type FetchLike } from "./bootstrap";
import { fetchRdapDomain, RdapError } from "./client";
import { parseRdapDomainResponse } from "./parser";
import type { RdapDomainData } from "./types";

export interface RdapQueryOptions {
  /** Pre-built bootstrap map (tests) — skips loading from IANA. */
  bootstrapMap?: Map<string, string>;
  /** Custom bootstrap fetcher (tests). */
  bootstrapFetcher?: FetchLike;
  /** Custom HTTP fetch (tests). */
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Whether the RDAP object returned by the query belongs to the monitored
 * hostname itself or to one of its parent (registered-domain) labels.
 *
 * Phase 10D — ownership semantics: a parent object's data (expiration,
 * registrar, nameservers, status, …) describes the registered domain, NOT
 * the queried child hostname, and must never be stored on the child's own
 * fields.
 */
export type RdapOwnership = "exact" | "parent";

export interface RdapOwnershipResult {
  /** Normalized RDAP data for the matched object. */
  data: RdapDomainData;
  /**
   * Canonical (lowercased, trailing-dot-stripped) identity of the RDAP
   * object that actually matched — i.e. `data.domainName`. Equal to the
   * queried hostname when `ownership === "exact"`, and to a parent label
   * (e.g. `eu.cc` for `opusai.eu.cc`) when `ownership === "parent"`.
   */
  matchedHostname: string;
  ownership: RdapOwnership;
}

/** Lowercase + strip a single trailing dot; RDAP LDH names are case-insensitive. */
function canonicalOf(hostname: string): string {
  return hostname.toLowerCase().replace(/\.+$/, "");
}

/**
 * Generate the RDAP lookup candidate list for a hostname, from the full
 * hostname down to the registered-domain level.
 *
 * Candidates are produced by progressively dropping the left-most label and
 * **always keep at least two labels** — a bare TLD (e.g. `cc`) is never a
 * candidate. No public-suffix list is hard-coded; the IANA bootstrap's
 * longest-suffix matching in `findRdapEndpoint` decides the registry.
 *
 * Examples:
 *   "chatgpt.com"        → ["chatgpt.com"]
 *   "opusai.eu.cc"       → ["opusai.eu.cc", "eu.cc"]
 *   "foo.example.com"    → ["foo.example.com", "example.com"]
 *   "foo.example.co.uk"  → ["foo.example.co.uk", "example.co.uk", "co.uk"]
 */
export function getRdapLookupCandidates(hostname: string): string[] {
  const labels = hostname
    .toLowerCase()
    .split(".")
    .filter((label) => label.length > 0);
  const candidates: string[] = [];
  // At least two labels must remain: `i` stops before the last label.
  for (let i = 0; i < labels.length - 1; i++) {
    candidates.push(labels.slice(i).join("."));
  }
  return candidates;
}

/**
 * Query RDAP for a hostname with registered-domain fallback.
 *
 * Candidate order: full hostname → drop left-most label → … → at least two
 * labels. The first candidate whose RDAP response is successful **and**
 * carries an `expirationDate` wins.
 *
 * Fallback is allowed only for:
 *   - `not-found` (HTTP 404 / no domain object)
 *   - a successful response with no `expirationDate`
 *
 * Service-level failures (`timeout`, `network`, `rate-limited`,
 * `server-error`, `invalid-response`, `no-bootstrap`) are **never** masked
 * by a parent query — they are rethrown immediately.
 *
 * When every candidate falls back (all not-found / no-expiration), the last
 * fallback error is thrown.
 *
 * Ownership semantics (Phase 10D): the result reports whether the matched
 * RDAP object belongs to the queried hostname itself (`"exact"`) or to one
 * of its parent labels (`"parent"`). The decision is made strictly from the
 * RDAP object's canonical/LDH identity (`data.domainName`), never merely
 * from "a fallback succeeded". A canonical-name mismatch (e.g. querying
 * `opusai.eu.cc` returns an object whose LDH name is `EU.CC`) is therefore
 * recognized as `ownership === "parent"` even when it happened on the first
 * candidate.
 */
export async function queryRdapWithFallback(
  hostname: string,
  options: RdapQueryOptions = {},
): Promise<RdapOwnershipResult> {
  const candidates = getRdapLookupCandidates(hostname);
  const queriedCanonical = canonicalOf(hostname);
  let lastFallbackError: RdapError | null = null;

  for (const candidate of candidates) {
    try {
      const data = await queryRdap(candidate, options);
      if (data.expirationDate) {
        // Ownership is decided by the object's own canonical identity.
        const matchedHostname = canonicalOf(data.domainName);
        const ownership: RdapOwnership = matchedHostname === queriedCanonical ? "exact" : "parent";
        return { data, matchedHostname, ownership };
      }
      // Successful query but no expiration at this level → try the parent
      // (the registered domain is one level up).
      lastFallbackError = new RdapError(
        `RDAP returned no expiration for "${candidate}".`,
        "not-found",
      );
      continue;
    } catch (error) {
      if (error instanceof RdapError && error.code === "not-found") {
        lastFallbackError = error;
        continue;
      }
      // timeout / network / rate-limited / server-error / invalid-response /
      // no-bootstrap → surface the real failure instead of masking it.
      throw error;
    }
  }

  throw lastFallbackError ?? new RdapError(`No RDAP data found for "${hostname}".`, "not-found");
}

/**
 * Fetch and normalize RDAP data for a hostname (single lookup, no fallback).
 *
 * Throws `RdapError` on any failure (no bootstrap entry, HTTP error,
 * timeout, network error, unparseable response).
 */
export async function queryRdap(
  hostname: string,
  options: RdapQueryOptions = {},
): Promise<RdapDomainData> {
  const bootstrapMap = options.bootstrapMap ?? (await loadBootstrapMap(options.bootstrapFetcher));

  const endpoint = findRdapEndpoint(bootstrapMap, hostname);
  if (!endpoint) {
    throw new RdapError(`No RDAP bootstrap entry found for "${hostname}".`, "no-bootstrap");
  }

  const raw = await fetchRdapDomain(endpoint, hostname, {
    fetchFn: options.fetchFn,
    timeoutMs: options.timeoutMs,
  });

  return parseRdapDomainResponse(raw);
}
