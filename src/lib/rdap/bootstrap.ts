/**
 * IANA RDAP Bootstrap (dns.json) handling.
 *
 * The IANA bootstrap file maps domain suffixes (TLDs / public suffixes) to
 * the RDAP base URL of the authoritative registry. We build a suffix → URL
 * map from it and resolve the best (longest) suffix match for a hostname.
 *
 * See: https://www.iana.org/assignments/rdap-dns/dns.json
 */

import { RdapError } from "./client";

export const IANA_BOOTSTRAP_URL = "https://data.iana.org/rdap/dns.json";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

let cachedMap: Map<string, string> | null = null;

/**
 * Build a suffix → RDAP base URL map from the raw bootstrap JSON.
 * Pure function — no network access.
 */
export function buildSuffixMap(data: unknown): Map<string, string> {
  const map = new Map<string, string>();

  if (!isRecord(data)) {
    return map;
  }

  const services = data.services;
  if (!Array.isArray(services)) {
    return map;
  }

  for (const entry of services) {
    if (!Array.isArray(entry) || entry.length < 2) {
      continue;
    }

    // IANA format: a single-label suffix is a plain string ("com"); an
    // array lists several independent TLDs that share one endpoint
    // (["charity", "foundation", "org"] — each maps to the same URL).
    const suffixes = entry[0];
    const urls = entry[1];

    const suffixList =
      typeof suffixes === "string" ? [suffixes] : Array.isArray(suffixes) ? suffixes : null;

    if (!suffixList || !Array.isArray(urls)) {
      continue;
    }

    const endpoint = urls.find((u): u is string => typeof u === "string" && u.length > 0);
    if (!endpoint) {
      continue;
    }

    for (const suffix of suffixList) {
      if (typeof suffix === "string" && suffix.length > 0) {
        map.set(suffix.toLowerCase(), endpoint);
      }
    }
  }

  return map;
}

/**
 * Resolve the RDAP base URL for a hostname using longest-suffix matching.
 * Pure function — operates on a pre-built suffix map.
 *
 * `example.com`     → looks up `com`
 * `example.co.uk`   → tries `co.uk` first, then `uk`
 */
export function findRdapEndpoint(map: Map<string, string>, hostname: string): string | undefined {
  const labels = hostname.toLowerCase().split(".");

  // Try progressively shorter suffixes (longest match first).
  for (let i = 1; i < labels.length; i++) {
    const suffix = labels.slice(i).join(".");
    const endpoint = map.get(suffix);
    if (endpoint) {
      return endpoint;
    }
  }

  return undefined;
}

/**
 * Load the IANA bootstrap file (cached in-process for the default fetcher).
 * A custom fetcher bypasses the cache, which is what tests rely on.
 */
export async function loadBootstrapMap(fetcher: FetchLike = fetch): Promise<Map<string, string>> {
  if (fetcher === fetch && cachedMap) {
    return cachedMap;
  }

  let response: Response;
  try {
    response = await fetcher(IANA_BOOTSTRAP_URL);
  } catch {
    throw new RdapError("Failed to fetch IANA RDAP bootstrap data.", "network");
  }

  if (!response.ok) {
    throw new RdapError(`IANA RDAP bootstrap returned HTTP ${response.status}.`, "network");
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new RdapError("IANA RDAP bootstrap returned invalid JSON.", "invalid-response");
  }

  const map = buildSuffixMap(data);

  if (fetcher === fetch) {
    cachedMap = map;
  }

  return map;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
