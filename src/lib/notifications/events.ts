/**
 * Notification event generation.
 *
 * Pure functions that convert DNS / SSL / HTTP snapshot diffs into
 * normalized `NotificationEvent`s, and derive the deduplication key for
 * each event. No network, no database.
 *
 * Dedup semantics: `buildDedupKey` names ONE concrete state transition.
 * The events table's UNIQUE index on `dedupKey` guarantees the same
 * transition is never recorded twice. A transition that recurs later (e.g.
 * a record removed and later re-added) produces the same key and is
 * deduplicated — this is a deliberate trade-off: V0.6 reports state
 * changes, not every transient fluctuation.
 */

import type { DnsChange } from "@/lib/dns";
import type { SslChange } from "@/lib/ssl";
import type { HttpSnapshot } from "@/lib/http";
import type { NotificationEvent, NotificationEventType } from "./types";

/** Join arbitrary parts into a dedup key. */
export function buildDedupKey(parts: Array<string | number>): string {
  return parts.map(String).join(":");
}

/** Serialize a state value to JSON, mapping undefined/null to null. */
export function serializeState(state: unknown): string | null {
  if (state === undefined || state === null) {
    return null;
  }
  return JSON.stringify(state);
}

// ---------------------------------------------------------------------------
// DNS
// ---------------------------------------------------------------------------

/**
 * Convert DNS diff changes into events.
 *
 * - RECORD_ADDED → `dns_record_added` (previousState null)
 * - RECORD_REMOVED → `dns_record_removed` (currentState null)
 *
 * The dedup key names the record identity (type + value) so the same
 * record change is only reported once.
 */
export function dnsChangesToEvents(
  domainId: number,
  changes: DnsChange[],
  occurredAt: Date,
): NotificationEvent[] {
  return changes.map((change) => {
    const added = change.type === "RECORD_ADDED";
    return {
      domainId,
      source: "dns",
      eventType: added ? "dns_record_added" : "dns_record_removed",
      previousState: added ? null : serializeState(change.record),
      currentState: added ? serializeState(change.record) : null,
      occurredAt,
      dedupKey: buildDedupKey([
        "dns",
        domainId,
        change.type,
        change.record.type,
        change.record.value,
      ]),
    };
  });
}

// ---------------------------------------------------------------------------
// SSL
// ---------------------------------------------------------------------------

export interface SslEventInput {
  domainId: number;
  /** CERT_REPLACED changes from the snapshot diff. */
  changes: SslChange[];
  /** Status of the previous snapshot (undefined on first check). */
  previousStatus: string | undefined;
  /** Status of the current snapshot. */
  currentStatus: string;
  occurredAt: Date;
}

/**
 * Convert SSL diff changes + status transition into events.
 *
 * - CERT_REPLACED → `ssl_cert_replaced` (key: old fp → new fp)
 * - A status change (previous exists and differs) → `ssl_status_changed`
 *   (key: from → to). Same status → no event; no previous → no event.
 */
export function sslChangesToEvents(input: SslEventInput): NotificationEvent[] {
  const events: NotificationEvent[] = [];

  for (const change of input.changes) {
    events.push({
      domainId: input.domainId,
      source: "ssl",
      eventType: "ssl_cert_replaced",
      previousState: serializeState({ fingerprint256: change.previousFingerprint }),
      currentState: serializeState({ fingerprint256: change.currentFingerprint }),
      occurredAt: input.occurredAt,
      dedupKey: buildDedupKey([
        "ssl",
        input.domainId,
        "ssl_cert_replaced",
        change.previousFingerprint,
        change.currentFingerprint,
      ]),
    });
  }

  if (input.previousStatus !== undefined && input.previousStatus !== input.currentStatus) {
    events.push({
      domainId: input.domainId,
      source: "ssl",
      eventType: "ssl_status_changed",
      previousState: serializeState(input.previousStatus),
      currentState: serializeState(input.currentStatus),
      occurredAt: input.occurredAt,
      dedupKey: buildDedupKey([
        "ssl",
        input.domainId,
        "ssl_status_changed",
        input.previousStatus,
        input.currentStatus,
      ]),
    });
  }

  return events;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/**
 * Build an event when the HTTP status transitions.
 * Returns null when:
 * - there is no previous snapshot (first check — no false positive), or
 * - the status did not change (same status — no repeated events).
 * Otherwise `http_status_changed` with the from → to transition.
 */
export function httpStatusChangeEvent(
  domainId: number,
  previous: HttpSnapshot | undefined,
  current: HttpSnapshot | undefined,
  occurredAt: Date,
): NotificationEvent | null {
  if (!previous || !current) {
    return null;
  }
  if (previous.status === current.status) {
    return null;
  }
  return {
    domainId,
    source: "http",
    eventType: "http_status_changed",
    previousState: serializeState({
      status: previous.status,
      httpStatus: previous.httpStatus ?? null,
    }),
    currentState: serializeState({
      status: current.status,
      httpStatus: current.httpStatus ?? null,
    }),
    occurredAt,
    dedupKey: buildDedupKey([
      "http",
      domainId,
      "http_status_changed",
      previous.status,
      current.status,
    ]),
  };
}

/** Human-readable label for an event type (used by later UI layers). */
export function eventTypeLabel(eventType: NotificationEventType): string {
  switch (eventType) {
    case "dns_record_added":
      return "DNS record added";
    case "dns_record_removed":
      return "DNS record removed";
    case "ssl_cert_replaced":
      return "SSL certificate replaced";
    case "ssl_status_changed":
      return "SSL status changed";
    case "http_status_changed":
      return "HTTP status changed";
    case "expiration_reminder":
      return "Expiration reminder";
    case "test_notification":
      return "Test notification";
  }
}

// ---------------------------------------------------------------------------
// Expiration reminders (Phase 11A-7/8)
// ---------------------------------------------------------------------------

export interface ExpirationReminderEventInput {
  domainId: number;
  /** The effective expiration date as stored on the domain (ISO string). */
  expirationDate: string;
  /** Days before expiration this reminder fires at. */
  daysBefore: number;
  occurredAt: Date;
}

/**
 * Build the notification event for one expiration reminder.
 *
 * Dedup key: `expiration:{domainId}:{expirationDate}:{daysBefore}` — the
 * same reminder for the same expiration date is reported exactly once, no
 * matter how often the worker ticks. Changing the expiration date changes
 * the key, so a moved expiry starts a fresh reminder cycle (Phase 11A-8).
 */
export function expirationReminderEvent(input: ExpirationReminderEventInput): NotificationEvent {
  return {
    domainId: input.domainId,
    source: "expiration",
    eventType: "expiration_reminder",
    previousState: null,
    currentState: serializeState({
      expirationDate: input.expirationDate,
      daysBefore: input.daysBefore,
    }),
    occurredAt: input.occurredAt,
    dedupKey: buildDedupKey(["expiration", input.domainId, input.expirationDate, input.daysBefore]),
  };
}
