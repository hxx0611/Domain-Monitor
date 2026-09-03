/**
 * Event → Rule → Delivery generation (V0.6 Phase 3), SQLite-internal.
 *
 * Lives in its own module (NOT in service.ts) so the repository adapters
 * can call it without importing `@/db/repository` — importing the singleton
 * from here would create a runtime import cycle:
 *
 *   db/repository → db/adapters/sqlite → notifications/service → db/repository
 *
 * This module depends only on the sync feature-repository layer and the
 * pure rule matcher. The D1 adapter implements the same atomic semantics
 * with `insertEventsAndGenerateDeliveriesTx`; business code outside the
 * repository adapters must use the async Repository method
 * `repository.insertEventsAndGenerateDeliveries(...)` instead.
 */

import {
  createDelivery,
  getChannel,
  getEnabledRules,
  insertNotificationEvents,
  type NotificationDb,
} from "./repository";
import { matchRules } from "./rules";
import type { NotificationEvent } from "./types";

/**
 * Insert events and immediately generate pending deliveries for the ones
 * that were actually inserted, all inside the caller's transaction.
 *
 * - Only newly-inserted events (non-null ids) get deliveries — a duplicate
 *   dedupKey is skipped at the event layer and never re-generates.
 * - Every DB operation uses the passed `target` (the transaction handle);
 *   nothing re-fetches the global db, and no nested transaction is opened.
 * - Returns the ids of the events that received (or kept) deliveries.
 */
export function insertEventsAndGenerateDeliveries(
  target: NotificationDb,
  events: NotificationEvent[],
): number[] {
  const ids = insertNotificationEvents(target, events);
  const deliveredEventIds: number[] = [];
  events.forEach((event, index) => {
    const eventId = ids[index];
    if (eventId === null) {
      return; // dedup hit — never re-generate deliveries for an old event
    }
    generateDeliveries(eventId, event, { db: target });
    deliveredEventIds.push(eventId);
  });
  return deliveredEventIds;
}

export interface GenerateDeliveriesOptions {
  /** Injectable database (tests). */
  db?: NotificationDb;
}

export interface GenerateDeliveriesResult {
  /** Channel ids that received a pending delivery. */
  created: number[];
  /** Matched channels that were skipped (disabled or duplicate). */
  skipped: number[];
}

/**
 * Generate pending deliveries for one event.
 *
 * - `eventId` is the persisted notification_events row id (the pure
 *   `NotificationEvent` shape has no id).
 * - `rules` may be injected for tests; defaults to enabled rules from the DB.
 * - Returns the ids of created deliveries' channels and skipped channels.
 */
export function generateDeliveries(
  eventId: number,
  event: NotificationEvent,
  options: GenerateDeliveriesOptions = {},
): GenerateDeliveriesResult {
  const db = options.db;
  const rules = getEnabledRules(db);
  const matched = matchRules(rules, event);

  const created: number[] = [];
  const skipped: number[] = [];
  const seen = new Set<number>();

  for (const rule of matched) {
    if (seen.has(rule.channelId)) {
      continue; // another rule already handled this channel
    }
    seen.add(rule.channelId);

    const channel = getChannel(rule.channelId, db);
    if (!channel || channel.enabled !== 1) {
      skipped.push(rule.channelId);
      continue;
    }

    // UNIQUE(event_id, channel_id) + ON CONFLICT DO NOTHING make this
    // idempotent even if generateDeliveries is called twice for one event.
    const createdId = createDelivery(eventId, rule.channelId, db);
    if (createdId !== null) {
      created.push(rule.channelId);
    } else {
      skipped.push(rule.channelId);
    }
  }

  return { created, skipped };
}
