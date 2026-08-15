/**
 * V0.7 Phase 1 — delivery worker (runOnce) tests.
 *
 * Exercises the worker tick against a real in-memory SQLite DB with
 * injected recording senders (no network). Covers the Phase 1 matrix:
 * empty queue, sent/failed paths, batch limit, FIFO order, stale recovery
 * (old vs fresh sending), per-delivery failure isolation, concurrent
 * workers (CAS single winner), attempts increment, stable delivery ids,
 * no event duplication, and the no-secret guarantee.
 */

import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  domains,
  notificationChannels,
  notificationDeliveries,
  notificationEvents,
  notificationRules,
} from "@/db/schema";
import { createTestDb } from "../../../test/helpers";
import { runOnce } from "./worker";
import { getDelivery, retryDelivery, type NotificationDb } from "./repository";
import { EmailSender } from "./senders/email";
import type { ChannelType, DeliverySender, NotificationEvent } from "./types";

const EMAIL_KEY = "k-secret-value";

/** Recording fake sender: records every send call, optionally failing. */
class RecordingSender implements DeliverySender {
  readonly channelType: ChannelType;
  readonly calls: Array<{ deliveryId: number; event: NotificationEvent }> = [];

  constructor(
    readonly type: ChannelType,
    private readonly behavior: "ok" | "fail" = "ok",
  ) {
    this.channelType = type;
  }

  async send(deliveryId: number, event: NotificationEvent): Promise<void> {
    this.calls.push({ deliveryId, event });
    if (this.behavior === "fail") {
      throw new Error("delivery failed");
    }
  }
}

const WEBHOOK_CONFIG = JSON.stringify({ url: "https://hooks.example.com/wh" });
const EMAIL_CONFIG = JSON.stringify({
  to: "ops@example.com",
  from: "monitor@example.com",
  endpoint: "https://email-api.example.com/send",
  apiKeyRef: "EMAIL_API_KEY",
});

/**
 * Seed: domain + N channels (each with a rule) + one event.
 * Returns channel ids and the event id.
 */
function seedChannels(
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

/** Insert one pending delivery row directly. */
function insertPendingDelivery(db: NotificationDb, eventId: number, channelId: number): number {
  return db
    .insert(notificationDeliveries)
    .values({ eventId, channelId, status: "pending", attempts: 0 })
    .returning({ id: notificationDeliveries.id })
    .get().id;
}

function setClaimedAt(db: NotificationDb, deliveryId: number, at: Date): void {
  db.update(notificationDeliveries)
    .set({ status: "sending", claimedAt: at, attempts: 1 })
    .where(eq(notificationDeliveries.id, deliveryId))
    .run();
}

const NOW = new Date("2026-08-14T12:00:00.000Z");

function okSenders(type: ChannelType): DeliverySender {
  return new RecordingSender(type, "ok");
}

describe("worker runOnce", () => {
  it("empty queue: zero summary, no errors", async () => {
    const db = createTestDb();
    db.insert(domains).values({ id: 5, hostname: "example.com" }).run();
    const result = await runOnce({ db, now: NOW });
    expect(result).toEqual({ recovered: 0, attempted: 0, sent: 0, failed: 0, skipped: 0 });
  });

  it("pending → sent: one delivery delivered, attempts = 1", async () => {
    const db = createTestDb();
    const { channelIds, eventId } = seedChannels(db, [
      { name: "wh", type: "webhook", config: WEBHOOK_CONFIG },
    ]);
    const deliveryId = insertPendingDelivery(db, eventId, channelIds[0]);

    const sender = new RecordingSender("webhook", "ok");
    const result = await runOnce({ db, now: NOW, senders: () => sender });

    expect(result).toEqual({ recovered: 0, attempted: 1, sent: 1, failed: 0, skipped: 0 });
    expect(sender.calls).toHaveLength(1);
    expect(sender.calls[0].deliveryId).toBe(deliveryId);
    const row = getDelivery(deliveryId, db)!;
    expect(row.status).toBe("sent");
    expect(row.attempts).toBe(1);
    expect(row.deliveredAt).not.toBeNull();
  });

  it("pending → failed: sender error lands in failed with attempts = 1", async () => {
    const db = createTestDb();
    const { channelIds, eventId } = seedChannels(db, [
      { name: "wh", type: "webhook", config: WEBHOOK_CONFIG },
    ]);
    const deliveryId = insertPendingDelivery(db, eventId, channelIds[0]);

    const sender = new RecordingSender("webhook", "fail");
    const result = await runOnce({ db, now: NOW, senders: () => sender });

    expect(result).toEqual({ recovered: 0, attempted: 1, sent: 0, failed: 1, skipped: 0 });
    const row = getDelivery(deliveryId, db)!;
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(1);
    expect(row.error).toBe("delivery failed");
  });

  it("batch limit: only `limit` deliveries attempted, rest stay pending", async () => {
    const db = createTestDb();
    // One delivery per channel — UNIQUE(event_id, channel_id) forbids two
    // deliveries for the same event+channel.
    const { channelIds, eventId } = seedChannels(
      db,
      Array.from({ length: 10 }, (_, i) => ({
        name: `wh-${i}`,
        type: "webhook" as const,
        config: WEBHOOK_CONFIG,
      })),
    );
    const ids = channelIds.map((channelId) => insertPendingDelivery(db, eventId, channelId));

    const result = await runOnce({ db, now: NOW, limit: 3, senders: okSenders });

    expect(result).toEqual({ recovered: 0, attempted: 3, sent: 3, failed: 0, skipped: 0 });
    for (const id of ids.slice(0, 3)) {
      expect(getDelivery(id, db)!.status).toBe("sent");
    }
    for (const id of ids.slice(3)) {
      expect(getDelivery(id, db)!.status).toBe("pending");
    }
  });

  it("FIFO: deliveries processed in ascending id order", async () => {
    const db = createTestDb();
    const { channelIds, eventId } = seedChannels(
      db,
      Array.from({ length: 3 }, (_, i) => ({
        name: `wh-${i}`,
        type: "webhook" as const,
        config: WEBHOOK_CONFIG,
      })),
    );
    const ids = channelIds.map((channelId) => insertPendingDelivery(db, eventId, channelId));

    const sender = new RecordingSender("webhook", "ok");
    await runOnce({ db, now: NOW, senders: () => sender });

    expect(sender.calls.map((c) => c.deliveryId)).toEqual(ids);
  });

  it("stale recovery: old `sending` is recovered and delivered this tick", async () => {
    const db = createTestDb();
    const { channelIds, eventId } = seedChannels(db, [
      { name: "wh", type: "webhook", config: WEBHOOK_CONFIG },
    ]);
    const deliveryId = insertPendingDelivery(db, eventId, channelIds[0]);
    // Claimed 10 minutes ago → stale (threshold 5 min).
    setClaimedAt(db, deliveryId, new Date(NOW.getTime() - 10 * 60_000));

    const sender = new RecordingSender("webhook", "ok");
    const result = await runOnce({ db, now: NOW, senders: () => sender });

    expect(result.recovered).toBe(1);
    expect(result.sent).toBe(1);
    const row = getDelivery(deliveryId, db)!;
    expect(row.status).toBe("sent");
    // recovered → pending → re-claimed: attempts went 1 → 2.
    expect(row.attempts).toBe(2);
    expect(sender.calls).toHaveLength(1);
  });

  it("fresh `sending` is NOT recovered and NOT re-sent", async () => {
    const db = createTestDb();
    const { channelIds, eventId } = seedChannels(db, [
      { name: "wh", type: "webhook", config: WEBHOOK_CONFIG },
    ]);
    const deliveryId = insertPendingDelivery(db, eventId, channelIds[0]);
    // Claimed 10 seconds ago → still in flight, must not be touched.
    setClaimedAt(db, deliveryId, new Date(NOW.getTime() - 10_000));

    const sender = new RecordingSender("webhook", "ok");
    const result = await runOnce({ db, now: NOW, senders: () => sender });

    expect(result.recovered).toBe(0);
    expect(result.attempted).toBe(0);
    const row = getDelivery(deliveryId, db)!;
    expect(row.status).toBe("sending");
    expect(row.attempts).toBe(1);
    expect(sender.calls).toHaveLength(0);
  });

  it("one failing delivery does not block the rest of the batch", async () => {
    const db = createTestDb();
    const { channelIds, eventId } = seedChannels(db, [
      { name: "wh-0", type: "webhook", config: WEBHOOK_CONFIG },
      { name: "wh-1", type: "webhook", config: WEBHOOK_CONFIG },
    ]);
    const first = insertPendingDelivery(db, eventId, channelIds[0]);
    const second = insertPendingDelivery(db, eventId, channelIds[1]);

    let call = 0;
    const result = await runOnce({
      db,
      now: NOW,
      senders: () => new RecordingSender("webhook", ++call === 1 ? "fail" : "ok"),
    });

    expect(result).toEqual({ recovered: 0, attempted: 2, sent: 1, failed: 1, skipped: 0 });
    expect(getDelivery(first, db)!.status).toBe("failed");
    expect(getDelivery(second, db)!.status).toBe("sent");
  });

  it("overlapping workers: exactly one send, delivery sent once", async () => {
    const db = createTestDb();
    const { channelIds, eventId } = seedChannels(db, [
      { name: "wh", type: "webhook", config: WEBHOOK_CONFIG },
    ]);
    const deliveryId = insertPendingDelivery(db, eventId, channelIds[0]);

    const senderA = new RecordingSender("webhook", "ok");
    const senderB = new RecordingSender("webhook", "ok");
    const [resultA, resultB] = await Promise.all([
      runOnce({ db, now: NOW, senders: () => senderA }),
      runOnce({ db, now: NOW, senders: () => senderB }),
    ]);

    // better-sqlite3 is synchronous: within one process the two ticks
    // interleave, so the second tick's batch query no longer sees the
    // delivery the first tick already claimed (it sees `sending`). Either
    // way exactly ONE send ever happens — the cross-process CAS race
    // (both ticks read `pending`, one claim wins, the other skips) is
    // covered at the deliverDelivery level in integration.test.ts.
    expect(resultA.sent + resultB.sent).toBe(1);
    expect(senderA.calls.length + senderB.calls.length).toBe(1);
    const row = getDelivery(deliveryId, db)!;
    expect(row.status).toBe("sent");
    expect(row.attempts).toBe(1);
  });

  it("attempts increment across retry, delivery id stays stable", async () => {
    const db = createTestDb();
    const { channelIds, eventId } = seedChannels(db, [
      { name: "wh", type: "webhook", config: WEBHOOK_CONFIG },
    ]);
    const deliveryId = insertPendingDelivery(db, eventId, channelIds[0]);

    // First tick: fail.
    await runOnce({ db, now: NOW, senders: () => new RecordingSender("webhook", "fail") });
    expect(getDelivery(deliveryId, db)!.status).toBe("failed");
    expect(getDelivery(deliveryId, db)!.attempts).toBe(1);

    // Explicit retry (V0.6 semantics — worker never auto-retries).
    expect(retryDelivery(deliveryId, db)).toBe(true);

    // Second tick: succeed. Same delivery row, attempts incremented.
    const result = await runOnce({ db, now: NOW, senders: okSenders });
    expect(result.sent).toBe(1);
    const row = getDelivery(deliveryId, db)!;
    expect(row.status).toBe("sent");
    expect(row.attempts).toBe(2);
    expect(row.id).toBe(deliveryId);
  });

  it("worker does not create or duplicate events", async () => {
    const db = createTestDb();
    const { channelIds, eventId } = seedChannels(db, [
      { name: "wh", type: "webhook", config: WEBHOOK_CONFIG },
    ]);
    insertPendingDelivery(db, eventId, channelIds[0]);

    await runOnce({ db, now: NOW, senders: okSenders });
    await runOnce({ db, now: NOW, senders: okSenders });

    const events = db.select().from(notificationEvents).all();
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe(eventId);
  });

  it("worker never touches secrets: email key only reaches the sender", async () => {
    const db = createTestDb();
    const { channelIds, eventId } = seedChannels(db, [
      { name: "mail", type: "email", config: EMAIL_CONFIG },
    ]);
    const deliveryId = insertPendingDelivery(db, eventId, channelIds[0]);

    const fetchFn = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const seenHeaders: Array<Record<string, string>> = [];
    (fetchFn as unknown as { mockImplementation: (f: typeof fetch) => void }).mockImplementation(
      (url: unknown, init?: RequestInit) => {
        seenHeaders.push((init?.headers as Record<string, string>) ?? {});
        return Promise.resolve(new Response("{}", { status: 200 }));
      },
    );

    const result = await runOnce({
      db,
      now: NOW,
      senders: () =>
        new EmailSender({
          fetchFn: fetchFn as unknown as typeof fetch,
          lookup: vi.fn().mockResolvedValue(["93.184.216.34"]),
          env: { EMAIL_API_KEY: EMAIL_KEY },
        }),
    });

    expect(result).toEqual({ recovered: 0, attempted: 1, sent: 1, failed: 0, skipped: 0 });
    // The key travels ONLY in the Authorization header of the request.
    expect(seenHeaders[0].Authorization).toBe(`Bearer ${EMAIL_KEY}`);
    // The worker result and the persisted row carry no secret material.
    expect(JSON.stringify(result)).not.toContain(EMAIL_KEY);
    const row = getDelivery(deliveryId, db)!;
    expect(JSON.stringify(row)).not.toContain(EMAIL_KEY);
  });

  it("email config error surfaces as failed without leaking the key", async () => {
    const db = createTestDb();
    const { channelIds, eventId } = seedChannels(db, [
      { name: "mail", type: "email", config: EMAIL_CONFIG },
    ]);
    const deliveryId = insertPendingDelivery(db, eventId, channelIds[0]);

    // env WITHOUT the key → sender throws invalid-config before any request.
    const result = await runOnce({
      db,
      now: NOW,
      senders: () => new EmailSender({ env: {} }),
    });

    expect(result.failed).toBe(1);
    const row = getDelivery(deliveryId, db)!;
    expect(row.status).toBe("failed");
    expect(row.error).toContain("EMAIL_API_KEY");
    expect(row.error).not.toContain("Bearer");
    expect(row.error).not.toContain(EMAIL_KEY);
  });
});
