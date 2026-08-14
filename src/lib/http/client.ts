/**
 * HTTP health check client.
 *
 * SSRF guard is the FIRST-class concern of this module, before any
 * functionality:
 *
 * - The initial request is always `https://<hostname>/` — the hostname is
 *   expected to come from an already-stored, validated domain (the service
 *   layer enforces this); the client never accepts an arbitrary URL.
 * - `redirect: "manual"` — redirects are resolved by hand, and EVERY hop is
 *   re-validated before being followed. fetch's default `follow` behavior
 *   is explicitly NOT used as a security boundary.
 * - Every target host (initial AND each redirect) is resolved via DNS and
 *   every resolved IP is checked against reserved/private ranges. Checking
 *   the URL hostname string is NOT enough: a public-looking hostname that
 *   resolves to an internal IP is still blocked.
 * - Redirect targets must use http/https and must stay on the initial
 *   hostname. Non-http schemes and cross-host redirects are blocked.
 * - At most 5 redirects are followed; exceeding that is an error.
 *
 * Errors are classified: `blocked-redirect` (SSRF/validation rejection),
 * `too-many-redirects`, `timeout`, `dns`, `network`, `invalid-url`.
 */

import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

export type HttpErrorCode =
  "timeout" | "network" | "dns" | "invalid-url" | "too-many-redirects" | "blocked-redirect";

export class HttpError extends Error {
  readonly code: HttpErrorCode;

  constructor(message: string, code: HttpErrorCode) {
    super(message);
    this.name = "HttpError";
    this.code = code;
  }
}

/** Raw HTTP check result (status + timing + redirect metadata). */
export interface RawHttpResult {
  /** Final HTTP status code. */
  status: number;
  statusText: string;
  /** Total time in milliseconds (start → final response headers). */
  responseTimeMs: number;
  /** Whether any redirect was followed. */
  redirected: boolean;
  redirectCount: number;
  /** Final URL after redirects (always https://<hostname>/ on success). */
  finalUrl: string;
}

export interface HttpClientOptions {
  /** Hard timeout per request (default 8s). */
  timeoutMs?: number;
  /** Maximum redirects to follow (default 5). */
  maxRedirects?: number;
  /** Injectable fetch for tests. */
  fetchFn?: typeof fetch;
  /**
   * Injectable DNS resolver for tests: hostname → IP addresses.
   * Defaults to Node's `dns/promises.lookup` with `all: true`.
   */
  lookup?: (hostname: string) => Promise<string[]>;
}

export const DEFAULT_TIMEOUT_MS = 8_000;
export const DEFAULT_MAX_REDIRECTS = 5;
const USER_AGENT = "Domain-Monitor/0.5 (+https://github.com/hxx0611/Domain-Monitor)";

// ---------------------------------------------------------------------------
// SSRF guards (pure, unit-testable)
// ---------------------------------------------------------------------------

/**
 * True when an IPv4 address is reserved / private / link-local / multicast /
 * CGNAT / benchmark / otherwise unsafe to reach from a monitoring check.
 */
export function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return true;
  }
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmark
  if (a >= 224) return true; // 224.0.0.0/4 multicast, 240.0.0.0/4 reserved, broadcast
  return false;
}

/**
 * True when an IPv6 address is loopback / unspecified / ULA / link-local /
 * IPv4-mapped to a blocked IPv4 / NAT64 / documentation range.
 */
export function isBlockedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::" || lower === "::1") return true; // unspecified + loopback
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // fc00::/7 ULA
  if (
    lower.startsWith("fe8") ||
    lower.startsWith("fe9") ||
    lower.startsWith("fea") ||
    lower.startsWith("feb")
  ) {
    return true; // fe80::/10 link-local
  }
  // ::ffff:0:0/96 IPv4-mapped → re-check the embedded IPv4.
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) {
    return isBlockedIpv4(mapped[1]);
  }
  if (lower.startsWith("64:ff9b:")) return true; // 64:ff9b::/96 NAT64
  if (lower.startsWith("2001:db8:")) return true; // 2001:db8::/32 documentation
  return false;
}

/** True when an IP address (v4 or v6) is blocked. Non-IP input is blocked. */
export function isBlockedIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) {
    return isBlockedIpv4(ip);
  }
  if (version === 6) {
    return isBlockedIpv6(ip);
  }
  return true;
}

/**
 * Resolve a hostname and reject it when ANY resolved address is blocked.
 * Checking only the URL hostname string is insufficient — a hostname that
 * looks public but resolves (fully or partially) to an internal address is
 * still rejected. This is the core DNS-rebinding defense.
 *
 * Throws `HttpError("dns")` when resolution fails and
 * `HttpError("blocked-redirect")` when any address is blocked.
 */
export async function assertSafeHost(
  hostname: string,
  lookup: (hostname: string) => Promise<string[]> = defaultLookup,
): Promise<void> {
  let addresses: string[];
  try {
    addresses = await lookup(hostname);
  } catch {
    throw new HttpError(`DNS resolution failed for ${hostname}.`, "dns");
  }
  if (addresses.length === 0) {
    throw new HttpError(`DNS resolution returned no addresses for ${hostname}.`, "dns");
  }
  for (const address of addresses) {
    if (isBlockedIp(address)) {
      throw new HttpError(
        `Blocked address ${address} resolved for ${hostname}.`,
        "blocked-redirect",
      );
    }
  }
}

/**
 * Validate a redirect Location header against the SSRF policy.
 * Returns the next absolute URL, or null when the response has no Location.
 * Throws `HttpError("blocked-redirect")` when the target violates policy:
 * non-http(s) scheme, unparseable URL, or a different host than the initial
 * hostname.
 */
export function resolveRedirectTarget(
  location: string | null,
  currentUrl: string,
  initialHostname: string,
): string | null {
  if (!location) {
    return null;
  }
  let next: URL;
  try {
    next = new URL(location, currentUrl);
  } catch {
    throw new HttpError("Redirect Location is not a valid URL.", "blocked-redirect");
  }
  if (next.protocol !== "https:" && next.protocol !== "http:") {
    throw new HttpError(`Redirect to disallowed scheme "${next.protocol}".`, "blocked-redirect");
  }
  if (next.hostname.toLowerCase() !== initialHostname) {
    throw new HttpError(
      `Redirect to different host "${next.hostname}" is not allowed.`,
      "blocked-redirect",
    );
  }
  return next.href;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * Perform an HTTP health check against `https://<hostname>/`.
 *
 * Follows at most `maxRedirects` redirects, validating EVERY hop (scheme,
 * host equality, and DNS-resolved addresses). Returns the final response's
 * status and timing, or throws a classified `HttpError`.
 */
export async function fetchHttpStatus(
  hostname: string,
  options: HttpClientOptions = {},
): Promise<RawHttpResult> {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    fetchFn = fetch,
    lookup = defaultLookup,
  } = options;

  const initialHost = hostname.toLowerCase();
  // The initial target is validated too: https only, host must resolve safely.
  await assertSafeHost(initialHost, lookup);

  let currentUrl = `https://${initialHost}/`;
  let redirectCount = 0;
  const startTime = performance.now();

  for (;;) {
    let response: Response;
    try {
      response = await fetchFn(currentUrl, {
        headers: { "User-Agent": USER_AGENT, Accept: "*/*" },
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
        cache: "no-store",
      });
    } catch (error) {
      throw mapFetchError(error);
    }

    const status = response.status;

    if (status >= 300 && status < 400) {
      if (redirectCount >= maxRedirects) {
        throw new HttpError("Too many redirects.", "too-many-redirects");
      }
      const nextUrl = resolveRedirectTarget(
        response.headers.get("location"),
        currentUrl,
        initialHost,
      );
      if (!nextUrl) {
        throw new HttpError("Redirect response without a Location header.", "blocked-redirect");
      }
      // Every redirect hop is re-validated (DNS → IP) before following.
      await assertSafeHost(new URL(nextUrl).hostname, lookup);
      currentUrl = nextUrl;
      redirectCount++;
      continue;
    }

    // Final response: release the body immediately (headers-only health check).
    try {
      await response.body?.cancel();
    } catch {
      // body cancellation is best-effort
    }

    return {
      status,
      statusText: response.statusText,
      responseTimeMs: Math.round(performance.now() - startTime),
      redirected: redirectCount > 0,
      redirectCount,
      finalUrl: currentUrl,
    };
  }
}

async function defaultLookup(hostname: string): Promise<string[]> {
  const addresses = await dnsLookup(hostname, { all: true });
  return addresses.map((entry) => entry.address);
}

function mapFetchError(error: unknown): HttpError {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return new HttpError("HTTP request timed out.", "timeout");
    }
    // Node's fetch wraps DNS/connection failures in a TypeError with a
    // `cause` carrying the errno code.
    const cause = (error as { cause?: { code?: string } }).cause;
    if (cause?.code === "ENOTFOUND" || cause?.code === "EAI_AGAIN") {
      return new HttpError("DNS resolution failed.", "dns");
    }
  }
  return new HttpError("HTTP request failed (network error).", "network");
}
