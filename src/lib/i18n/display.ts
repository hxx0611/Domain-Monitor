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
