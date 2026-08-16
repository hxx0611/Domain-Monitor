/**
 * Telegram notification sender (V0.7.x — Phase 7E).
 *
 * Fixed endpoint `https://api.telegram.org` — there is NO user-configurable
 * URL, so this sender adds no SSRF surface (unlike the webhook sender).
 *
 * Channel config contract:
 *   { "chatId": "<chat_id>", "secretRef": "TELEGRAM_BOT_TOKEN" }
 * `secretRef` is an environment variable NAME. The token value is read from
 * the environment at send time and must NEVER appear in the database,
 * payload, error messages, or logs.
 *
 * Message body is plain text (no Markdown/HTML — avoids injection and
 * formatting surprises). Success is determined by the Telegram API's `ok`
 * field, NOT by HTTP 200 alone.
 */

import type { DeliverySender, NotificationEvent } from "../types";

/** Telegram channel configuration (ref-only — no token value). */
export interface TelegramChannelConfig {
  chatId: string;
  /** Environment variable name holding the bot token. */
  secretRef: string;
}

export type TelegramErrorCode =
  "invalid-config" | "rejected" | "network" | "timeout" | "redirect" | "invalid-response";

export class TelegramError extends Error {
  readonly code: TelegramErrorCode;

  constructor(message: string, code: TelegramErrorCode) {
    super(message);
    this.name = "TelegramError";
    this.code = code;
  }
}

/** Fixed Telegram Bot API base — never user-configurable. */
export const TELEGRAM_API_BASE = "https://api.telegram.org";
export const TELEGRAM_TIMEOUT_MS = 8_000;

export interface TelegramSenderOptions {
  /** Injectable fetch for tests. */
  fetchFn?: typeof fetch;
  /** Injectable env map (defaults to process.env). */
  env?: Record<string, string | undefined>;
  /** Resolve a domain id → hostname for the message (tests inject a fake). */
  resolveDomain?: (domainId: number) => string | undefined;
}

const EVENT_LABELS: Record<string, string> = {
  dns_record_added: "DNS record added",
  dns_record_removed: "DNS record removed",
  ssl_cert_replaced: "SSL certificate replaced",
  ssl_status_changed: "SSL status changed",
  http_status_changed: "HTTP status changed",
};

/** Parse the channel config JSON. Throws TelegramError("invalid-config"). */
export function parseTelegramConfig(config: string): TelegramChannelConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(config);
  } catch {
    throw new TelegramError("Telegram channel config is not valid JSON.", "invalid-config");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new TelegramError("Telegram channel config must be an object.", "invalid-config");
  }
  const { chatId, secretRef } = parsed as Record<string, unknown>;
  if (typeof chatId !== "string" || chatId.length === 0) {
    throw new TelegramError("Telegram channel config is missing a chatId.", "invalid-config");
  }
  if (typeof secretRef !== "string" || secretRef.length === 0) {
    throw new TelegramError(
      "Telegram channel config secretRef must be a non-empty string.",
      "invalid-config",
    );
  }
  return { chatId, secretRef };
}

/**
 * Build the plain-text message from an event. Never includes raw errors,
 * tokens, or stack traces. State values are rendered conservatively.
 */
export function buildTelegramMessage(
  event: NotificationEvent,
  domainHostname: string | undefined,
): string {
  const alert = event.eventType === "http_status_changed" ? statusEmoji(event) : "🔔";
  const lines = [
    `${alert} Domain Monitor`,
    `Event: ${EVENT_LABELS[event.eventType] ?? event.eventType}`,
    `Domain: ${domainHostname ?? `#${event.domainId}`}`,
  ];
  const prev = stateText(event.previousState);
  const curr = stateText(event.currentState);
  if (prev !== undefined || curr !== undefined) {
    lines.push(`Status: ${prev ?? "—"} → ${curr ?? "—"}`);
  }
  lines.push(`Time: ${event.occurredAt.toISOString()}`);
  lines.push(`Event ID: ${event.dedupKey}`);
  return lines.join("\n");
}

function statusEmoji(event: NotificationEvent): string {
  const cur = parseState(event.currentState);
  if (cur && typeof cur === "object" && "status" in cur) {
    const s = String((cur as { status: unknown }).status);
    if (s === "ok" || s === "down" || s === "server_error" || s === "client_error") {
      return s === "ok" ? "✅" : "🚨";
    }
  }
  return "🔔";
}

/** Render a serialized state value as readable plain text (truncated). */
function stateText(raw: string | null): string | undefined {
  if (raw === null || raw === undefined) {
    return undefined;
  }
  const parsed = parseState(raw);
  if (parsed !== undefined) {
    if (typeof parsed === "string") {
      return truncate(parsed);
    }
    if (parsed !== null && typeof parsed === "object") {
      const status = (parsed as Record<string, unknown>).status;
      if (typeof status === "string") {
        const httpStatus = (parsed as Record<string, unknown>).httpStatus;
        return httpStatus !== undefined && httpStatus !== null
          ? `${status} (${String(httpStatus)})`
          : status;
      }
      return truncate(JSON.stringify(parsed));
    }
  }
  return truncate(String(raw));
}

function parseState(raw: string | null): unknown {
  if (raw === null) {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function truncate(value: string, max = 200): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

export class TelegramSender implements DeliverySender {
  readonly channelType = "telegram" as const;

  private readonly fetchFn: typeof fetch;
  private readonly env: Record<string, string | undefined>;
  private readonly resolveDomain: (domainId: number) => string | undefined;

  constructor(options: TelegramSenderOptions = {}) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.env = options.env ?? process.env;
    this.resolveDomain = options.resolveDomain ?? (() => undefined);
  }

  /**
   * Send one Telegram message. Resolves on `{ok:true}`; throws on any
   * failure (HTTP non-2xx, `{ok:false}`, malformed JSON, timeout, network,
   * redirect). The bot token appears ONLY in the request URL path — never
   * in error messages, payloads, or logs.
   */
  async send(
    deliveryId: number,
    event: NotificationEvent,
    channel: { id: number; config: string },
  ): Promise<void> {
    const config = parseTelegramConfig(channel.config);
    const token = this.env[config.secretRef];
    if (!token || token.length === 0) {
      throw new TelegramError(
        `Telegram token is not configured (${config.secretRef}).`,
        "invalid-config",
      );
    }

    const url = `${TELEGRAM_API_BASE}/bot${token}/sendMessage`;
    const body = JSON.stringify({
      chat_id: config.chatId,
      text: buildTelegramMessage(event, this.resolveDomain(event.domainId)),
    });

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
        cache: "no-store",
      });
    } catch (error) {
      throw mapFetchError(error);
    }

    if (response.status >= 300 && response.status < 400) {
      throw new TelegramError("Telegram API returned a redirect; not following it.", "redirect");
    }
    if (!response.ok) {
      throw new TelegramError(`Telegram API returned HTTP ${response.status}.`, "rejected");
    }

    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      throw new TelegramError("Telegram API returned invalid JSON.", "invalid-response");
    }

    const ok = isRecord(raw) && raw.ok === true;
    if (!ok) {
      throw new TelegramError("Telegram API rejected the message.", "rejected");
    }
  }
}

function mapFetchError(error: unknown): TelegramError {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return new TelegramError("Telegram request timed out.", "timeout");
    }
  }
  return new TelegramError("Telegram request failed (network error).", "network");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Re-exported for tests.
export { EVENT_LABELS };
