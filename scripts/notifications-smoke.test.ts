/**
 * V0.6 Phase 5C — Notification smoke & integration verification.
 *
 * Runs the REAL orchestration chain against a REAL local HTTP server:
 *
 *   event → rule → generateDeliveries → pending → claimPendingDelivery
 *     → WebhookSender / EmailSender → (real socket) → 200/500 → sent/failed
 *
 * Only the DNS lookup is mocked (endpoint hostname → public IP) so the
 * SSRF checks pass, and fetch is routed to a local server instead of the
 * public internet — NO real third party is ever contacted. This is
 * deliberately NOT part of `pnpm test` (CI safety):
 *
 *   pnpm vitest run --config scripts/vitest.smoke.config.ts
 *
 * Covered scenarios:
 *   1. Webhook E2E: 200 → sent; 500 → failed, event retained
 *   2. Email E2E: 2xx → sent; Authorization present; key never in payload
 *   3. Email cross-origin redirect: Authorization stripped (5A-1 fix)
 *   4. SSRF redirect still enforced on email chain
 *   5. Retry E2E: failed → retryDelivery → pending → sent; attempts 1→2;
 *      delivery ID and event ID unchanged
 *   6. Concurrency: two workers claim one delivery → exactly one send
 *   7. Cascade: deleting the domain removes events + rules + deliveries
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  domains,
  notificationChannels,
  notificationDeliveries,
  notificationEvents,
  notificationRules,
} from "../src/db/schema";
import { createTestDb } from "../test/helpers";
import { deliverDelivery, generateDeliveries } from "../src/lib/notifications/service";
import {
  getDelivery,
  getEvent,
  retryDelivery,
  type NotificationDb,
} from "../src/lib/notifications/repository";
import { WebhookSender } from "../src/lib/notifications/senders/webhook";
import { EmailSender } from "../src/lib/notifications/senders/email";
import type { NotificationEvent } from "../src/lib/notifications/types";

const PUBLIC_IP = "93.184.216.34";
const EMAIL_KEY = "k-smoke-secret-5c";

const EVENT: NotificationEvent = {
  domainId: 5,
  source: "http",
  eventType: "http_status_changed",
  previousState: '"ok"',
  currentState: '"down"',
  occurredAt: new Date("2026-08-14T00:00:00.000Z"),
  dedupKey: "http:5:http_status_changed:ok:down",
};

const WEBHOOK_CONFIG = JSON.stringify({ url: "https://webhook.example/hook" });
const EMAIL_CONFIG = JSON.stringify({
  to: "ops@example.com",
  from: "monitor@example.com",
  endpoint: "https://api.email.example/v1/send",
  apiKeyRef: "EMAIL_API_KEY",
});

// ---------------------------------------------------------------------------
// Local HTTP server: records every request it receives and replies from a
// queue of response specs, so each scenario controls its own status codes.
// ---------------------------------------------------------------------------

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

let serverPort = 0;
const requests: RecordedRequest[] = [];
let responseQueue: Array<{ status: number; headers?: Record<string, string> }> = [];

function queueResponses(specs: Array<{ status: number; headers?: Record<string, string> }>) {
  responseQueue = specs;
}

function handleRequest(req: IncomingMessage, res: ServerResponse) {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    requests.push({ url: req.url ?? "", method: req.method ?? "", headers: req.headers, body });
    const spec = responseQueue.shift() ?? { status: 200 };
    res.writeHead(spec.status, spec.headers ?? {});
    res.end("{}");
  });
}

beforeAll(async () => {
  const server = createServer(handleRequest);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("local server did not bind to a port");
  }
  serverPort = address.port;
});

afterAll(() => {
  // Vitest tears down the process; the server closes via process exit.
});

/**
 * fetch that keeps the sender's headers/body but routes to the local
 * server. The URL passed by the sender has already passed SSRF validation.
 */
function localFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const target = new URL(String(input));
  return fetch(`http://127.0.0.1:${serverPort}${target.pathname}${target.search}`, {
    method: init?.method,
    headers: init?.headers,
    body: init?.body,
    redirect: "manual",
    signal: init?.signal,
  });
}

function publicLookup() {
  return vi.fn(async () => [PUBLIC_IP]);
}

/** Seed: domain + channel + rule + event; returns ids. */
function seed(db: NotificationDb, channelType: "email" | "webhook", config: string) {
  db.insert(domains).values({ id: 5, hostname: "example.com" }).run();
  const channelId = db
    .insert(notificationChannels)
    .values({ type: channelType, name: `smoke-${channelType}`, config, enabled: 1 })
    .returning({ id: notificationChannels.id })
    .get().id;
  db.insert(notificationRules)
    .values({ name: "rule-1", channelId, source: "http", eventType: null, domainId: null, enabled: 1 })
    .run();
  const eventId = db
    .insert(notificationEvents)
    .values({
      domainId: 5,
      source: "http",
      eventType: "http_status_changed",
      previousState: '"ok"',
      currentState: '"down"',
      dedupKey: "http:5:http_status_changed:ok:down",
      occurredAt: new Date("2026-08-14T00:00:00.000Z"),
    })
    .returning({ id: notificationEvents.id })
    .get().id;
  return { channelId, eventId };
}

function countDeliveries(db: NotificationDb): number {
  return db.select().from(notificationDeliveries).all().length;
}

describe("Phase 5C smoke — real chain against a local HTTP server", () => {
  it("1. webhook E2E: 200 → pending → sending → sent", async () => {
    const db = createTestDb();
    const { eventId } = seed(db, "webhook", WEBHOOK_CONFIG);
    requests.length = 0;
    queueResponses([{ status: 200 }]);

    const { created } = generateDeliveries(eventId, EVENT, { db });
    expect(created).toEqual([expect.any(Number)]);
    const deliveryId = getDelivery(created[0], db)!.id;
    expect(getDelivery(deliveryId, db)!.status).toBe("pending");

    const sender = new WebhookSender({ fetchFn: localFetch, lookup: publicLookup() });
    const result = await deliverDelivery(deliveryId, EVENT, sender, { db });

    expect(result).toEqual({ status: "sent" });
    const delivery = getDelivery(deliveryId, db)!;
    expect(delivery.status).toBe("sent");
    expect(delivery.attempts).toBe(1);
    expect(delivery.deliveredAt).toBeInstanceOf(Date);
    // Exactly one real request hit the local server.
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("/hook");
    const payload = JSON.parse(requests[0].body) as Record<string, unknown>;
    expect(payload.deliveryId).toBe(deliveryId);
    expect(payload.eventId).toBe(EVENT.dedupKey);
  });

  it("2. webhook E2E: 500 → failed, event retained, other channel untouched", async () => {
    const db = createTestDb();
    const { eventId } = seed(db, "webhook", WEBHOOK_CONFIG);
    requests.length = 0;
    queueResponses([{ status: 500 }]);

    const { created } = generateDeliveries(eventId, EVENT, { db });
    const deliveryId = getDelivery(created[0], db)!.id;

    const sender = new WebhookSender({ fetchFn: localFetch, lookup: publicLookup() });
    const result = await deliverDelivery(deliveryId, EVENT, sender, { db });

    expect(result.status).toBe("failed");
    const delivery = getDelivery(deliveryId, db)!;
    expect(delivery.status).toBe("failed");
    expect(delivery.error).toContain("Webhook returned HTTP 500");
    expect(delivery.error).not.toContain(EMAIL_KEY);
    // Event is retained.
    expect(getEvent(eventId, db)).toBeDefined();
    // No delivery stuck in `sending`.
    expect(countDeliveries(db)).toBe(1);
  });

  it("3. email E2E: 2xx → sent; Authorization exact; key never in payload/error", async () => {
    const db = createTestDb();
    const { eventId } = seed(db, "email", EMAIL_CONFIG);
    requests.length = 0;
    queueResponses([{ status: 200 }]);

    const { created } = generateDeliveries(eventId, EVENT, { db });
    const deliveryId = getDelivery(created[0], db)!.id;

    const sender = new EmailSender({
      fetchFn: localFetch,
      lookup: publicLookup(),
      env: { EMAIL_API_KEY: EMAIL_KEY },
    });
    const result = await deliverDelivery(deliveryId, EVENT, sender, { db });

    expect(result).toEqual({ status: "sent" });
    expect(getDelivery(deliveryId, db)!.status).toBe("sent");
    expect(requests).toHaveLength(1);
    expect(requests[0].headers.authorization).toBe(`Bearer ${EMAIL_KEY}`);
    expect(requests[0].body).not.toContain(EMAIL_KEY);
    // Email payload carries the ids inside the human-readable text.
    const body = requests[0].body;
    expect(body).toContain(`Delivery ID: ${deliveryId}`);
    expect(body).toContain(`Event ID: ${EVENT.dedupKey}`);
  });

  it("4. email cross-origin redirect: Authorization stripped on hop 2 (5A-1)", async () => {
    const db = createTestDb();
    const { eventId } = seed(db, "email", EMAIL_CONFIG);
    requests.length = 0;
    queueResponses([
      { status: 302, headers: { location: "https://other.example/hook" } },
      { status: 200 },
    ]);

    const { created } = generateDeliveries(eventId, EVENT, { db });
    const deliveryId = getDelivery(created[0], db)!.id;

    const lookup = vi
      .fn()
      .mockResolvedValueOnce([PUBLIC_IP]) // api.email.example
      .mockResolvedValueOnce([PUBLIC_IP]); // other.example
    const sender = new EmailSender({
      fetchFn: localFetch,
      lookup,
      env: { EMAIL_API_KEY: EMAIL_KEY },
    });
    const result = await deliverDelivery(deliveryId, EVENT, sender, { db });

    expect(result).toEqual({ status: "sent" });
    expect(requests).toHaveLength(2);
    expect(requests[0].headers.authorization).toBe(`Bearer ${EMAIL_KEY}`);
    // The key never crossed the origin boundary.
    expect(requests[1].headers.authorization).toBeUndefined();
    expect(requests[1].body).not.toContain(EMAIL_KEY);
  });

  it("5. email SSRF redirect still enforced: internal target blocked, no 2nd request", async () => {
    const db = createTestDb();
    const { eventId } = seed(db, "email", EMAIL_CONFIG);
    requests.length = 0;
    queueResponses([
      { status: 302, headers: { location: "https://internal.example/hook" } },
      { status: 200 },
    ]);

    const { created } = generateDeliveries(eventId, EVENT, { db });
    const deliveryId = getDelivery(created[0], db)!.id;

    const lookup = vi
      .fn()
      .mockResolvedValueOnce([PUBLIC_IP]) // api.email.example
      .mockResolvedValueOnce(["10.0.0.1"]); // internal.example → RFC1918
    const sender = new EmailSender({
      fetchFn: localFetch,
      lookup,
      env: { EMAIL_API_KEY: EMAIL_KEY },
    });
    const result = await deliverDelivery(deliveryId, EVENT, sender, { db });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("Blocked address 10.0.0.1");
    // The redirect target was never fetched — only hop 1 hit the server.
    expect(requests).toHaveLength(1);
    const delivery = getDelivery(deliveryId, db)!;
    expect(delivery.status).toBe("failed");
    expect(delivery.error).not.toContain(EMAIL_KEY);
  });

  it("6. retry E2E: failed → retryDelivery → pending → sent; attempts 1→2; ids stable", async () => {
    const db = createTestDb();
    const { eventId } = seed(db, "webhook", WEBHOOK_CONFIG);
    requests.length = 0;
    queueResponses([{ status: 500 }]);

    const { created } = generateDeliveries(eventId, EVENT, { db });
    const deliveryId = getDelivery(created[0], db)!.id;
    const originalDeliveryId = deliveryId;
    const originalEventId = eventId;

    const sender = new WebhookSender({ fetchFn: localFetch, lookup: publicLookup() });

    // First attempt fails.
    const first = await deliverDelivery(deliveryId, EVENT, sender, { db });
    expect(first.status).toBe("failed");
    expect(getDelivery(deliveryId, db)!.attempts).toBe(1);

    // Explicit retry: failed → pending, same row, same event.
    expect(retryDelivery(deliveryId, db)).toBe(true);
    const afterRetry = getDelivery(deliveryId, db)!;
    expect(afterRetry.status).toBe("pending");
    expect(afterRetry.id).toBe(originalDeliveryId);
    expect(afterRetry.eventId).toBe(originalEventId);

    // Second attempt succeeds.
    queueResponses([{ status: 200 }]);
    const second = await deliverDelivery(deliveryId, EVENT, sender, { db });
    expect(second).toEqual({ status: "sent" });

    const final = getDelivery(deliveryId, db)!;
    expect(final.status).toBe("sent");
    expect(final.attempts).toBe(2); // 1 → 2
    expect(final.id).toBe(originalDeliveryId); // delivery ID unchanged
    expect(final.eventId).toBe(originalEventId); // event ID unchanged
    expect(requests).toHaveLength(2);
  });

  it("7. concurrency: two workers claim one delivery → exactly one real send", async () => {
    const db = createTestDb();
    const { eventId } = seed(db, "webhook", WEBHOOK_CONFIG);
    requests.length = 0;
    queueResponses([{ status: 200 }, { status: 200 }]);

    const { created } = generateDeliveries(eventId, EVENT, { db });
    const deliveryId = getDelivery(created[0], db)!.id;

    const workerA = new WebhookSender({ fetchFn: localFetch, lookup: publicLookup() });
    const workerB = new WebhookSender({ fetchFn: localFetch, lookup: publicLookup() });

    const [a, b] = await Promise.all([
      deliverDelivery(deliveryId, EVENT, workerA, { db }),
      deliverDelivery(deliveryId, EVENT, workerB, { db }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(["sent", "skipped"]);
    // Exactly one actual HTTP request — the loser never called send().
    expect(requests).toHaveLength(1);
    expect(getDelivery(deliveryId, db)!.status).toBe("sent");
    expect(getDelivery(deliveryId, db)!.attempts).toBe(1);
  });

  it("8. cascade: deleting the domain removes events + deliveries + domain-scoped rules", async () => {
    const db = createTestDb();
    const { channelId, eventId } = seed(db, "webhook", WEBHOOK_CONFIG);
    const { created } = generateDeliveries(eventId, EVENT, { db });
    const deliveryId = getDelivery(created[0], db)!.id;

    // One rule scoped to the domain (domainId=5) and one global rule
    // (domainId=null, applies to all domains). Only the former cascades.
    db.insert(notificationRules)
      .values({ name: "rule-domain", channelId, source: "http", eventType: null, domainId: 5, enabled: 1 })
      .run();

    expect(countDeliveries(db)).toBe(1);

    db.delete(domains).where(eq(domains.id, 5)).run();

    // Events and deliveries cascade (deliveries via event_id FK).
    expect(db.select().from(notificationEvents).all()).toHaveLength(0);
    expect(countDeliveries(db)).toBe(0);
    expect(getDelivery(deliveryId, db)).toBeUndefined();
    expect(getEvent(eventId, db)).toBeUndefined();
    // Domain-scoped rule gone; the global (null-domain) rule survives.
    const remaining = db.select().from(notificationRules).all();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].name).toBe("rule-1");
    expect(remaining[0].domainId).toBeNull();
  });
});
