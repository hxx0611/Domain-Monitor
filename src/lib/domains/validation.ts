/**
 * Domain hostname validation and normalization.
 *
 * Accepts a user-supplied domain input (possibly with scheme, path, query,
 * uppercase letters or surrounding whitespace) and normalizes it to a bare
 * hostname such as `example.com`.
 */

export type ValidationResult = { ok: true; hostname: string } | { ok: false; error: string };

const HOSTNAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * Normalize a user-supplied domain string to a canonical hostname.
 *
 * - Trims surrounding whitespace and lowercases the input.
 * - Strips `http://` / `https://` schemes, paths, query strings and ports.
 * - Requires at least two dot-separated labels (a bare TLD is not accepted).
 * - Rejects bare IP addresses (out of scope for a domain monitor).
 *
 * Returns `{ ok: true, hostname }` on success or `{ ok: false, error }`
 * with a human-readable message on failure.
 */
export function normalizeHostname(input: string): ValidationResult {
  const trimmed = input.trim().toLowerCase();

  if (trimmed.length === 0) {
    return { ok: false, error: "Please enter a valid domain name." };
  }

  // Reject strings that clearly contain whitespace (e.g. "exa mple.com").
  if (/\s/.test(trimmed)) {
    return { ok: false, error: "Please enter a valid domain name." };
  }

  let hostname: string;

  if (trimmed.includes("://")) {
    try {
      const url = new URL(trimmed);
      // `URL.hostname` excludes the port and any path/query fragments.
      hostname = url.hostname;
    } catch {
      return { ok: false, error: "Please enter a valid domain name." };
    }
  } else {
    // No scheme supplied — parse as `https://<input>` to reuse URL semantics
    // for host extraction (also strips ports and path fragments).
    try {
      hostname = new URL(`https://${trimmed}`).hostname;
    } catch {
      return { ok: false, error: "Please enter a valid domain name." };
    }
  }

  // Strip an optional trailing dot (fully-qualified domain name notation).
  hostname = hostname.replace(/\.$/, "");

  // Reject IPv4 addresses (e.g. "192.168.1.1") — out of scope.
  if (/^\d+(\.\d+){3}$/.test(hostname)) {
    return { ok: false, error: "IP addresses are not supported." };
  }

  if (!HOSTNAME_PATTERN.test(hostname)) {
    return { ok: false, error: "Please enter a valid domain name." };
  }

  return { ok: true, hostname };
}
