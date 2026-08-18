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
import {
  parseTelegramConfig,
  isValidTelegramChatId,
  fetchTelegramBotInfo,
  TelegramError,
  isValidTelegramBotToken,
} from "./senders/telegram";
import { hasChannelSecret, setChannelSecret } from "./secrets";
import { createSender } from "./senders/factory";
import { getDomainById } from "@/lib/domains";
import { requireAdmin } from "@/lib/auth/admin";
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

const UNAUTHORIZED_ERROR = "unauthorized";

/**
 * Read-only overview for the /notifications page: channels, rules, and
 * delivery history in display shape. Never fails the page on a single bad
 * config — invalid channel configs surface as `configInvalid`.
 */
export async function getNotificationsOverviewAction(): Promise<NotificationsOverview> {
  if (!(await requireAdmin())) {
    return { ok: false, error: UNAUTHORIZED_ERROR };
  }
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
  if (!(await requireAdmin())) {
    return { ok: false, error: UNAUTHORIZED_ERROR };
  }
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
const RULE_SOURCES = new Set<string>(["dns", "ssl", "http", "expiration"]);
const RULE_EVENT_TYPES = new Set<string>([
  "dns_record_added",
  "dns_record_removed",
  "ssl_cert_replaced",
  "ssl_status_changed",
  "http_status_changed",
  "expiration_reminder",
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
      // secretRef is optional since 9G (encrypted secret storage); the
      // legacy env-var NAME form stays accepted when present.
      if (parsed.secretRef !== undefined && !isEnvVarName(parsed.secretRef)) {
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
  if (!(await requireAdmin())) {
    return { ok: false, error: "unauthorized" };
  }
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
  if (!(await requireAdmin())) {
    return { ok: false, error: "unauthorized" };
  }
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
  if (!(await requireAdmin())) {
    return { ok: false, error: "unauthorized" };
  }
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
  if (!(await requireAdmin())) {
    return { ok: false, error: "unauthorized" };
  }
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

// ---------------------------------------------------------------------------
// Telegram token UI (Phase 9G)
//
// The UI never sees, stores, or returns a bot token. `verify` only returns
// the bot's PUBLIC identity; `save` validates via getMe, then persists the
// token ENCRYPTED in notification_secrets (9F) — the channel config holds
// only non-secret values ({ chatId }). Errors are machine codes; token
// values never reach logs, errors, HTML/RSC, or SQLite plaintext.
// ---------------------------------------------------------------------------

/** Secret key under which a Telegram bot token is stored (9F). */
const TELEGRAM_TOKEN_SECRET_KEY = "token";

const TELEGRAM_ERROR_CODES: Record<TelegramError["code"], string> = {
  "invalid-config": "invalid_token",
  rejected: "telegram_rejected",
  timeout: "telegram_timeout",
  network: "telegram_network",
  redirect: "telegram_redirect",
  "invalid-response": "telegram_invalid_response",
};

/** Map a TelegramError to a user-safe machine code (never leaks details). */
function telegramVerifyErrorCode(error: unknown): string {
  if (error instanceof TelegramError) {
    return TELEGRAM_ERROR_CODES[error.code] ?? "telegram_rejected";
  }
  return "telegram_rejected";
}

/** Legacy env-based token present in the channel config (Phase 7G). */
function hasLegacyTelegramSecret(config: string): boolean {
  try {
    const parsed = parseTelegramConfig(config);
    return parsed.secretRef !== undefined;
  } catch {
    return false;
  }
}

export type VerifyTelegramTokenActionResult =
  | { ok: true; bot: { username: string | null; firstName: string | null } }
  | { ok: false; error: string };

/**
 * Validate a Telegram bot token via getMe. Returns ONLY public bot identity;
 * never saves, never writes the DB, never returns/echoes the token.
 */
export async function verifyTelegramTokenAction(input: {
  token: unknown;
}): Promise<VerifyTelegramTokenActionResult> {
  if (!(await requireAdmin())) {
    return { ok: false, error: UNAUTHORIZED_ERROR };
  }
  if (typeof input.token !== "string" || !isValidTelegramBotToken(input.token.trim())) {
    return { ok: false, error: "invalid_token" };
  }
  try {
    const bot = await fetchTelegramBotInfo(input.token.trim());
    return { ok: true, bot: { username: bot.username, firstName: bot.firstName } };
  } catch (error) {
    // Controlled failure — machine code only; the error object never
    // contains the token or the Telegram URL.
    return { ok: false, error: telegramVerifyErrorCode(error) };
  }
}

export async function saveTelegramChannelAction(input: {
  channelId: unknown;
  name: unknown;
  chatId: unknown;
  token: unknown;
  enabled: unknown;
}): Promise<CrudResult> {
  if (!(await requireAdmin())) {
    return { ok: false, error: UNAUTHORIZED_ERROR };
  }

  if (typeof input.name !== "string" || input.name.trim().length === 0) {
    return { ok: false, error: "invalid_name" };
  }
  if (typeof input.chatId !== "string" || !isValidTelegramChatId(input.chatId.trim())) {
    return { ok: false, error: "invalid_chat_id" };
  }
  if (typeof input.enabled !== "boolean") {
    return { ok: false, error: "invalid_enabled" };
  }

  const channelId =
    input.channelId === null || input.channelId === undefined ? null : input.channelId;
  if (channelId !== null && (typeof channelId !== "number" || !Number.isInteger(channelId))) {
    return { ok: false, error: "invalid_channel_id" };
  }

  const token = typeof input.token === "string" ? input.token.trim() : "";
  const chatId = input.chatId.trim();
  const name = input.name.trim();

  let existing: NotificationChannel | undefined;
  if (channelId !== null) {
    existing = getChannel(channelId);
    if (!existing) {
      return { ok: false, error: "channel_not_found" };
    }
    if (existing.type !== "telegram") {
      return { ok: false, error: "invalid_channel_type" };
    }
  }

  if (token.length > 0) {
    // Validate FIRST — on failure nothing is written to the DB.
    try {
      await fetchTelegramBotInfo(token);
    } catch (error) {
      return { ok: false, error: telegramVerifyErrorCode(error) };
    }
  } else if (channelId === null) {
    // Create always requires a token — a tokenless channel is unsendable.
    return { ok: false, error: "token_required" };
  } else {
    // Edit with empty token: keep the existing secret. Refuse to save a
    // tokenless state unless a secret (or legacy env ref) already exists.
    // `existing` is guaranteed here (channelId !== null → fetched above).
    const existingChannel = existing as NotificationChannel;
    const hasSecret = hasChannelSecret(channelId, TELEGRAM_TOKEN_SECRET_KEY);
    const hasLegacy = hasLegacyTelegramSecret(existingChannel.config);
    if (!hasSecret && !hasLegacy) {
      return { ok: false, error: "token_required" };
    }
  }

  // Non-secret config only — the token NEVER goes into the channel config.
  // On edit, a legacy env ref (if present) is PRESERVED so 9G never
  // orphans an existing legacy token mid-flight (Phase 9H migrates it).
  let config: string;
  if (channelId !== null) {
    const legacyRef = hasLegacyTelegramSecret((existing as NotificationChannel).config)
      ? parseTelegramConfig((existing as NotificationChannel).config).secretRef
      : undefined;
    config = JSON.stringify(legacyRef ? { chatId, secretRef: legacyRef } : { chatId });
  } else {
    config = JSON.stringify({ chatId });
  }

  try {
    if (channelId === null) {
      const id = createChannel("telegram", name, config);
      if (token.length > 0) {
        setChannelSecret(id, TELEGRAM_TOKEN_SECRET_KEY, token);
      }
      if (!input.enabled) {
        setChannelEnabled(id, false);
      }
    } else {
      updateChannel(channelId, { name, config });
      if (token.length > 0) {
        // Upsert: replaces the old encrypted secret.
        setChannelSecret(channelId, TELEGRAM_TOKEN_SECRET_KEY, token);
      }
      if (((existing as NotificationChannel).enabled === 1) !== input.enabled) {
        setChannelEnabled(channelId, input.enabled);
      }
    }
  } catch (error) {
    // Deliberately generic — the underlying error is never surfaced.
    console.error("[notifications] saveTelegramChannel failed:", error);
    return { ok: false, error: "save_failed" };
  }
  revalidatePath("/notifications");
  return { ok: true };
}

export type ChannelSecretStatusResult =
  { ok: true; hasToken: boolean } | { ok: false; error: string };

/**
 * Whether a channel has a token configured. Returns ONLY a boolean — never
 * the token, ciphertext, or secretRef.
 */
export async function getChannelSecretStatusAction(input: {
  channelId: unknown;
}): Promise<ChannelSecretStatusResult> {
  if (!(await requireAdmin())) {
    return { ok: false, error: UNAUTHORIZED_ERROR };
  }
  if (typeof input.channelId !== "number" || !Number.isInteger(input.channelId)) {
    return { ok: false, error: "invalid_channel_id" };
  }
  const channel = getChannel(input.channelId);
  if (!channel) {
    return { ok: false, error: "channel_not_found" };
  }
  return { ok: true, hasToken: hasChannelSecret(input.channelId, TELEGRAM_TOKEN_SECRET_KEY) };
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
  if (!(await requireAdmin())) {
    return { ok: false, error: "unauthorized" };
  }
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
  if (!(await requireAdmin())) {
    return { ok: false, error: "unauthorized" };
  }
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
  if (!(await requireAdmin())) {
    return { ok: false, error: "unauthorized" };
  }
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
  if (!(await requireAdmin())) {
    return { ok: false, error: "unauthorized" };
  }
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
      if (config.secretRef !== undefined) {
        // Legacy Phase 7G env-based token. The env var NAME is intentionally
        // hidden from the UI — users only see that a legacy config exists.
        configFields.push({ label: "Legacy token", value: "configured via environment" });
      }
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
