/**
 * Telegram notification sender (V0.7.x — Phase 7E) + bot-token verification
 * (Phase 9G).
 *
 * Fixed endpoint `https://api.telegram.org` — there is NO user-configurable
 * URL, so this sender adds no SSRF surface (unlike the webhook sender).
 *
 * Channel config contract (V0.7.x legacy):
 *   { "chatId": "<chat_id>", "secretRef": "TELEGRAM_BOT_TOKEN" }
 * `secretRef` is an environment variable NAME. The token value is read from
 * the environment at send time and must NEVER appear in the database,
 * payload, error messages, or logs.
 *
 * Config contract (Phase 9G+):
 *   { "chatId": "<chat_id>" }
 * `secretRef` becomes OPTIONAL: new channels store the bot token encrypted
 * in `notification_secrets` (9F) instead of an env var name. The legacy
 * `secretRef` form remains parseable for backwards compatibility.
 *
 * Token resolution (Phase 9H) — priority:
 *   A. `notification_secrets` row for (channelId, key="token") → decrypt
 *   B. legacy env fallback: config.secretRef → process.env[secretRef]
 *   C. neither → controlled failure
 * `resolveSecret` is injected by the factory (real repository) or tests
 * (fake resolver) — the sender never touches the DB itself. Decryption
 * failure is surfaced, never masked as "no secret", and never falls back
 * to env.
 *
 * Message body is plain text (no Markdown/HTML — avoids injection and
 * formatting surprises). Success is determined by the Telegram API's `ok`
 * field, NOT by HTTP 200 alone.
 */

import type { DeliverySender, NotificationEvent } from "../types";

/** Telegram channel configuration (ref-only — no token value). */
export interface TelegramChannelConfig {
  chatId: string;
  /**
   * Legacy: environment variable NAME holding the bot token. Optional in
   * 9G+ — encrypted secrets in `notification_secrets` replace it.
   */
  secretRef?: string;
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

/**
 * Secret key under which a Telegram bot token is stored in
 * `notification_secrets` (9F/9G). Mirrors the actions-layer constant.
 */
const TELEGRAM_TOKEN_SECRET_KEY = "token";

export interface TelegramSenderOptions {
  /** Injectable fetch for tests. */
  fetchFn?: typeof fetch;
  /** Injectable env map (defaults to process.env). */
  env?: Record<string, string | undefined>;
  /** Resolve a domain id → hostname for the message (tests inject a fake). */
  resolveDomain?: (domainId: number) => string | undefined;
  /**
   * Phase 9H: resolve an encrypted channel secret (notification_secrets)
   * by channel id + key → plaintext or null. Injected by the factory
   * (real repository) or tests (fake). Implementations may throw on
   * decryption failure — surfaced as a controlled error, never masked as
   * "no secret" and never falling back to env.
   */
  resolveSecret?: (channelId: number, key: string) => Promise<string | null>;
}

const EVENT_LABELS: Record<string, string> = {
  dns_record_added: "DNS record added",
  dns_record_removed: "DNS record removed",
  ssl_cert_replaced: "SSL certificate replaced",
  ssl_status_changed: "SSL status changed",
  http_status_changed: "HTTP status changed",
  // Phase 11G-A: admin-triggered test notification is rendered explicitly
  // as a test message so recipients can never mistake it for a real alert.
  test_notification: "Test Notification",
};

/** Telegram chat id: private chats are a positive integer; groups /
 * supergroups / channels are negative (often -100...). Loose-but-strict
 * digit format check used by the actions layer before persisting config.
 */
export function isValidTelegramChatId(chatId: string): boolean {
  return /^-?\d{4,}$/.test(chatId);
}

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
  // secretRef is optional since Phase 9G (encrypted secret storage).
  if (secretRef !== undefined && (typeof secretRef !== "string" || secretRef.length === 0)) {
    throw new TelegramError(
      "Telegram channel config secretRef must be a non-empty string when present.",
      "invalid-config",
    );
  }
  return { chatId, ...(secretRef !== undefined ? { secretRef } : {}) };
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
  private readonly resolveSecret:
    ((channelId: number, key: string) => Promise<string | null>) | undefined;

  constructor(options: TelegramSenderOptions = {}) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.env = options.env ?? process.env;
    this.resolveDomain = options.resolveDomain ?? (() => undefined);
    this.resolveSecret = options.resolveSecret;
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

    // Phase 9H token resolution priority:
    //   A. encrypted notification_secrets token (key "token")
    //   B. legacy env fallback via config.secretRef
    //   C. controlled failure
    let token: string | null = null;
    if (this.resolveSecret) {
      try {
        token = await this.resolveSecret(channel.id, TELEGRAM_TOKEN_SECRET_KEY);
      } catch {
        // Decryption failure is surfaced — never masked as "no secret"
        // and never silently falls back to env. Message is secret-free.
        throw new TelegramError("Telegram token decryption failed.", "invalid-config");
      }
    }
    if (!token) {
      token = config.secretRef ? (this.env[config.secretRef] ?? null) : null;
    }
    if (!token || token.length === 0) {
      throw new TelegramError(
        "Telegram token is not configured for this channel.",
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
      // Phase 11G-C: surface Telegram's rejection reason (response body
      // `description`) so 403-class failures can be diagnosed, while
      // keeping the error message secret-free: description is truncated,
      // token/URL-shaped substrings are redacted, and any body read
      // failure falls back to the status-only message.
      throw new TelegramError(
        telegramRejectedMessage(response.status, await readTelegramDescription(response)),
        "rejected",
      );
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

// ---------------------------------------------------------------------------
// Rejection description extraction (Phase 11G-C)
//
// When Telegram rejects a send with a non-2xx status, its response body is
// JSON like `{"ok":false,"error_code":403,"description":"Forbidden: bot
// was blocked by the user"}`. The `description` is the only piece of
// actionable diagnosis we get, but it MUST be sanitized before it can live
// in delivery.error: redact bot-token-shaped and URL-shaped substrings,
// truncate, and fail soft (status-only message) if the body is not JSON.
// ---------------------------------------------------------------------------

/** Max length of a Telegram rejection description kept in error messages. */
const TELEGRAM_DESCRIPTION_MAX = 200;

/** Build the controlled "rejected" error message for a non-2xx response. */
export function telegramRejectedMessage(status: number, description: string | null): string {
  if (!description) {
    return `Telegram API returned HTTP ${status}.`;
  }
  return `Telegram API returned HTTP ${status}: ${description}`;
}

/**
 * Read and sanitize a Telegram API error body's `description` field.
 * Returns null when the body is missing, non-JSON, or has no description.
 * Never throws — any read failure degrades to the status-only message.
 */
export async function readTelegramDescription(response: Response): Promise<string | null> {
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    return null;
  }
  if (!isRecord(raw)) {
    return null;
  }
  const description = raw.description;
  if (typeof description !== "string" || description.length === 0) {
    return null;
  }
  return sanitizeTelegramDescription(description);
}

/**
 * Redact secret-shaped substrings and truncate a Telegram description.
 * - bot token shape `\d{4,}:[A-Za-z0-9_-]{20,}` → `[token]`
 * - URL shape `https?://...` → `[url]`
 * - then truncate to TELEGRAM_DESCRIPTION_MAX chars.
 */
export function sanitizeTelegramDescription(description: string): string {
  const redacted = description
    .replace(/\d{4,}:[A-Za-z0-9_-]{20,}/g, "[token]")
    .replace(/https?:\/\/[^\s"]+/g, "[url]");
  return redacted.length > TELEGRAM_DESCRIPTION_MAX
    ? `${redacted.slice(0, TELEGRAM_DESCRIPTION_MAX)}…`
    : redacted;
}

// ---------------------------------------------------------------------------
// Bot token verification (Phase 9G)
//
// Calls ONLY `https://api.telegram.org/bot<TOKEN>/getMe` to validate a bot
// token and read the bot's PUBLIC identity. Never sendMessage; never a
// user-supplied endpoint; the token appears only inside the request URL
// and is NEVER echoed into errors, logs, or the returned object.
// ---------------------------------------------------------------------------

/** Public bot identity returned by getMe — nothing secret. */
export interface TelegramBotInfo {
  username: string | null;
  firstName: string | null;
}

export interface FetchBotInfoOptions {
  /** Injectable fetch for tests. */
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

/** Loose Telegram bot-token shape: `<digits>:<alnum>`. */
export function isValidTelegramBotToken(token: string): boolean {
  return /^\d{4,}:[A-Za-z0-9_-]{20,}$/.test(token.trim());
}

/**
 * Validate a bot token via Telegram getMe and return its public identity.
 * Controlled failures (TelegramError): invalid format, HTTP non-2xx
 * (400/401/429/500… → "rejected"), `{ok:false}`, malformed JSON, missing
 * result, timeout, network, redirect (3xx never followed). Error messages
 * never contain the token or the full URL.
 */
export async function fetchTelegramBotInfo(
  token: string,
  options: FetchBotInfoOptions = {},
): Promise<TelegramBotInfo> {
  const trimmed = token.trim();
  if (!isValidTelegramBotToken(trimmed)) {
    throw new TelegramError("Invalid Telegram bot token format.", "invalid-config");
  }
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? TELEGRAM_TIMEOUT_MS;
  const url = `${TELEGRAM_API_BASE}/bot${trimmed}/getMe`;

  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
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

  if (!isRecord(raw) || raw.ok !== true) {
    throw new TelegramError("Telegram API rejected the request.", "rejected");
  }
  const result = raw.result;
  if (!isRecord(result)) {
    throw new TelegramError("Telegram API response is missing the bot result.", "invalid-response");
  }

  const username = readOptionalString(result.username);
  const firstName = readOptionalString(result.first_name);
  if (username === undefined || firstName === undefined) {
    throw new TelegramError("Telegram API returned malformed bot fields.", "invalid-response");
  }
  return { username, firstName };
}

/** string | null accepted; missing or non-string → undefined (caller fails). */
function readOptionalString(value: unknown): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value === "string") {
    return value;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Re-exported for tests.
export { EVENT_LABELS };
