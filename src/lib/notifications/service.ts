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

import type { Repository } from "@/db/repository";
import { getRepository } from "@/lib/runtime/repository";
import type { DeliverySender, NotificationEvent } from "./types";

// Event → Rule → Delivery generation lives in `./event-deliveries` so the
// repository adapters can call it without importing the `@/db/repository`
// singleton (which would create an import cycle). Re-exported here for
// backward compatibility with existing callers/tests.
export {
  insertEventsAndGenerateDeliveries,
  generateDeliveries,
  type GenerateDeliveriesOptions,
  type GenerateDeliveriesResult,
} from "./event-deliveries";

// ---------------------------------------------------------------------------
// Delivery execution (V0.6 Phase 4D)
// ---------------------------------------------------------------------------

export interface DeliveryServiceOptions {
  /** Injectable repository (tests). */
  repo?: Repository;
}

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
  const target = options.repo ?? (await getRepository());

  const delivery = await target.getDelivery(deliveryId);
  if (!delivery) {
    return { status: "skipped" };
  }

  // Atomic CAS: only the winning worker proceeds; losers are skipped.
  if (!(await target.claimPendingDelivery(deliveryId))) {
    return { status: "skipped" };
  }

  const channel = await target.getChannel(delivery.channelId);
  if (!channel || channel.enabled !== 1) {
    // Channel vanished/disabled after the delivery was created. Never leave
    // the delivery stuck in `sending`.
    await target.markDeliveryFailed(deliveryId, "Notification channel is unavailable.");
    return { status: "failed", error: "Notification channel is unavailable." };
  }
  if (channel.type !== sender.channelType) {
    await target.markDeliveryFailed(deliveryId, `Sender type mismatch (expected ${channel.type}).`);
    return { status: "failed", error: `Sender type mismatch (expected ${channel.type}).` };
  }

  try {
    await sender.send(deliveryId, event, { id: channel.id, config: channel.config });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The senders guarantee secret-free error messages; record as-is.
    await target.markDeliveryFailed(deliveryId, message);
    return { status: "failed", error: message };
  }

  // Success only after send() resolved — at-least-once semantics.
  await target.markDeliverySent(deliveryId);
  return { status: "sent" };
}
