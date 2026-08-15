/**
 * Notification delivery generation (V0.6 Phase 3).
 *
 * Event → Rule → Delivery:
 * - Load all enabled rules and match them against the event
 *   (source / event type / domain filters, AND semantics, null = all).
 * - Collect the matched channels; each channel gets exactly ONE pending
 *   delivery per event, regardless of how many rules matched it.
 * - Disabled channels are skipped.
 *
 * The terminal state is `pending` — Phase 3 performs NO sending. Phase 4
 * owns pending → sent / failed + retries.
 */

import {
  claimPendingDelivery,
  createDelivery,
  getChannel,
  getDelivery,
  getEnabledRules,
  insertNotificationEvents,
  markDeliveryFailed,
  markDeliverySent,
  type NotificationDb,
} from "./repository";
import { matchRules } from "./rules";
import type { DeliverySender, NotificationEvent } from "./types";

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

export interface DeliveryServiceOptions {
  /** Injectable database (tests). */
  db?: Parameters<typeof getEnabledRules>[0];
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
  options: DeliveryServiceOptions = {},
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

// ---------------------------------------------------------------------------
// Delivery execution (V0.6 Phase 4D)
// ---------------------------------------------------------------------------

/**
 * Run ONE delivery through the state machine with the given sender:
 *
 *   claim (pending → sending, attempts +1)
 *     → sender.send()
 *         ├─ success → markDeliverySent (sending → sent, deliveredAt)
 *         └─ throws  → markDeliveryFailed (sending → failed, error)
 *
 * - "skipped" means the delivery was not claimable (a concurrent worker
 *   already claimed it, it is already sent, or it does not exist). The
 *   sender is NEVER invoked in that case — no double send.
 * - The sender's channelType must match the channel type; a mismatch fails
 *   the delivery instead of sending.
 * - This is the ONLY place that owns pending → sent / failed for a single
 *   delivery. NO auto-retry and NO scheduling happen here: retry is an
 *   explicit caller action (retryDelivery), and workers/schedulers are out
 *   of scope for V0.6.
 */
export async function deliverDelivery(
  deliveryId: number,
  event: NotificationEvent,
  sender: DeliverySender,
  options: DeliveryServiceOptions = {},
): Promise<{ status: "skipped" | "sent" | "failed"; error?: string }> {
  const db = options.db;

  const delivery = getDelivery(deliveryId, db);
  if (!delivery) {
    return { status: "skipped" };
  }

  // Atomic CAS: only the winning worker proceeds; losers are skipped.
  if (!claimPendingDelivery(deliveryId, db)) {
    return { status: "skipped" };
  }

  const channel = getChannel(delivery.channelId, db);
  if (!channel || channel.enabled !== 1) {
    // Channel vanished/disabled after the delivery was created. Never leave
    // the delivery stuck in `sending`.
    markDeliveryFailed(deliveryId, "Notification channel is unavailable.", db);
    return { status: "failed", error: "Notification channel is unavailable." };
  }
  if (channel.type !== sender.channelType) {
    markDeliveryFailed(deliveryId, `Sender type mismatch (expected ${channel.type}).`, db);
    return { status: "failed", error: `Sender type mismatch (expected ${channel.type}).` };
  }

  try {
    await sender.send(deliveryId, event, { id: channel.id, config: channel.config });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The senders guarantee secret-free error messages; record as-is.
    markDeliveryFailed(deliveryId, message, db);
    return { status: "failed", error: message };
  }

  // Success only after send() resolved — at-least-once semantics.
  markDeliverySent(deliveryId, db);
  return { status: "sent" };
}
