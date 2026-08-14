/**
 * Email delivery sender (V0.6 Phase 4C).
 *
 * Design: a configurable HTTPS Email API endpoint — NOT a vendor SDK, and
 * NOT SMTP. The endpoint URL comes from channel config and is treated with
 * the SAME security level as a webhook URL:
 *
 * - https:// only (initial AND every redirect hop)
 * - `assertSafeHost` re-resolves DNS and rejects loopback / private /
 *   link-local / ULA / CGNAT / cloud-metadata / multicast addresses on
 *   EVERY hop (no caching → DNS rebinding cannot bypass).
 * - redirect: "manual"; each Location is re-validated before following;
 *   at most 5 hops.
 * - Fixed POST + application/json; timeout; response body never read.
 *
 * Secrets: `apiKeyRef` is a reference to an environment variable name. The
 * key itself is read at send time and used ONLY in the Authorization
 * header — it never appears in the payload, error messages, or logs.
 * Credentials are scoped to the ORIGINAL origin: a cross-origin redirect
 * strips the Authorization header for the rest of the chain (it is never
 * re-attached), while every hop still passes the SSRF validation.
 *
 * The email body carries stable `eventId` + `deliveryId` so receivers can
 * deduplicate (at-least-once semantics, consistent with Phase 4A/4B).
 *
 * Does NOT implement HMAC/signing (deferred to a later phase).
 */

import { HttpError } from "@/lib/http/client";
import type { DeliverySender, NotificationEvent } from "../types";
import { mapFetchError, resolveWebhookRedirect, validateWebhookUrl } from "./webhook";

export interface EmailChannelConfig {
  /** Recipient address (not a secret). */
  to: string;
  /** Sender address (not a secret). */
  from: string;
  /** Configurable HTTPS Email API endpoint (https only, SSRF-checked). */
  endpoint: string;
  /** Reference to the API key env var (never the key itself). */
  apiKeyRef: string;
}

export interface EmailSenderOptions {
  /** Injectable fetch for tests. */
  fetchFn?: typeof fetch;
  /** Injectable DNS resolver for tests: hostname → IPs. */
  lookup?: (hostname: string) => Promise<string[]>;
  /** Per-request timeout (default 8s). */
  timeoutMs?: number;
  /** Max redirects (default 5). */
  maxRedirects?: number;
  /** Env map used to resolve apiKeyRef (defaults to process.env). */
  env?: Record<string, string | undefined>;
}

/** Email send-layer error (rejection / bad config). */
export class EmailError extends Error {
  constructor(
    message: string,
    readonly code: "email-rejected" | "invalid-config",
  ) {
    super(message);
    this.name = "EmailError";
  }
}

const DEFAULT_EMAIL_TIMEOUT_MS = 8_000;
const DEFAULT_EMAIL_MAX_REDIRECTS = 5;
const EMAIL_USER_AGENT = "Domain-Monitor/0.6 (+https://github.com/hxx0611/Domain-Monitor)";

/** Parse the channel config JSON into the email shape. Throws on bad config. */
export function parseEmailConfig(config: string): EmailChannelConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(config);
  } catch {
    throw new EmailError("Email channel config is not valid JSON.", "invalid-config");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new EmailError("Email channel config must be an object.", "invalid-config");
  }
  const { to, from, endpoint, apiKeyRef } = parsed as Record<string, unknown>;
  for (const [key, value] of [
    ["to", to],
    ["from", from],
    ["endpoint", endpoint],
    ["apiKeyRef", apiKeyRef],
  ] as const) {
    if (typeof value !== "string" || value.length === 0) {
      throw new EmailError(`Email channel config is missing "${key}".`, "invalid-config");
    }
  }
  return {
    to: to as string,
    from: from as string,
    endpoint: endpoint as string,
    apiKeyRef: apiKeyRef as string,
  };
}

/**
 * Resolve the API key from the environment by ref. The error message names
 * only the REF, never the key value.
 */
export function readApiKey(
  apiKeyRef: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const key = env[apiKeyRef];
  if (!key || key.length === 0) {
    throw new EmailError(
      `Email API key "${apiKeyRef}" is not set in the environment.`,
      "invalid-config",
    );
  }
  return key;
}

/**
 * Build the email subject/text. Carries eventId + deliveryId so the
 * receiver can deduplicate (at-least-once). No secret material.
 */
export function buildEmailContent(
  deliveryId: number,
  event: NotificationEvent,
): { subject: string; text: string } {
  const subject = `[Domain Monitor] ${event.source} ${event.eventType} (domain #${event.domainId})`;
  const text = [
    "Domain Monitor notification",
    "",
    `Event: ${event.eventType}`,
    `Source: ${event.source}`,
    `Domain ID: ${event.domainId}`,
    `Event ID: ${event.dedupKey}`,
    `Delivery ID: ${deliveryId}`,
    `Occurred at: ${event.occurredAt.toISOString()}`,
    `Previous state: ${event.previousState ?? "(none)"}`,
    `Current state: ${event.currentState ?? "(none)"}`,
  ].join("\n");
  return { subject, text };
}

export class EmailSender implements DeliverySender {
  readonly channelType = "email" as const;

  private readonly fetchFn: typeof fetch;
  private readonly lookup: (hostname: string) => Promise<string[]>;
  private readonly timeoutMs: number;
  private readonly maxRedirects: number;
  private readonly env: Record<string, string | undefined>;

  constructor(options: EmailSenderOptions = {}) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.lookup = options.lookup ?? defaultLookup;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_EMAIL_TIMEOUT_MS;
    this.maxRedirects = options.maxRedirects ?? DEFAULT_EMAIL_MAX_REDIRECTS;
    this.env = options.env ?? process.env;
  }

  /**
   * Send one email via the configured HTTPS Email API endpoint.
   * Resolves on a 2xx response; throws on any
   * 4xx/5xx/network/timeout/SSRF failure (the caller marks sent/failed).
   */
  async send(
    deliveryId: number,
    event: NotificationEvent,
    channel: { id: number; config: string },
  ): Promise<void> {
    const config = parseEmailConfig(channel.config);
    const apiKey = readApiKey(config.apiKeyRef, this.env);
    const { subject, text } = buildEmailContent(deliveryId, event);
    const body = JSON.stringify({ from: config.from, to: config.to, subject, text });

    // Endpoint: same SSRF level as a webhook URL (https only + resolved IPs).
    let currentUrl = await validateWebhookUrl(config.endpoint, this.lookup);
    let redirectCount = 0;
    // Phase 5A-1: the API key follows the request only while it stays on the
    // original origin. The moment a redirect leaves it, Authorization is
    // stripped for the rest of the chain — never re-attached — while EVERY
    // hop below still passes validateWebhookUrl / resolveWebhookRedirect.
    let carryAuth = true;

    for (;;) {
      let response: Response;
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "User-Agent": EMAIL_USER_AGENT,
      };
      if (carryAuth) {
        headers.Authorization = `Bearer ${apiKey}`;
      }
      try {
        response = await this.fetchFn(currentUrl, {
          method: "POST",
          headers,
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
          throw new HttpError("Email endpoint redirect limit exceeded.", "too-many-redirects");
        }
        const nextUrl = await resolveWebhookRedirect(
          response.headers.get("location"),
          currentUrl,
          this.lookup,
        );
        if (!nextUrl) {
          throw new HttpError("Redirect response without a Location header.", "blocked-redirect");
        }
        // Cross-origin hop → credentials never follow (monotonic strip).
        if (new URL(nextUrl).origin !== new URL(currentUrl).origin) {
          carryAuth = false;
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
      throw new EmailError(`Email API returned HTTP ${status}.`, "email-rejected");
    }
  }
}

async function defaultLookup(hostname: string): Promise<string[]> {
  const { lookup } = await import("node:dns/promises");
  const addresses = await lookup(hostname, { all: true });
  return addresses.map((entry) => entry.address);
}
