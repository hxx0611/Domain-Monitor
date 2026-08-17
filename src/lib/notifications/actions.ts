"use server";

import { revalidatePath } from "next/cache";
import {
  createChannel,
  createRule,
  deleteChannel,
  deleteRule,
  getChannel,
  getChannels,
  getDeliveriesWithDetails,
  getDelivery,
  getEvent,
  getRules,
  retryDelivery,
  setChannelEnabled,
  setRuleEnabled,
  updateChannel,
  updateRule,
  type DeliveryWithDetailsRow,
  type NewRuleFields,
  type RuleWithChannelRow,
} from "./repository";
import { deliverDelivery } from "./service";
import { parseWebhookConfig, validateWebhookUrl, defaultLookup } from "./senders/webhook";
import { parseEmailConfig } from "./senders/email";
import { parseTelegramConfig, isValidTelegramChatId } from "./senders/telegram";
import { createSender } from "./senders/factory";
import { getDomainById } from "@/lib/domains";
import type {
  ChannelType,
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
  channelId: number;
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
// Channel & rule CRUD (Phase 8B)
// ---------------------------------------------------------------------------
//
// All inputs come from the client and are re-validated here — the UI is
// never trusted. Errors are controlled machine codes; underlying SQLite /
// fetch / exception messages never reach the user. Config values are
// persisted exactly as the validated sender contracts define them
// (secretRef only — env values are never read, stored, or returned).

export type CrudResult = { ok: true } | { ok: false; error: string };

const CHANNEL_TYPES = new Set<string>(["email", "webhook", "telegram"]);
const RULE_SOURCES = new Set<string>(["dns", "ssl", "http"]);
const RULE_EVENT_TYPES = new Set<string>([
  "dns_record_added",
  "dns_record_removed",
  "ssl_cert_replaced",
  "ssl_status_changed",
  "http_status_changed",
]);
const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isEnvVarName(value: string): boolean {
  return ENV_VAR_NAME_RE.test(value);
}

/**
 * Validate a channel config JSON string against its type's sender
 * contract. Webhook/email endpoints additionally pass the full SSRF
 * validation (https + DNS/IP safety, reusing the sender implementation).
 * Returns the normalized config JSON to persist.
 */
async function validateChannelConfigForWrite(
  type: ChannelType,
  configJson: string,
): Promise<{ ok: true; config: string } | { ok: false; error: string }> {
  try {
    if (type === "email") {
      const parsed = parseEmailConfig(configJson);
      if (!isEnvVarName(parsed.apiKeyRef)) {
        return { ok: false, error: "invalid_secret_ref" };
      }
      await validateWebhookUrl(parsed.endpoint, defaultLookup);
      return { ok: true, config: JSON.stringify(parsed) };
    }
    if (type === "webhook") {
      const parsed = parseWebhookConfig(configJson);
      if (parsed.secretRef !== undefined && !isEnvVarName(parsed.secretRef)) {
        return { ok: false, error: "invalid_secret_ref" };
      }
      await validateWebhookUrl(parsed.url, defaultLookup);
      return { ok: true, config: JSON.stringify(parsed) };
    }
    if (type === "telegram") {
      const parsed = parseTelegramConfig(configJson);
      if (!isValidTelegramChatId(parsed.chatId)) {
        return { ok: false, error: "invalid_chat_id" };
      }
      if (!isEnvVarName(parsed.secretRef)) {
        return { ok: false, error: "invalid_secret_ref" };
      }
      return { ok: true, config: JSON.stringify(parsed) };
    }
    return { ok: false, error: "invalid_channel_type" };
  } catch {
    return { ok: false, error: "invalid_config" };
  }
}

export async function createChannelAction(input: {
  type: unknown;
  name: unknown;
  config: unknown;
}): Promise<CrudResult> {
  if (typeof input.type !== "string" || !CHANNEL_TYPES.has(input.type)) {
    return { ok: false, error: "invalid_channel_type" };
  }
  if (typeof input.name !== "string" || input.name.trim().length === 0) {
    return { ok: false, error: "invalid_name" };
  }
  if (typeof input.config !== "string") {
    return { ok: false, error: "invalid_config" };
  }

  const validated = await validateChannelConfigForWrite(input.type as ChannelType, input.config);
  if (!validated.ok) {
    return validated;
  }

  try {
    createChannel(input.type as ChannelType, input.name.trim(), validated.config);
  } catch (error) {
    console.error("[notifications] createChannel failed:", error);
    return { ok: false, error: "create_failed" };
  }
  revalidatePath("/notifications");
  return { ok: true };
}

export async function updateChannelAction(input: {
  id: unknown;
  name?: unknown;
  config?: unknown;
}): Promise<CrudResult> {
  if (typeof input.id !== "number" || !Number.isInteger(input.id)) {
    return { ok: false, error: "invalid_channel_id" };
  }
  const channel = getChannel(input.id);
  if (!channel) {
    return { ok: false, error: "channel_not_found" };
  }

  const fields: { name?: string; config?: string } = {};
  if (input.name !== undefined) {
    if (typeof input.name !== "string" || input.name.trim().length === 0) {
      return { ok: false, error: "invalid_name" };
    }
    fields.name = input.name.trim();
  }
  if (input.config !== undefined) {
    if (typeof input.config !== "string") {
      return { ok: false, error: "invalid_config" };
    }
    const validated = await validateChannelConfigForWrite(
      channel.type as ChannelType,
      input.config,
    );
    if (!validated.ok) {
      return validated;
    }
    fields.config = validated.config;
  }
  if (Object.keys(fields).length === 0) {
    return { ok: false, error: "nothing_to_update" };
  }

  try {
    if (!updateChannel(input.id, fields)) {
      return { ok: false, error: "channel_not_found" };
    }
  } catch (error) {
    console.error("[notifications] updateChannel failed:", error);
    return { ok: false, error: "update_failed" };
  }
  revalidatePath("/notifications");
  return { ok: true };
}

export async function setChannelEnabledAction(input: {
  id: unknown;
  enabled: unknown;
}): Promise<CrudResult> {
  if (typeof input.id !== "number" || !Number.isInteger(input.id)) {
    return { ok: false, error: "invalid_channel_id" };
  }
  if (typeof input.enabled !== "boolean") {
    return { ok: false, error: "invalid_enabled" };
  }
  try {
    if (!setChannelEnabled(input.id, input.enabled)) {
      return { ok: false, error: "channel_not_found" };
    }
  } catch (error) {
    console.error("[notifications] setChannelEnabled failed:", error);
    return { ok: false, error: "update_failed" };
  }
  revalidatePath("/notifications");
  return { ok: true };
}

export async function deleteChannelAction(input: { id: unknown }): Promise<CrudResult> {
  if (typeof input.id !== "number" || !Number.isInteger(input.id)) {
    return { ok: false, error: "invalid_channel_id" };
  }
  try {
    if (!deleteChannel(input.id)) {
      return { ok: false, error: "channel_not_found" };
    }
  } catch (error) {
    console.error("[notifications] deleteChannel failed:", error);
    return { ok: false, error: "delete_failed" };
  }
  revalidatePath("/notifications");
  return { ok: true };
}

interface RuleWriteInput {
  name: unknown;
  channelId: unknown;
  source: unknown;
  eventType: unknown;
  domainId: unknown;
  enabled: unknown;
}

type ValidatedRule = NewRuleFields;

/** Validate a rule input; null source/eventType/domainId mean "All". */
function validateRuleWriteInput(
  input: RuleWriteInput,
): { ok: true; value: ValidatedRule } | { ok: false; error: string } {
  if (typeof input.name !== "string" || input.name.trim().length === 0) {
    return { ok: false, error: "invalid_name" };
  }
  if (typeof input.channelId !== "number" || !Number.isInteger(input.channelId)) {
    return { ok: false, error: "invalid_channel_id" };
  }
  const channel = getChannel(input.channelId);
  if (!channel) {
    return { ok: false, error: "channel_not_found" };
  }

  const source = input.source === undefined ? null : input.source;
  if (source !== null && (typeof source !== "string" || !RULE_SOURCES.has(source))) {
    return { ok: false, error: "invalid_source" };
  }

  const eventType = input.eventType === undefined ? null : input.eventType;
  if (eventType !== null && (typeof eventType !== "string" || !RULE_EVENT_TYPES.has(eventType))) {
    return { ok: false, error: "invalid_event_type" };
  }

  const domainId = input.domainId === undefined ? null : input.domainId;
  if (domainId !== null) {
    if (typeof domainId !== "number" || !Number.isInteger(domainId)) {
      return { ok: false, error: "invalid_domain_id" };
    }
    const domain = getDomainById(domainId);
    if (!domain) {
      return { ok: false, error: "domain_not_found" };
    }
  }

  if (typeof input.enabled !== "boolean") {
    return { ok: false, error: "invalid_enabled" };
  }

  return {
    ok: true,
    value: {
      name: input.name.trim(),
      channelId: input.channelId,
      source: source as string | null,
      eventType: eventType as string | null,
      domainId: domainId as number | null,
      enabled: input.enabled,
    },
  };
}

export async function createRuleAction(input: RuleWriteInput): Promise<CrudResult> {
  const validated = validateRuleWriteInput(input);
  if (!validated.ok) {
    return validated;
  }
  try {
    createRule(validated.value);
  } catch (error) {
    console.error("[notifications] createRule failed:", error);
    return { ok: false, error: "create_failed" };
  }
  revalidatePath("/notifications");
  return { ok: true };
}

export async function updateRuleAction(
  input: { id: unknown } & RuleWriteInput,
): Promise<CrudResult> {
  if (typeof input.id !== "number" || !Number.isInteger(input.id)) {
    return { ok: false, error: "invalid_rule_id" };
  }
  const validated = validateRuleWriteInput(input);
  if (!validated.ok) {
    return validated;
  }
  try {
    if (!updateRule(input.id, validated.value)) {
      return { ok: false, error: "rule_not_found" };
    }
  } catch (error) {
    console.error("[notifications] updateRule failed:", error);
    return { ok: false, error: "update_failed" };
  }
  revalidatePath("/notifications");
  return { ok: true };
}

export async function setRuleEnabledAction(input: {
  id: unknown;
  enabled: unknown;
}): Promise<CrudResult> {
  if (typeof input.id !== "number" || !Number.isInteger(input.id)) {
    return { ok: false, error: "invalid_rule_id" };
  }
  if (typeof input.enabled !== "boolean") {
    return { ok: false, error: "invalid_enabled" };
  }
  try {
    if (!setRuleEnabled(input.id, input.enabled)) {
      return { ok: false, error: "rule_not_found" };
    }
  } catch (error) {
    console.error("[notifications] setRuleEnabled failed:", error);
    return { ok: false, error: "update_failed" };
  }
  revalidatePath("/notifications");
  return { ok: true };
}

export async function deleteRuleAction(input: { id: unknown }): Promise<CrudResult> {
  if (typeof input.id !== "number" || !Number.isInteger(input.id)) {
    return { ok: false, error: "invalid_rule_id" };
  }
  try {
    if (!deleteRule(input.id)) {
      return { ok: false, error: "rule_not_found" };
    }
  } catch (error) {
    console.error("[notifications] deleteRule failed:", error);
    return { ok: false, error: "delete_failed" };
  }
  revalidatePath("/notifications");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Display mapping (module-private)
// ---------------------------------------------------------------------------

// Sender instantiation lives in senders/factory.ts (shared with the V0.7
// delivery worker); actions.ts only needs the ChannelType import for views.

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
    } else if (row.type === "webhook") {
      const config = parseWebhookConfig(row.config);
      configFields.push({ label: "URL", value: config.url });
      if (config.secretRef !== undefined) {
        // Ref NAME only (e.g. "WEBHOOK_SECRET") — never the secret value.
        configFields.push({ label: "Secret ref", value: config.secretRef });
      }
    } else if (row.type === "telegram") {
      const config = parseTelegramConfig(row.config);
      configFields.push({ label: "Chat ID", value: config.chatId });
      // Ref NAME only (e.g. "TELEGRAM_BOT_TOKEN") — never the token value.
      configFields.push({ label: "Secret ref", value: config.secretRef });
    } else {
      // Unknown channel type: never fall back to a webhook parse.
      configInvalid = true;
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
    channelId: row.channelId,
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
