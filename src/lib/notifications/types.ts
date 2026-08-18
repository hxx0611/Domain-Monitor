/**
 * Notification event model (V0.6).
 *
 * The event is the single unit the notification pipeline is built around:
 * DNS / SSL / HTTP snapshot diffs are converted into normalized events,
 * deduplicated by `dedupKey`, matched against rules, and delivered through
 * channels. Phase 1 defines the event shape and the pure functions that
 * produce it — no sending logic.
 */

/** Which monitoring module produced the event. */
export type NotificationSource = "dns" | "ssl" | "http" | "expiration";

/** Concrete event kinds the pipeline understands. */
export type NotificationEventType =
  | "dns_record_added"
  | "dns_record_removed"
  | "ssl_cert_replaced"
  | "ssl_status_changed"
  | "http_status_changed"
  | "expiration_reminder";

/** Delivery channel kinds supported (email + webhook since V0.6; telegram since V0.7.x). */
export type ChannelType = "email" | "webhook" | "telegram";

/** A normalized notification event (pure-function output). */
export interface NotificationEvent {
  domainId: number;
  source: NotificationSource;
  eventType: NotificationEventType;
  /** JSON-encoded previous state, or null when there was none (e.g. added). */
  previousState: string | null;
  /** JSON-encoded current state, or null when there is none (e.g. removed). */
  currentState: string | null;
  occurredAt: Date;
  /**
   * Stable identity of one concrete state transition. Two events with the
   * same key describe the same transition and must not both be recorded.
   * Examples:
   *   http:5:http_status_changed:ok:down
   *   ssl:5:ssl_cert_replaced:<oldFp>:<newFp>
   *   dns:5:dns_record_added:A:1.2.3.4
   */
  dedupKey: string;
}

/** Rule filter shape used by the pure matching functions. */
export interface NotificationRuleFilter {
  channelId: number;
  /** null = match all sources. */
  source: NotificationSource | null;
  /** null = match all event types. */
  eventType: NotificationEventType | null;
  /** null = match all domains. */
  domainId: number | null;
  enabled: boolean;
}

/**
 * Delivery state machine (Phase 4A):
 *
 *   pending ──claim──▶ sending ──markDeliverySent──▶ sent
 *                          │
 *                          └──markDeliveryFailed──▶ failed ──retryDelivery──▶ pending
 *
 * - `claimPendingDelivery` is the ONLY way out of `pending` (atomic,
 *   attempts++); a concurrent worker claiming the same delivery fails.
 * - `sent` is terminal; `failed` can be retried back to `pending`.
 * - A `sending` delivery whose claim is stale (worker crashed) can be
 *   recovered back to `pending` via `recoverStaleSending`.
 */
export type DeliveryStatus = "pending" | "sending" | "sent" | "failed";

/** Abstract sender contract. Phase 4A defines it; Phase 4B/4C implement it. */
export interface DeliverySender {
  /** The channel type this sender handles ("email" | "webhook"). */
  readonly channelType: ChannelType;
  /**
   * Perform one send attempt. Must throw on failure (the caller marks the
   * delivery failed) and resolve on success (the caller marks it sent).
   * Implementations must be idempotent-safe and never send twice for the
   * same delivery id.
   */
  send(
    deliveryId: number,
    event: NotificationEvent,
    channel: { id: number; config: string },
  ): Promise<void>;
}
