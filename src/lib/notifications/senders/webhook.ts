/**
 * Webhook delivery sender (V0.6 Phase 4B).
 *
 * Threat model: the webhook URL is USER-CONFIGURED and therefore
 * untrusted. Every hop is SSRF-checked before any request is issued —
 * and the checks are NOT mockable away in tests (they run on the real
 * code path with an injected DNS lookup).
 *
 * Hard guarantees:
 * - https:// only (initial AND every redirect hop)
 * - `assertSafeHost` re-resolves DNS and rejects loopback / private /
 *   link-local / ULA / CGNAT / cloud-metadata / multicast addresses on
 *   EVERY hop (no caching → DNS rebinding cannot bypass).
 * - redirect: "manual"; each Location is re-validated (scheme + resolved
 *   IPs) before following; at most 5 hops.
 * - Fixed POST + application/json; 8s timeout; response body is never
 *   read (cancelled immediately) — only the status code matters.
 * - Payload carries stable `eventId` + `deliveryId` so the receiver can
 *   deduplicate (at-least-once semantics).
 * - `secretRef` is a reference only; the secret never appears in the
 *   payload, error messages, or logs.
 *
 * Does NOT implement HMAC/signing (deferred to a later phase).
 */

import { assertSafeHost, HttpError, isBlockedIp, type HttpClientOptions } from "@/lib/http/client";
import type { DeliverySender, NotificationEvent } from "../types";

export interface WebhookChannelConfig {
  /** Target URL (https only). */
  url: string;
  /** Reference to a secret (e.g. env var name) — never the secret itself. */
  secretRef?: string;
}

export interface WebhookSenderOptions {
  /** Injectable fetch for tests. */
  fetchFn?: typeof fetch;
  /** Injectable DNS resolver for tests: hostname → IPs. */
  lookup?: (hostname: string) => Promise<string[]>;
  /** Per-request timeout (default 8s). */
  timeoutMs?: number;
  /** Max redirects (default 5). */
  maxRedirects?: number;
}

const DEFAULT_WEBHOOK_TIMEOUT_MS = 8_000;
const DEFAULT_WEBHOOK_MAX_REDIRECTS = 5;
const WEBHOOK_USER_AGENT = "Domain-Monitor/0.6 (+https://github.com/hxx0611/Domain-Monitor)";

/** Webhook send-layer error (4xx/5xx rejection, bad config). */
export class WebhookError extends Error {
  constructor(
    message: string,
    readonly code: "webhook-rejected" | "invalid-config",
  ) {
    super(message);
    this.name = "WebhookError";
  }
}

/** Parse the channel config JSON into the webhook shape. Throws on bad config. */
export function parseWebhookConfig(config: string): WebhookChannelConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(config);
  } catch {
    throw new WebhookError("Webhook channel config is not valid JSON.", "invalid-config");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new WebhookError("Webhook channel config must be an object.", "invalid-config");
  }
  const { url, secretRef } = parsed as { url?: unknown; secretRef?: unknown };
  if (typeof url !== "string" || url.length === 0) {
    throw new WebhookError("Webhook channel config is missing a URL.", "invalid-config");
  }
  const configOut: WebhookChannelConfig = { url };
  if (secretRef !== undefined) {
    if (typeof secretRef !== "string" || secretRef.length === 0) {
      throw new WebhookError(
        "Webhook channel secretRef must be a non-empty string.",
        "invalid-config",
      );
    }
    configOut.secretRef = secretRef;
  }
  return configOut;
}

/**
 * Resolve the next redirect URL after full SSRF validation.
 * Allows cross-host redirects (webhook semantics) but re-checks scheme and
 * resolved IPs. Returns null when there is no Location header; throws
 * HttpError("blocked-redirect") on policy violations.
 */
export async function resolveWebhookRedirect(
  location: string | null,
  currentUrl: string,
  lookup: NonNullable<WebhookSenderOptions["lookup"]>,
): Promise<string | null> {
  if (!location) {
    return null;
  }
  let next: URL;
  try {
    next = new URL(location, currentUrl);
  } catch {
    throw new HttpError("Redirect Location is not a valid URL.", "blocked-redirect");
  }
  if (next.protocol !== "https:") {
    throw new HttpError(
      `Redirect to disallowed scheme "${next.protocol}" (https only).`,
      "blocked-redirect",
    );
  }
  // Every hop: DNS re-resolution + per-IP check (anti DNS-rebinding).
  await assertSafeHost(next.hostname, lookup);
  return next.href;
}

/**
 * Validate the initial webhook URL: https only + resolved IPs safe.
 * Returns the canonical URL string.
 */
export async function validateWebhookUrl(
  rawUrl: string,
  lookup: NonNullable<WebhookSenderOptions["lookup"]>,
): Promise<string> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new HttpError("Webhook URL is not a valid URL.", "blocked-redirect");
  }
  if (url.protocol !== "https:") {
    throw new HttpError(`Webhook URL must use https (got "${url.protocol}").`, "blocked-redirect");
  }
  await assertSafeHost(url.hostname, lookup);
  return url.href;
}

/** Build the JSON payload. `secretRef` is deliberately NOT included. */
export function buildWebhookPayload(
  deliveryId: number,
  event: NotificationEvent,
): Record<string, unknown> {
  return {
    eventId: event.dedupKey, // stable event identity for receiver-side dedup
    deliveryId,
    eventType: event.eventType,
    source: event.source,
    domainId: event.domainId,
    occurredAt: event.occurredAt.toISOString(),
    previousState: event.previousState,
    currentState: event.currentState,
  };
}

export class WebhookSender implements DeliverySender {
  readonly channelType = "webhook" as const;

  private readonly fetchFn: typeof fetch;
  private readonly lookup: (hostname: string) => Promise<string[]>;
  private readonly timeoutMs: number;
  private readonly maxRedirects: number;

  constructor(options: WebhookSenderOptions = {}) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.lookup = options.lookup ?? defaultLookup;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_WEBHOOK_TIMEOUT_MS;
    this.maxRedirects = options.maxRedirects ?? DEFAULT_WEBHOOK_MAX_REDIRECTS;
  }

  /**
   * Send one webhook POST. Resolves on a 2xx response; throws on any
   * 4xx/5xx/network/timeout/SSRF failure (the caller marks sent/failed).
   */
  async send(
    deliveryId: number,
    event: NotificationEvent,
    channel: { id: number; config: string },
  ): Promise<void> {
    const config = parseWebhookConfig(channel.config);
    const payload = buildWebhookPayload(deliveryId, event);
    const body = JSON.stringify(payload);

    // Initial URL: scheme + DNS-resolved IP checks BEFORE any request.
    let currentUrl = await validateWebhookUrl(config.url, this.lookup);
    let redirectCount = 0;

    for (;;) {
      let response: Response;
      try {
        response = await this.fetchFn(currentUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": WEBHOOK_USER_AGENT,
          },
          body,
          redirect: "manual",
          signal: AbortSignal.timeout(this.timeoutMs),
          cache: "no-store",
        });
      } catch (error) {
        throw mapFetchError(error);
      }

      const status = response.status;

      if (status >= 300 && status < 400) {
        if (redirectCount >= this.maxRedirects) {
          throw new HttpError("Webhook redirect limit exceeded.", "too-many-redirects");
        }
        const nextUrl = await resolveWebhookRedirect(
          response.headers.get("location"),
          currentUrl,
          this.lookup,
        );
        if (!nextUrl) {
          throw new HttpError("Redirect response without a Location header.", "blocked-redirect");
        }
        currentUrl = nextUrl;
        redirectCount++;
        continue;
      }

      // Never read the response body — only the status matters.
      try {
        await response.body?.cancel();
      } catch {
        // best-effort
      }

      if (status >= 200 && status < 300) {
        return;
      }
      throw new WebhookError(`Webhook returned HTTP ${status}.`, "webhook-rejected");
    }
  }
}

async function defaultLookup(hostname: string): Promise<string[]> {
  const { lookup } = await import("node:dns/promises");
  const addresses = await lookup(hostname, { all: true });
  return addresses.map((entry) => entry.address);
}

export { defaultLookup };

/**
 * Map a fetch-level failure (network / timeout / DNS / pre-thrown HttpError)
 * to a typed HttpError. Shared by WebhookSender and EmailSender.
 */
export function mapFetchError(error: unknown): HttpError {
  if (error instanceof HttpError) {
    return error;
  }
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return new HttpError("Webhook request timed out.", "timeout");
    }
    const cause = (error as { cause?: { code?: string } }).cause;
    if (cause?.code === "ENOTFOUND" || cause?.code === "EAI_AGAIN") {
      return new HttpError("Webhook DNS resolution failed.", "dns");
    }
  }
  return new HttpError("Webhook request failed (network error).", "network");
}

// Re-exported for tests that want to assert on the blocked-IP predicate.
export { isBlockedIp };

// Re-exported for callers that want typed errors without importing http.
export type { HttpClientOptions };
