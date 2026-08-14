/**
 * Notification event persistence.
 *
 * `insertNotificationEvents` is shared by the DNS / SSL / HTTP repositories:
 * each check writes its snapshot AND its derived events inside ONE
 * transaction. Duplicate dedup keys are silently skipped via
 * ON CONFLICT DO NOTHING — a repeated event must never fail the check
 * transaction, while any other insert failure rolls the snapshot back with
 * it (no "check saved but event lost" state).
 */

import "server-only";

import { and, desc, eq, lt, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { db } from "@/db";
import {
  domains,
  notificationChannels,
  notificationDeliveries,
  notificationEvents,
  notificationRules,
  type Schema,
} from "@/db/schema";
import type { NotificationEvent, NotificationRuleFilter } from "./types";

export type NotificationDb = BetterSQLite3Database<Schema>;

/**
 * Insert events into `notification_events` within the caller's transaction.
 * No-op for an empty list. Duplicate `dedupKey` rows are ignored (UNIQUE
 * index is the backstop; the check itself still commits).
 */
export function insertNotificationEvents(
  target: BetterSQLite3Database<Schema>,
  events: NotificationEvent[],
): void {
  if (events.length === 0) {
    return;
  }
  target
    .insert(notificationEvents)
    .values(
      events.map((event) => ({
        domainId: event.domainId,
        source: event.source,
        eventType: event.eventType,
        previousState: event.previousState,
        currentState: event.currentState,
        dedupKey: event.dedupKey,
        occurredAt: event.occurredAt,
      })),
    )
    .onConflictDoNothing()
    .run();
}

// ---------------------------------------------------------------------------
// Rules & channels (Phase 3: rule engine)
// ---------------------------------------------------------------------------

/** All enabled rules, mapped to the pure filter shape used by matchRules. */
export function getEnabledRules(target: NotificationDb = db): NotificationRuleFilter[] {
  const rows = target
    .select()
    .from(notificationRules)
    .where(eq(notificationRules.enabled, 1))
    .all();
  return rows.map((row) => ({
    channelId: row.channelId,
    source: row.source as NotificationRuleFilter["source"],
    eventType: row.eventType as NotificationRuleFilter["eventType"],
    domainId: row.domainId,
    enabled: row.enabled === 1,
  }));
}

/** A channel row, or undefined when it does not exist. */
export function getChannel(
  channelId: number,
  target: NotificationDb = db,
): typeof notificationChannels.$inferSelect | undefined {
  return target
    .select()
    .from(notificationChannels)
    .where(eq(notificationChannels.id, channelId))
    .get();
}

// ---------------------------------------------------------------------------
// Deliveries (Phase 3: Event → Delivery, pending only)
// ---------------------------------------------------------------------------

/**
 * Create a pending delivery for an event+channel. Idempotent: the
 * UNIQUE(event_id, channel_id) index plus ON CONFLICT DO NOTHING means
 * repeated calls (e.g. multiple rules matching the same channel) never
 * create duplicates. Returns the delivery id, or null when the delivery
 * already existed.
 */
export function createDelivery(
  eventId: number,
  channelId: number,
  target: NotificationDb = db,
): number | null {
  const row = target
    .insert(notificationDeliveries)
    .values({ eventId, channelId, status: "pending", attempts: 0 })
    .onConflictDoNothing()
    .returning({ id: notificationDeliveries.id })
    .get();
  return row?.id ?? null;
}

/** All deliveries for an event, ordered by id. */
export function getEventDeliveries(
  eventId: number,
  target: NotificationDb = db,
): (typeof notificationDeliveries.$inferSelect)[] {
  return target
    .select()
    .from(notificationDeliveries)
    .where(eq(notificationDeliveries.eventId, eventId))
    .orderBy(notificationDeliveries.id)
    .all();
}

// ---------------------------------------------------------------------------
// Delivery state machine (Phase 4A)
// ---------------------------------------------------------------------------

/**
 * Atomically claim a pending delivery for sending: pending → sending,
 * attempts + 1, claimedAt = now. Returns true when THIS caller won the
 * claim. A concurrent worker claiming the same delivery gets false — the
 * UNIQUE(event_id, channel_id) guarantee plus this CAS means a delivery is
 * never sent twice.
 */
export function claimPendingDelivery(
  deliveryId: number,
  target: NotificationDb = db,
  now: Date = new Date(),
): boolean {
  const result = target
    .update(notificationDeliveries)
    .set({
      status: "sending",
      attempts: sql`${notificationDeliveries.attempts} + 1`,
      claimedAt: now,
    })
    .where(
      and(eq(notificationDeliveries.id, deliveryId), eq(notificationDeliveries.status, "pending")),
    )
    .returning({ id: notificationDeliveries.id })
    .get();
  return result !== undefined;
}

/**
 * Mark a claimed delivery as sent: sending → sent, deliveredAt = now.
 * Only a `sending` delivery can be marked sent (idempotent for sent rows).
 */
export function markDeliverySent(
  deliveryId: number,
  target: NotificationDb = db,
  now: Date = new Date(),
): boolean {
  const result = target
    .update(notificationDeliveries)
    .set({ status: "sent", deliveredAt: now })
    .where(
      and(eq(notificationDeliveries.id, deliveryId), eq(notificationDeliveries.status, "sending")),
    )
    .returning({ id: notificationDeliveries.id })
    .get();
  return result !== undefined;
}

/**
 * Mark a claimed delivery as failed: sending → failed with the error.
 * Only a `sending` delivery can fail. A failed delivery may be retried.
 */
export function markDeliveryFailed(
  deliveryId: number,
  error: string,
  target: NotificationDb = db,
): boolean {
  const result = target
    .update(notificationDeliveries)
    .set({ status: "failed", error })
    .where(
      and(eq(notificationDeliveries.id, deliveryId), eq(notificationDeliveries.status, "sending")),
    )
    .returning({ id: notificationDeliveries.id })
    .get();
  return result !== undefined;
}

/**
 * Retry a failed delivery: failed → pending (error kept for diagnosis).
 * Returns false when the delivery is not in `failed` state.
 */
export function retryDelivery(deliveryId: number, target: NotificationDb = db): boolean {
  const result = target
    .update(notificationDeliveries)
    .set({ status: "pending" })
    .where(
      and(eq(notificationDeliveries.id, deliveryId), eq(notificationDeliveries.status, "failed")),
    )
    .returning({ id: notificationDeliveries.id })
    .get();
  return result !== undefined;
}

/**
 * Recover deliveries stuck in `sending` past the stale threshold (worker
 * crashed mid-send): sending → pending so they can be claimed again.
 * Returns the number of recovered deliveries.
 */
export function recoverStaleSending(
  target: NotificationDb = db,
  staleAfterMs: number = 60_000,
  now: Date = new Date(),
): number {
  const cutoff = new Date(now.getTime() - staleAfterMs);
  const result = target
    .update(notificationDeliveries)
    .set({ status: "pending" })
    .where(
      and(
        eq(notificationDeliveries.status, "sending"),
        lt(notificationDeliveries.claimedAt, cutoff),
      ),
    )
    .run();
  return result.changes;
}

/** A single delivery row by id. */
export function getDelivery(
  deliveryId: number,
  target: NotificationDb = db,
): typeof notificationDeliveries.$inferSelect | undefined {
  return target
    .select()
    .from(notificationDeliveries)
    .where(eq(notificationDeliveries.id, deliveryId))
    .get();
}

// ---------------------------------------------------------------------------
// Read-only display queries (Phase 5B: Notification UI)
// ---------------------------------------------------------------------------
//
// Pure SELECTs backing the /notifications page. No state transitions, no
// writes — display only. Join columns are aliased explicitly so `id`
// collisions across tables never shadow each other.

/** All channels, oldest first. Includes `config` for the action layer to
 * extract non-sensitive display fields. */
export function getChannels(
  target: NotificationDb = db,
): (typeof notificationChannels.$inferSelect)[] {
  return target.select().from(notificationChannels).orderBy(notificationChannels.id).all();
}

/** A rule row with its channel name/type and (optional) domain hostname. */
export interface RuleWithChannelRow {
  id: number;
  name: string;
  channelId: number;
  source: string | null;
  eventType: string | null;
  domainId: number | null;
  enabled: number;
  createdAt: Date;
  channelName: string | null;
  channelType: string | null;
  hostname: string | null;
}

/** All rules, oldest first, joined with their channel and domain. */
export function getRules(target: NotificationDb = db): RuleWithChannelRow[] {
  return target
    .select({
      id: notificationRules.id,
      name: notificationRules.name,
      channelId: notificationRules.channelId,
      source: notificationRules.source,
      eventType: notificationRules.eventType,
      domainId: notificationRules.domainId,
      enabled: notificationRules.enabled,
      createdAt: notificationRules.createdAt,
      channelName: notificationChannels.name,
      channelType: notificationChannels.type,
      hostname: domains.hostname,
    })
    .from(notificationRules)
    .leftJoin(notificationChannels, eq(notificationRules.channelId, notificationChannels.id))
    .leftJoin(domains, eq(notificationRules.domainId, domains.id))
    .orderBy(notificationRules.id)
    .all();
}

/** A single event row by id (required for retry: deliverDelivery needs the
 * full NotificationEvent shape). */
export function getEvent(
  eventId: number,
  target: NotificationDb = db,
): typeof notificationEvents.$inferSelect | undefined {
  return target.select().from(notificationEvents).where(eq(notificationEvents.id, eventId)).get();
}

/** A delivery row joined with its channel name/type and event details. */
export interface DeliveryWithDetailsRow {
  deliveryId: number;
  eventId: number;
  channelId: number;
  status: string;
  attempts: number;
  error: string | null;
  createdAt: Date;
  claimedAt: Date | null;
  deliveredAt: Date | null;
  channelName: string | null;
  channelType: string | null;
  source: string | null;
  eventType: string | null;
  occurredAt: Date | null;
  domainId: number | null;
  hostname: string | null;
}

/** All deliveries, newest first, joined with channel name and event details. */
export function getDeliveriesWithDetails(target: NotificationDb = db): DeliveryWithDetailsRow[] {
  return target
    .select({
      deliveryId: notificationDeliveries.id,
      eventId: notificationDeliveries.eventId,
      channelId: notificationDeliveries.channelId,
      status: notificationDeliveries.status,
      attempts: notificationDeliveries.attempts,
      error: notificationDeliveries.error,
      createdAt: notificationDeliveries.createdAt,
      claimedAt: notificationDeliveries.claimedAt,
      deliveredAt: notificationDeliveries.deliveredAt,
      channelName: notificationChannels.name,
      channelType: notificationChannels.type,
      source: notificationEvents.source,
      eventType: notificationEvents.eventType,
      occurredAt: notificationEvents.occurredAt,
      domainId: notificationEvents.domainId,
      hostname: domains.hostname,
    })
    .from(notificationDeliveries)
    .leftJoin(notificationChannels, eq(notificationDeliveries.channelId, notificationChannels.id))
    .leftJoin(notificationEvents, eq(notificationDeliveries.eventId, notificationEvents.id))
    .leftJoin(domains, eq(notificationEvents.domainId, domains.id))
    .orderBy(desc(notificationDeliveries.id))
    .all();
}
