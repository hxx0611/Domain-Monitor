/**
 * V0.7 delivery worker — one `runOnce` tick.
 *
 * The worker is the missing consumer that turns the V0.6 pipeline into a
 * real background capability:
 *
 *   evaluateExpirationReminders(now)  0. record due expiration reminders
 *                                       (Phase 11A; idempotent by dedupKey)
 *   recoverStaleSending()           1. unstick `sending` rows past the
 *                                      stale threshold (worker crash)
 *   getPendingDeliveries(limit)     2. oldest-first pending batch
 *   for each: getEvent              3. load the event
 *     → createSender(channel.type)     → pick the sender by channel type
 *     → deliverDelivery()              → claim (CAS) → send → sent/failed
 *
 * Guarantees (all inherited from the V0.6 state machine):
 * - at-least-once: a crash mid-send leaves `sending`, which the next tick
 *   recovers to `pending` and sends again — receivers dedupe via the
 *   stable eventId + deliveryId in the payload.
 * - no double send: `claimPendingDelivery` is an atomic CAS; concurrent
 *   workers racing for the same delivery get exactly one winner.
 * - one failing delivery never blocks the rest of the batch.
 * - NO auto-retry: failed deliveries stay `failed` and are retried only
 *   explicitly (UI). No backoff, no max-attempts, no scheduler — this
 *   file implements a single runOnce tick and nothing else.
 *
 * The worker never touches secrets: api keys / secrets are read inside
 * the senders at send time and never appear in worker output.
 */

import type { Repository } from "@/db/repository";
import { getRepository } from "@/lib/runtime/repository";
import { evaluateExpirationReminders } from "./expiration";
import { deliverDelivery } from "./service";
import { createSender } from "./senders/factory";
import type {
  ChannelType,
  DeliverySender,
  NotificationEvent,
  NotificationEventType,
  NotificationSource,
} from "./types";
import type { NotificationEventRow } from "@/db/schema";

export interface WorkerRunOptions {
  /** Injectable repository (tests); defaults to the app singleton. */
  repo?: Repository;
  /** Max deliveries processed per tick (default 50). */
  limit?: number;
  /** Stale threshold for recoverStaleSending (default 5 minutes). */
  staleAfterMs?: number;
  /** Clock for recoverStaleSending (tests). */
  now?: Date;
  /**
   * Sender factory override (tests). Defaults to createSender, which maps
   * channel.type → WebhookSender / EmailSender.
   */
  senders?: (type: ChannelType) => DeliverySender;
}

export interface WorkerRunResult {
  /** Expiration-reminder events newly recorded this tick (Phase 11A). */
  expirationEvents: number;
  /** Deliveries unstuck from `sending` back to `pending` this tick. */
  recovered: number;
  /** Deliveries this tick attempted to deliver (claim attempted). */
  attempted: number;
  sent: number;
  failed: number;
  skipped: number;
}

export const DEFAULT_WORKER_LIMIT = 50;

/**
 * Run one worker tick. Resolves with a summary; never throws for
 * individual delivery failures (each is caught and counted as `failed`).
 */
export async function runOnce(options: WorkerRunOptions = {}): Promise<WorkerRunResult> {
  const repo = options.repo ?? (await getRepository());
  const limit = options.limit ?? DEFAULT_WORKER_LIMIT;
  const staleAfterMs = options.staleAfterMs;
  const now = options.now;
  const senderFactory = options.senders ?? createSender;

  // 0. Record due expiration reminders BEFORE deliveries are claimed, so a
  //    reminder due this tick is delivered in this same tick. Idempotent:
  //    events whose dedup key already exists are skipped (returns 0).
  const expirationEvents = await evaluateExpirationReminders(now ?? new Date(), repo);

  // 1. Unstick stale `sending` rows BEFORE claiming anything new, so a
  //    crashed worker's deliveries get a chance in this same tick.
  const recovered = await repo.recoverStaleSending(staleAfterMs, now);

  // 2. Oldest-first pending batch (FIFO).
  const deliveries = await repo.getPendingDeliveries(limit);

  let attempted = 0;
  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (const delivery of deliveries) {
    attempted++;

    const event = await repo.getEvent(delivery.eventId);
    if (!event) {
      // Unreachable in practice (deliveries cascade-delete with their
      // event); skip defensively rather than crash the batch.
      skipped++;
      continue;
    }

    const channel = await repo.getChannel(delivery.channelId);
    if (!channel) {
      skipped++;
      continue;
    }

    const sender = senderFactory(channel.type as ChannelType);

    try {
      const result = await deliverDelivery(delivery.id, toNotificationEvent(event), sender, {
        repo,
      });
      if (result.status === "sent") {
        sent++;
      } else if (result.status === "failed") {
        failed++;
      } else {
        skipped++;
      }
    } catch {
      // deliverDelivery handles sender errors internally; this is the
      // backstop for unexpected repository/claim errors so one delivery
      // can never block the rest of the batch.
      failed++;
    }
  }

  return { expirationEvents, recovered, attempted, sent, failed, skipped };
}

/** Convert a persisted event row back to the pure NotificationEvent shape. */
function toNotificationEvent(row: NotificationEventRow): NotificationEvent {
  return {
    domainId: row.domainId,
    source: row.source as NotificationSource,
    eventType: row.eventType as NotificationEventType,
    previousState: row.previousState,
    currentState: row.currentState,
    occurredAt: row.occurredAt,
    dedupKey: row.dedupKey,
  };
}
