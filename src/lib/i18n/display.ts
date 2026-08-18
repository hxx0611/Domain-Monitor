/**
 * Locale-aware display helpers (V0.7.x — Phase 3).
 *
 * Pure functions: no server-only, no cookies, no React — safe to import
 * from Client Components. These translate UI *labels* only; machine
 * values (eventType, status, source) are never altered — they are used
 * as lookup keys into the dictionary.
 */
import type { Dictionary } from "./en";

/**
 * Dictionary key (dot path) for each notification event type label.
 *
 * The eventType machine value is the LOOKUP KEY — it is never translated
 * or modified. Only the displayed label is locale-aware.
 */
const EVENT_TYPE_KEYS: Record<string, string> = {
  dns_record_added: "events.dnsRecordAdded",
  dns_record_removed: "events.dnsRecordRemoved",
  ssl_cert_replaced: "events.sslCertReplaced",
  ssl_status_changed: "events.sslStatusChanged",
  http_status_changed: "events.httpStatusChanged",
  expiration_reminder: "events.expirationReminder",
};

/** Look up a dotted path in a dictionary (fail-safe: returns path). */
export function lookup(dictionary: Dictionary, path: string): string {
  const value = path
    .split(".")
    .reduce<unknown>(
      (acc, key) =>
        acc && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined,
      dictionary,
    );
  return typeof value === "string" ? value : path;
}

/**
 * Dictionary key (dot path) for each monitoring error code (V0.7.3).
 *
 * The machine error code is the LOOKUP KEY — it is never translated or
 * modified; only the displayed label is locale-aware. Codes not listed
 * here (legacy rows, unknown codes) yield `undefined` so callers can
 * fall back to the generic per-module unavailable text.
 */
const ERROR_CODE_KEYS: Record<string, string> = {
  dns_timeout: "errors.dns.timeout",
  dns_network: "errors.dns.network",
  dns_invalid_response: "errors.dns.invalidResponse",
  dns_resolver_error: "errors.dns.resolverError",
  ssl_timeout: "errors.ssl.timeout",
  ssl_network: "errors.ssl.network",
  ssl_dns_failed: "errors.ssl.dnsFailed",
  ssl_handshake: "errors.ssl.handshake",
  ssl_no_tls_service: "errors.ssl.noTlsService",
  ssl_invalid_cert: "errors.ssl.invalidCert",
  http_dns_failed: "errors.http.dnsFailed",
  http_timeout: "errors.http.timeout",
  http_network: "errors.http.network",
  http_blocked_redirect: "errors.http.blockedRedirect",
  http_too_many_redirects: "errors.http.tooManyRedirects",
};

/**
 * Locale-aware message for a monitoring error code.
 *
 *   errorMessage("ssl_network", dict) → "Could not connect to the server."
 *   errorMessage("legacy text", dict) → undefined (caller falls back)
 *
 * Returns `undefined` for unknown codes / legacy error strings so the UI
 * can fall back to the per-module unavailable text — old v0.7.2 rows are
 * never broken by a missing translation.
 */
export function errorMessage(code: string, dictionary: Dictionary): string | undefined {
  const key = ERROR_CODE_KEYS[code];
  if (!key) {
    return undefined;
  }
  return lookup(dictionary, key);
}

/**
 * Locale-aware event type label.
 *
 *   eventTypeLabel("dns_record_added", dict) → "DNS record added" / "DNS 记录新增"
 *
 * The eventType machine value itself is returned unchanged if no
 * translation exists (never crashes on unknown types).
 */
export function eventTypeLabel(eventType: string, dictionary: Dictionary): string {
  const key = EVENT_TYPE_KEYS[eventType];
  if (!key) {
    return eventType;
  }
  return lookup(dictionary, key);
}
