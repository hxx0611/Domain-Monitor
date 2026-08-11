/**
 * RDAP query orchestration.
 *
 * `queryRdap` wires bootstrap → client → parser into a single call:
 * hostname in, normalized `RdapDomainData` out. Options are injectable for
 * tests (mock bootstrap map + mock fetch).
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
 * Fetch and normalize RDAP data for a hostname.
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
