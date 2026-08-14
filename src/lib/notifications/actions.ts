"use server";

import { revalidatePath } from "next/cache";
import {
  getChannel,
  getChannels,
  getDeliveriesWithDetails,
  getDelivery,
  getEvent,
  getRules,
  retryDelivery,
  type DeliveryWithDetailsRow,
  type RuleWithChannelRow,
} from "./repository";
import { deliverDelivery } from "./service";
import { WebhookSender, parseWebhookConfig } from "./senders/webhook";
import { EmailSender, parseEmailConfig } from "./senders/email";
import type {
  ChannelType,
  DeliverySender,
  DeliveryStatus,
  NotificationEvent,
  NotificationEventType,
  NotificationSource,
} from "./types";
import type { NotificationChannel, NotificationEventRow } from "@/db/schema";

/**
 * Server actions for the /notifications UI (V0.6 Phase 5B).
 *
 * This is the ONLY bridge between the UI and the notification pipeline:
 * components never import senders, repository functions, or service
 * functions directly. Read-only queries return pre-shaped display rows;
 * retry is the single write path (failed → pending → send).
 *
 * Secret policy: channel config fields shown are limited to non-sensitive
 * values. `apiKeyRef` / `secretRef` are rendered as the env var NAME only —
 * env values are never read or displayed anywhere in the UI.
 */

export interface ChannelConfigField {
  /** Field label, e.g. "To", "URL", "API key ref". */
  label: string;
  /** Non-sensitive display value. */
  value: string;
}

export interface ChannelView {
  id: number;
  type: ChannelType;
  name: string;
  enabled: boolean;
  /** Non-sensitive config fields for display; empty when config is invalid. */
  configFields: ChannelConfigField[];
  configInvalid: boolean;
}

export interface RuleView {
  id: number;
  name: string;
  channelName: string | null;
  source: NotificationSource | null;
  eventType: NotificationEventType | null;
  domainId: number | null;
  hostname: string | null;
  enabled: boolean;
}

export interface DeliveryView {
  deliveryId: number;
  eventId: number;
  eventType: NotificationEventType;
  source: NotificationSource;
  domainId: number | null;
  hostname: string | null;
  channelName: string | null;
  status: DeliveryStatus;
  attempts: number;
  error: string | null;
  createdAt: Date;
  deliveredAt: Date | null;
}

export type NotificationsOverview =
  | { ok: true; channels: ChannelView[]; rules: RuleView[]; deliveries: DeliveryView[] }
  | { ok: false; error: string };

export type RetryDeliveryActionResult =
  { ok: true; status: DeliveryStatus } | { ok: false; error: string };

/**
 * Read-only overview for the /notifications page: channels, rules, and
 * delivery history in display shape. Never fails the page on a single bad
 * config — invalid channel configs surface as `configInvalid`.
 */
export async function getNotificationsOverviewAction(): Promise<NotificationsOverview> {
  try {
    const channels = getChannels();
    const rules = getRules();
    const deliveries = getDeliveriesWithDetails();
    return {
      ok: true,
      channels: channels.map(toChannelView),
      rules: rules.map(toRuleView),
      deliveries: deliveries.map(toDeliveryView),
    };
  } catch (error) {
    console.error("[notifications] failed to load overview:", error);
    return { ok: false, error: "Failed to load notifications." };
  }
}

/**
 * Retry a failed delivery: failed → pending, then send immediately through
 * the channel's sender. Only `failed` deliveries can be retried; anything
 * else returns a user-safe error. Sender errors (including a missing email
 * API key) are passed through as-is — they are guaranteed secret-free.
 */
export async function retryDeliveryAction(deliveryId: number): Promise<RetryDeliveryActionResult> {
  const delivery = getDelivery(deliveryId);

  if (!delivery) {
    return { ok: false, error: "Delivery not found." };
  }
  if (delivery.status !== "failed") {
    return { ok: false, error: "Only failed deliveries can be retried." };
  }

  // failed → pending so deliverDelivery can claim it. The CAS inside
  // retryDelivery returns false when a concurrent retry already flipped it.
  if (!retryDelivery(deliveryId)) {
    return { ok: false, error: "Delivery could not be retried." };
  }

  const pending = getDelivery(deliveryId);
  if (!pending) {
    return { ok: false, error: "Delivery not found." };
  }

  const channel = getChannel(pending.channelId);
  const event = getEvent(pending.eventId);

  if (!channel || !event) {
    return { ok: false, error: "Delivery channel or event is missing." };
  }

  const sender = createSender(channel.type as ChannelType);
  const result = await deliverDelivery(deliveryId, toNotificationEvent(event), sender);

  if (result.status === "skipped") {
    return { ok: false, error: "Delivery could not be claimed for retry." };
  }
  if (result.status === "failed") {
    return { ok: false, error: result.error ?? "Delivery failed." };
  }

  revalidatePath("/notifications");
  return { ok: true, status: result.status };
}

// ---------------------------------------------------------------------------
// Display mapping (module-private)
// ---------------------------------------------------------------------------

/** Instantiate the sender for a channel type. Email/webhook only (V0.6). */
function createSender(type: ChannelType): DeliverySender {
  switch (type) {
    case "email":
      return new EmailSender();
    case "webhook":
      return new WebhookSender();
  }
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

/** Non-sensitive config display fields for one channel. */
function toChannelView(row: NotificationChannel): ChannelView {
  const configFields: ChannelConfigField[] = [];
  let configInvalid = false;

  try {
    if (row.type === "email") {
      const config = parseEmailConfig(row.config);
      configFields.push({ label: "To", value: config.to });
      configFields.push({ label: "From", value: config.from });
      configFields.push({ label: "Endpoint", value: config.endpoint });
      // Ref NAME only (e.g. "EMAIL_API_KEY") — never the env value.
      configFields.push({ label: "API key ref", value: config.apiKeyRef });
    } else {
      const config = parseWebhookConfig(row.config);
      configFields.push({ label: "URL", value: config.url });
      if (config.secretRef !== undefined) {
        // Ref NAME only (e.g. "WEBHOOK_SECRET") — never the secret value.
        configFields.push({ label: "Secret ref", value: config.secretRef });
      }
    }
  } catch {
    configInvalid = true;
  }

  return {
    id: row.id,
    type: row.type as ChannelType,
    name: row.name,
    enabled: row.enabled === 1,
    configFields,
    configInvalid,
  };
}

function toRuleView(row: RuleWithChannelRow): RuleView {
  return {
    id: row.id,
    name: row.name,
    channelName: row.channelName,
    source: row.source as NotificationSource | null,
    eventType: row.eventType as NotificationEventType | null,
    domainId: row.domainId,
    hostname: row.hostname,
    enabled: row.enabled === 1,
  };
}

function toDeliveryView(row: DeliveryWithDetailsRow): DeliveryView {
  return {
    deliveryId: row.deliveryId,
    eventId: row.eventId,
    eventType: row.eventType as NotificationEventType,
    source: row.source as NotificationSource,
    domainId: row.domainId,
    hostname: row.hostname,
    channelName: row.channelName,
    status: row.status as DeliveryStatus,
    attempts: row.attempts,
    error: row.error,
    createdAt: row.createdAt,
    deliveredAt: row.deliveredAt,
  };
}
