/**
 * V0.6 Phase 4D — end-to-end delivery integration tests.
 *
 * Proves the full loop closes reliably:
 *
 *   event → generateDeliveries → pending → claimPendingDelivery → sending
 *     → sender.send() → sent / failed (+ explicit retry → pending)
 *
 * Uses the REAL WebhookSender / EmailSender (with injected fake fetch +
 * lookup) against a real in-memory SQLite DB. No scheduler, no worker, no
 * auto-retry — retry is exercised only as an explicit caller action.
 */

import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { domains, notificationChannels, notificationEvents, notificationRules } from "@/db/schema";
import { createSQLiteRepository } from "@/db/adapters/sqlite";
import { createTestDb } from "../../../test/helpers";
import { deliverDelivery, generateDeliveries } from "./service";
import { getDelivery, getEventDeliveries, retryDelivery, type NotificationDb } from "./repository";
import { WebhookSender } from "./senders/webhook";
import { EmailSender } from "./senders/email";
import type { DeliverySender, NotificationEvent } from "./types";

const PUBLIC_IP = "93.184.216.34";
const EMAIL_KEY = "k-secret-value";

function makeEvent(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    domainId: 5,
    source: "http",
    eventType: "http_status_changed",
    previousState: '"ok"',
    currentState: '"down"',
    occurredAt: new Date("2026-08-14T00:00:00.000Z"),
    dedupKey: "http:5:http_status_changed:ok:down",
    ...overrides,
  };
}

/** Seed: domain + channels + rules + event; returns the persisted event id. */
function seed(
  db: NotificationDb,
  channels: Array<{ name: string; type: "email" | "webhook"; config: string }>,
) {
  db.insert(domains).values({ id: 5, hostname: "example.com" }).run();
  const channelIds = channels.map(
    (c) =>
      db
        .insert(notificationChannels)
        .values({ type: c.type, name: c.name, config: c.config, enabled: 1 })
        .returning({ id: notificationChannels.id })
        .get().id,
  );
  for (const id of channelIds) {
    db.insert(notificationRules)
      .values({
        name: `rule-${id}`,
        channelId: id,
        source: "http",
        eventType: null,
        domainId: null,
        enabled: 1,
      })
      .run();
  }
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
  return { channelIds, eventId };
}

function okResponse(status = 200): Response {
  return new Response("{}", { status });
}

function fakeFetch(sequence: Array<Response | Error>) {
  const fn = vi.fn();
  for (const item of sequence) {
    fn.mockImplementationOnce(() =>
      item instanceof Error ? Promise.reject(item) : Promise.resolve(item),
    );
  }
  return fn as unknown as typeof fetch & { mock: ReturnType<typeof vi.fn>["mock"] };
}

function publicLookup() {
  return vi.fn().mockResolvedValue([PUBLIC_IP]);
}

const WEBHOOK_URL = "https://hooks.example.com/wh";
const EMAIL_ENDPOINT = "https://api.email.example.com/v1/send";

function webhookSender(fetchFn = fakeFetch([okResponse(200)])) {
  return new WebhookSender({ fetchFn, lookup: publicLookup() });
}

function emailSender(fetchFn = fakeFetch([okResponse(200)])) {
  return new EmailSender({
    fetchFn,
    lookup: publicLookup(),
    env: { EMAIL_API_KEY: EMAIL_KEY },
  });
}

/** A sender that always throws (simulates an unexpected sender bug). */
function throwingSender(): DeliverySender {
  return {
    channelType: "webhook",
    async send() {
      throw new Error("unexpected sender crash");
    },
  };
}

describe("Phase 4D — Webhook end-to-end", () => {
  it("success: pending → sending → sent with attempts=1 and deliveredAt", async () => {
    const db = createTestDb();
    const { channelIds, eventId } = seed(db, [
      { name: "wh", type: "webhook", config: JSON.stringify({ url: WEBHOOK_URL }) },
    ]);
    const event = makeEvent();
    const { created } = generateDeliveries(eventId, event, { db });
    expect(created).toEqual(channelIds);
    const [delivery] = getEventDeliveries(eventId, db);
    expect(delivery.status).toBe("pending");

    const fetchFn = fakeFetch([okResponse(200)]);
    const result = await deliverDelivery(delivery.id, event, webhookSender(fetchFn), {
      repo: createSQLiteRepository(db),
    });

    expect(result.status).toBe("sent");
    const after = getDelivery(delivery.id, db)!;
    expect(after.status).toBe("sent");
    expect(after.attempts).toBe(1);
    expect(after.deliveredAt).not.toBeNull();
    expect(fetchFn.mock.calls).toHaveLength(1);
  });

  it("failure: pending → sending → failed with error; event preserved; other channel untouched", async () => {
    const db = createTestDb();
    const { channelIds, eventId } = seed(db, [
      { name: "wh", type: "webhook", config: JSON.stringify({ url: WEBHOOK_URL }) },
      {
        name: "mail",
        type: "email",
        config: JSON.stringify({
          to: "a@b.c",
          from: "m@b.c",
          endpoint: EMAIL_ENDPOINT,
          apiKeyRef: "EMAIL_API_KEY",
        }),
      },
    ]);
    const event = makeEvent();
    generateDeliveries(eventId, event, { db });
    const [whDelivery, mailDelivery] = getEventDeliveries(eventId, db);

    // Webhook fails with 500; email succeeds.
    const whResult = await deliverDelivery(
      whDelivery.id,
      event,
      webhookSender(fakeFetch([new Response("boom", { status: 500 })])),
      { repo: createSQLiteRepository(db) },
    );
    const mailResult = await deliverDelivery(mailDelivery.id, event, emailSender(), {
      repo: createSQLiteRepository(db),
    });

    expect(whResult.status).toBe("failed");
    expect((whResult as { error?: string }).error).toBe("Webhook returned HTTP 500.");
    expect(getDelivery(whDelivery.id, db)!.status).toBe("failed");
    expect(getDelivery(whDelivery.id, db)!.error).toBe("Webhook returned HTTP 500.");

    // Other channel unaffected.
    expect(mailResult.status).toBe("sent");
    expect(getDelivery(mailDelivery.id, db)!.status).toBe("sent");

    // Event still present (no rollback).
    expect(
      db.select().from(notificationEvents).where(eq(notificationEvents.id, eventId)).get(),
    ).toBeDefined();
    // Deliveries still present.
    expect(getEventDeliveries(eventId, db)).toHaveLength(2);
    expect(channelIds).toHaveLength(2);
  });

  it("sender throwing: delivery ends failed, never stuck in sending", async () => {
    const db = createTestDb();
    const { eventId } = seed(db, [
      { name: "wh", type: "webhook", config: JSON.stringify({ url: WEBHOOK_URL }) },
    ]);
    const event = makeEvent();
    generateDeliveries(eventId, event, { db });
    const [delivery] = getEventDeliveries(eventId, db);

    const sender = throwingSender();
    const result = await deliverDelivery(delivery.id, event, sender, {
      repo: createSQLiteRepository(db),
    });

    expect(result.status).toBe("failed");
    expect((result as { error?: string }).error).toBe("unexpected sender crash");
    expect(getDelivery(delivery.id, db)!.status).toBe("failed");
    expect(getDelivery(delivery.id, db)!.error).toBe("unexpected sender crash");
  });
});

describe("Phase 4D — Email end-to-end", () => {
  it("success: claim → send → sent with Authorization header and no key leak", async () => {
    const db = createTestDb();
    const { channelIds, eventId } = seed(db, [
      {
        name: "mail",
        type: "email",
        config: JSON.stringify({
          to: "ops@example.com",
          from: "monitor@example.com",
          endpoint: EMAIL_ENDPOINT,
          apiKeyRef: "EMAIL_API_KEY",
        }),
      },
    ]);
    const event = makeEvent();
    const { created } = generateDeliveries(eventId, event, { db });
    expect(created).toEqual(channelIds);
    const [delivery] = getEventDeliveries(eventId, db);

    const fetchFn = fakeFetch([okResponse(200)]);
    const result = await deliverDelivery(delivery.id, event, emailSender(fetchFn), {
      repo: createSQLiteRepository(db),
    });

    expect(result.status).toBe("sent");
    expect(getDelivery(delivery.id, db)!.status).toBe("sent");
    const [url, init] = fetchFn.mock.calls[0] as [
      string,
      RequestInit & { headers: Record<string, string> },
    ];
    expect(url).toBe(EMAIL_ENDPOINT);
    expect(init.headers["Authorization"]).toBe(`Bearer ${EMAIL_KEY}`);
    // Key must not leak into the payload.
    expect(JSON.stringify(JSON.parse(String(init.body)))).not.toContain(EMAIL_KEY);
    // Key must not leak into the delivery row.
    expect(JSON.stringify(getDelivery(delivery.id, db))).not.toContain(EMAIL_KEY);
  });

  it("failure: correctly enters failed, never sent", async () => {
    const db = createTestDb();
    const { eventId } = seed(db, [
      {
        name: "mail",
        type: "email",
        config: JSON.stringify({
          to: "ops@example.com",
          from: "monitor@example.com",
          endpoint: EMAIL_ENDPOINT,
          apiKeyRef: "EMAIL_API_KEY",
        }),
      },
    ]);
    const event = makeEvent();
    generateDeliveries(eventId, event, { db });
    const [delivery] = getEventDeliveries(eventId, db);

    const result = await deliverDelivery(
      delivery.id,
      event,
      emailSender(fakeFetch([new Response("nope", { status: 503 })])),
      { repo: createSQLiteRepository(db) },
    );

    expect(result.status).toBe("failed");
    const after = getDelivery(delivery.id, db)!;
    expect(after.status).toBe("failed");
    expect(after.error).toBe("Email API returned HTTP 503.");
    // Error never contains the key.
    expect(after.error).not.toContain(EMAIL_KEY);
    expect(after.error).not.toContain("Bearer");
  });
});

describe("Phase 4D — concurrency & terminal states", () => {
  it("two workers claiming: only one wins, the other is skipped (no double send)", async () => {
    const db = createTestDb();
    const { eventId } = seed(db, [
      { name: "wh", type: "webhook", config: JSON.stringify({ url: WEBHOOK_URL }) },
    ]);
    const event = makeEvent();
    generateDeliveries(eventId, event, { db });
    const [delivery] = getEventDeliveries(eventId, db);

    // Both workers race on the SAME pending delivery.
    const results = await Promise.all([
      deliverDelivery(delivery.id, event, webhookSender(fakeFetch([okResponse(200)])), {
        repo: createSQLiteRepository(db),
      }),
      deliverDelivery(delivery.id, event, webhookSender(fakeFetch([okResponse(200)])), {
        repo: createSQLiteRepository(db),
      }),
    ]);
    // One sent, one skipped; exactly one send happened.
    expect(results.map((r) => r.status).sort()).toEqual(["sent", "skipped"]);
    expect(getDelivery(delivery.id, db)!.status).toBe("sent");
    expect(getDelivery(delivery.id, db)!.attempts).toBe(1);
  });

  it("sent is terminal: cannot be claimed again, sender never invoked twice", async () => {
    const db = createTestDb();
    const { eventId } = seed(db, [
      { name: "wh", type: "webhook", config: JSON.stringify({ url: WEBHOOK_URL }) },
    ]);
    const event = makeEvent();
    generateDeliveries(eventId, event, { db });
    const [delivery] = getEventDeliveries(eventId, db);

    const fetchFn = fakeFetch([okResponse(200)]);
    const sender = webhookSender(fetchFn);
    const first = await deliverDelivery(delivery.id, event, sender, {
      repo: createSQLiteRepository(db),
    });
    expect(first.status).toBe("sent");
    expect(fetchFn.mock.calls).toHaveLength(1);

    // Second attempt on the SAME (now sent) delivery.
    const second = await deliverDelivery(delivery.id, event, sender, {
      repo: createSQLiteRepository(db),
    });
    expect(second.status).toBe("skipped");
    expect(fetchFn.mock.calls).toHaveLength(1); // no second request
    expect(getDelivery(delivery.id, db)!.attempts).toBe(1);
  });

  it("retry: failed → pending → claim again increments attempts", async () => {
    const db = createTestDb();
    const { eventId } = seed(db, [
      { name: "wh", type: "webhook", config: JSON.stringify({ url: WEBHOOK_URL }) },
    ]);
    const event = makeEvent();
    generateDeliveries(eventId, event, { db });
    const [delivery] = getEventDeliveries(eventId, db);

    // First attempt fails.
    const first = await deliverDelivery(
      delivery.id,
      event,
      webhookSender(fakeFetch([new Response("x", { status: 500 })])),
      { repo: createSQLiteRepository(db) },
    );
    expect(first.status).toBe("failed");
    expect(getDelivery(delivery.id, db)!.attempts).toBe(1);

    // Explicit retry (NO auto-retry in this phase).
    expect(retryDelivery(delivery.id, db)).toBe(true);
    expect(getDelivery(delivery.id, db)!.status).toBe("pending");

    // Second attempt succeeds → attempts = 2.
    const second = await deliverDelivery(delivery.id, event, webhookSender(), {
      repo: createSQLiteRepository(db),
    });
    expect(second.status).toBe("sent");
    const after = getDelivery(delivery.id, db)!;
    expect(after.status).toBe("sent");
    expect(after.attempts).toBe(2);
  });
});

describe("Phase 4D — multi-channel isolation", () => {
  it("webhook success + email failure: sent / failed, independent", async () => {
    const db = createTestDb();
    const { eventId } = seed(db, [
      { name: "wh", type: "webhook", config: JSON.stringify({ url: WEBHOOK_URL }) },
      {
        name: "mail",
        type: "email",
        config: JSON.stringify({
          to: "ops@example.com",
          from: "monitor@example.com",
          endpoint: EMAIL_ENDPOINT,
          apiKeyRef: "EMAIL_API_KEY",
        }),
      },
    ]);
    const event = makeEvent();
    generateDeliveries(eventId, event, { db });
    const [wh, mail] = getEventDeliveries(eventId, db);

    const whResult = await deliverDelivery(wh.id, event, webhookSender(), {
      repo: createSQLiteRepository(db),
    });
    const mailResult = await deliverDelivery(
      mail.id,
      event,
      emailSender(fakeFetch([new Response("x", { status: 500 })])),
      { repo: createSQLiteRepository(db) },
    );

    expect(whResult.status).toBe("sent");
    expect(mailResult.status).toBe("failed");
    expect(getDelivery(wh.id, db)!.status).toBe("sent");
    expect(getDelivery(mail.id, db)!.status).toBe("failed");
    expect(getDelivery(mail.id, db)!.error).not.toContain(EMAIL_KEY);
  });
});

describe("Phase 4D — idempotency & rollback safety", () => {
  it("generateDeliveries twice for one event yields no duplicate delivery", async () => {
    const db = createTestDb();
    const { eventId } = seed(db, [
      { name: "wh", type: "webhook", config: JSON.stringify({ url: WEBHOOK_URL }) },
    ]);
    const event = makeEvent();

    const first = generateDeliveries(eventId, event, { db });
    const second = generateDeliveries(eventId, event, { db });

    expect(first.created).toHaveLength(1);
    expect(second.created).toHaveLength(0);
    expect(second.skipped).toHaveLength(1);
    expect(getEventDeliveries(eventId, db)).toHaveLength(1);
  });

  it("sender failure never deletes the event or the delivery", async () => {
    const db = createTestDb();
    const { eventId } = seed(db, [
      { name: "wh", type: "webhook", config: JSON.stringify({ url: WEBHOOK_URL }) },
    ]);
    const event = makeEvent();
    generateDeliveries(eventId, event, { db });
    const [delivery] = getEventDeliveries(eventId, db);

    await deliverDelivery(delivery.id, event, throwingSender(), {
      repo: createSQLiteRepository(db),
    });

    // Event row intact.
    expect(
      db.select().from(notificationEvents).where(eq(notificationEvents.id, eventId)).get(),
    ).toBeDefined();
    // Delivery row intact (status=failed, not deleted).
    const after = getDelivery(delivery.id, db)!;
    expect(after.status).toBe("failed");
    // Domain intact.
    expect(db.select().from(domains).where(eq(domains.id, 5)).get()).toBeDefined();
  });

  it("secretRef is never leaked into any delivery row or error", async () => {
    const db = createTestDb();
    const secretRef = "WH_SECRET_REF";
    const { eventId } = seed(db, [
      { name: "wh", type: "webhook", config: JSON.stringify({ url: WEBHOOK_URL, secretRef }) },
    ]);
    const event = makeEvent();
    generateDeliveries(eventId, event, { db });
    const [delivery] = getEventDeliveries(eventId, db);

    // Fail the send; the error and the row must not contain the ref VALUE
    // (the ref NAME is expected in config, never in the error path).
    const result = await deliverDelivery(
      delivery.id,
      event,
      webhookSender(fakeFetch([new Response("x", { status: 500 })])),
      { repo: createSQLiteRepository(db) },
    );

    expect((result as { error?: string }).error).not.toContain(secretRef);
    const row = getDelivery(delivery.id, db)!;
    expect(row.error).not.toContain(secretRef);
    expect(row.status).toBe("failed");
  });

  it("deliverDelivery on a missing delivery returns skipped", async () => {
    const db = createTestDb();
    const event = makeEvent();
    const result = await deliverDelivery(999_999, event, webhookSender(), {
      repo: createSQLiteRepository(db),
    });
    expect(result.status).toBe("skipped");
  });

  it("channel type mismatch fails the delivery instead of sending", async () => {
    const db = createTestDb();
    const { eventId } = seed(db, [
      { name: "wh", type: "webhook", config: JSON.stringify({ url: WEBHOOK_URL }) },
    ]);
    const event = makeEvent();
    generateDeliveries(eventId, event, { db });
    const [delivery] = getEventDeliveries(eventId, db);

    // EmailSender (channelType "email") against a webhook channel.
    const result = await deliverDelivery(delivery.id, event, emailSender(), {
      repo: createSQLiteRepository(db),
    });

    expect(result.status).toBe("failed");
    expect((result as { error?: string }).error).toBe("Sender type mismatch (expected webhook).");
    expect(getDelivery(delivery.id, db)!.status).toBe("failed");
  });
});
