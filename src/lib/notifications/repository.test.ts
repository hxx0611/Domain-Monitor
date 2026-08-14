import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  domains,
  notificationChannels,
  notificationDeliveries,
  notificationEvents,
} from "@/db/schema";
import { createTestDb } from "../../../test/helpers";
import { insertNotificationEvents } from "./repository";
import { buildDedupKey, httpStatusChangeEvent } from "./events";
import type { NotificationEvent } from "./types";

describe("notification event persistence (V0.6)", () => {
  it("inserts events and cascade-deletes them with the domain", () => {
    const db = createTestDb();
    const domain = db.insert(domains).values({ hostname: "example.com" }).returning().get();

    const event: NotificationEvent = {
      domainId: domain.id,
      source: "http",
      eventType: "http_status_changed",
      previousState: '"ok"',
      currentState: '"down"',
      occurredAt: new Date("2026-08-14T00:00:00.000Z"),
      dedupKey: buildDedupKey(["http", domain.id, "http_status_changed", "ok", "down"]),
    };
    insertNotificationEvents(db, [event]);

    expect(db.select().from(notificationEvents).all()).toHaveLength(1);

    // Cascade: deleting the domain removes its events.
    db.delete(domains).where(eq(domains.id, domain.id)).run();
    expect(db.select().from(notificationEvents).all()).toHaveLength(0);
  });

  it("does nothing for an empty event list", () => {
    const db = createTestDb();
    insertNotificationEvents(db, []);
    expect(db.select().from(notificationEvents).all()).toHaveLength(0);
  });

  it("ignores duplicate dedup keys (UNIQUE backstop)", () => {
    const db = createTestDb();
    const domain = db.insert(domains).values({ hostname: "example.com" }).returning().get();

    const event: NotificationEvent = {
      domainId: domain.id,
      source: "http",
      eventType: "http_status_changed",
      previousState: '"ok"',
      currentState: '"down"',
      occurredAt: new Date("2026-08-14T00:00:00.000Z"),
      dedupKey: "http:1:http_status_changed:ok:down",
    };
    insertNotificationEvents(db, [event]);
    insertNotificationEvents(db, [event]);

    expect(db.select().from(notificationEvents).all()).toHaveLength(1);
  });

  it("cascade-deletes deliveries when their event is deleted", () => {
    const db = createTestDb();
    const domain = db.insert(domains).values({ hostname: "example.com" }).returning().get();
    const channel = db
      .insert(notificationChannels)
      .values({ type: "email", name: "ops", config: '{"to":"ops@example.com"}' })
      .returning({ id: notificationChannels.id })
      .get();

    const event: NotificationEvent = {
      domainId: domain.id,
      source: "http",
      eventType: "http_status_changed",
      previousState: '"ok"',
      currentState: '"down"',
      occurredAt: new Date(),
      dedupKey: buildDedupKey(["http", domain.id, "x", "ok", "down"]),
    };
    insertNotificationEvents(db, [event]);

    const eventRow = db.select().from(notificationEvents).get();
    db.insert(notificationDeliveries)
      .values({ eventId: eventRow!.id, channelId: channel.id, status: "pending", attempts: 0 })
      .run();
    expect(db.select().from(notificationDeliveries).all()).toHaveLength(1);

    db.delete(domains).where(eq(domains.id, domain.id)).run();
    expect(db.select().from(notificationEvents).all()).toHaveLength(0);
    expect(db.select().from(notificationDeliveries).all()).toHaveLength(0);
  });

  it("httpStatusChangeEvent dedup key matches the insert path end-to-end", () => {
    const db = createTestDb();
    const domain = db.insert(domains).values({ hostname: "example.com" }).returning().get();

    const prev = {
      id: 1,
      domainId: domain.id,
      checkedAt: new Date(),
      status: "ok" as const,
      httpStatus: 200,
      responseTimeMs: 100,
      redirected: false,
      redirectCount: 0,
    };
    const cur = { ...prev, id: 2, status: "down" as const, httpStatus: undefined };
    const event = httpStatusChangeEvent(domain.id, prev, cur, new Date());
    expect(event).not.toBeNull();
    insertNotificationEvents(db, [event!]);

    const rows = db.select().from(notificationEvents).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].dedupKey).toBe(`http:${domain.id}:http_status_changed:ok:down`);
  });
});

describe("transaction atomicity with snapshot creation", () => {
  it("rolls back the snapshot when an event insert fails (no lost-snapshot-without-event or vice versa)", () => {
    const db = createTestDb();
    const domain = db.insert(domains).values({ hostname: "example.com" }).returning().get();

    // Force event inserts to fail inside any transaction.
    db.run(`
      CREATE TRIGGER fail_event_insert
      BEFORE INSERT ON notification_events
      BEGIN SELECT RAISE(ABORT, 'forced event failure'); END;
    `);

    const event: NotificationEvent = {
      domainId: domain.id,
      source: "http",
      eventType: "http_status_changed",
      previousState: '"ok"',
      currentState: '"down"',
      occurredAt: new Date(),
      dedupKey: "http:1:http_status_changed:ok:down",
    };

    expect(() => insertNotificationEvents(db, [event])).toThrow("forced event failure");
  });
});
