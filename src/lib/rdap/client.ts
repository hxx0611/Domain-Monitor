/**
 * RDAP HTTP client.
 *
 * Fetches RDAP JSON from a registry endpoint. The endpoint must come from
 * the IANA bootstrap (never from user input) — this is the SSRF guard:
 * we never fetch arbitrary URLs supplied by users.
 *
 * All requests have a hard timeout and errors are mapped to typed
 * `RdapError` codes so callers can react without parsing stack traces.
 */

export type RdapErrorCode =
  | "no-bootstrap"
  | "not-found"
  | "rate-limited"
  | "server-error"
  | "timeout"
  | "network"
  | "invalid-response";

export class RdapError extends Error {
  readonly code: RdapErrorCode;

  constructor(message: string, code: RdapErrorCode) {
    super(message);
    this.name = "RdapError";
    this.code = code;
  }
}

export interface RdapClientOptions {
  /** Hard timeout for a single RDAP request (default 10s). */
  timeoutMs?: number;
  /** Injectable fetch for tests. */
  fetchFn?: typeof fetch;
}

const USER_AGENT = "Domain-Monitor/0.2 (+https://github.com/hxx0611/Domain-Monitor)";

/**
 * Query the RDAP server at `baseUrl` for `hostname`.
 * Returns the parsed JSON as `unknown` — parsing into domain data happens in
 * the parser layer.
 */
export async function fetchRdapDomain(
  baseUrl: string,
  hostname: string,
  options: RdapClientOptions = {},
): Promise<unknown> {
  const { timeoutMs = 10_000, fetchFn = fetch } = options;

  // Build `{baseUrl}/domain/{hostname}` with a single trailing slash.
  const url = `${baseUrl.replace(/\/+$/, "")}/domain/${hostname}`;

  let response: Response;
  try {
    response = await fetchFn(url, {
      headers: {
        Accept: "application/rdap+json, application/json",
        "User-Agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  } catch (error) {
    throw mapFetchError(error);
  }

  if (response.status === 404) {
    throw new RdapError("Domain not found in RDAP.", "not-found");
  }
  if (response.status === 429) {
    throw new RdapError("RDAP server rate-limited the request.", "rate-limited");
  }
  if (response.status >= 500) {
    throw new RdapError(`RDAP server returned HTTP ${response.status}.`, "server-error");
  }
  if (!response.ok) {
    throw new RdapError(`RDAP server returned HTTP ${response.status}.`, "network");
  }

  try {
    return await response.json();
  } catch {
    throw new RdapError("RDAP server returned invalid JSON.", "invalid-response");
  }
}

function mapFetchError(error: unknown): RdapError {
  if (error instanceof Error) {
    // AbortSignal.timeout() rejects with a DOMException named "TimeoutError".
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return new RdapError("RDAP request timed out.", "timeout");
    }
  }
  return new RdapError("RDAP request failed (network error).", "network");
}
