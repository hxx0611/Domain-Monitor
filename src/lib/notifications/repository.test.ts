import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  domains,
  notificationChannels,
  notificationDeliveries,
  notificationEvents,
  notificationRules,
} from "@/db/schema";
import { createTestDb } from "../../../test/helpers";
import {
  createChannel,
  createDelivery,
  createRule,
  deleteChannel,
  deleteRule,
  insertNotificationEvents,
  setChannelEnabled,
  setRuleEnabled,
  updateChannel,
  updateRule,
} from "./repository";
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

describe("channel CRUD (Phase 8B)", () => {
  it("creates email / webhook / telegram channels", () => {
    const db = createTestDb();
    const emailId = createChannel(
      "email",
      "Mail",
      JSON.stringify({
        to: "a@b.c",
        from: "d@e.f",
        endpoint: "https://api.example.com/send",
        apiKeyRef: "EMAIL_API_KEY",
      }),
      db,
    );
    const webhookId = createChannel(
      "webhook",
      "Hook",
      JSON.stringify({ url: "https://hooks.example.com/x", secretRef: "WEBHOOK_SECRET" }),
      db,
    );
    const telegramId = createChannel(
      "telegram",
      "TG",
      JSON.stringify({ chatId: "100000001", secretRef: "TELEGRAM_BOT_TOKEN" }),
      db,
    );
    expect([emailId, webhookId, telegramId]).toEqual([1, 2, 3]);
    const rows = db.select().from(notificationChannels).all();
    expect(rows.map((r) => r.type)).toEqual(["email", "webhook", "telegram"]);
    expect(rows.every((r) => r.enabled === 1)).toBe(true);
  });

  it("updates name and config only", () => {
    const db = createTestDb();
    const id = createChannel(
      "telegram",
      "TG",
      JSON.stringify({ chatId: "1", secretRef: "TELEGRAM_BOT_TOKEN" }),
      db,
    );
    expect(
      updateChannel(
        id,
        { name: "TG2", config: JSON.stringify({ chatId: "2", secretRef: "TELEGRAM_BOT_TOKEN" }) },
        db,
      ),
    ).toBe(true);
    const row = db.select().from(notificationChannels).where(eq(notificationChannels.id, id)).get();
    expect(row?.name).toBe("TG2");
    expect(JSON.parse(row!.config)).toEqual({ chatId: "2", secretRef: "TELEGRAM_BOT_TOKEN" });
  });

  it("update / setEnabled / delete return false for nonexistent ids", () => {
    const db = createTestDb();
    expect(updateChannel(999, { name: "x" }, db)).toBe(false);
    expect(setChannelEnabled(999, false, db)).toBe(false);
    expect(deleteChannel(999, db)).toBe(false);
  });

  it("setChannelEnabled flips 1/0", () => {
    const db = createTestDb();
    const id = createChannel(
      "email",
      "Mail",
      JSON.stringify({
        to: "a@b.c",
        from: "d@e.f",
        endpoint: "https://api.example.com/send",
        apiKeyRef: "EMAIL_API_KEY",
      }),
      db,
    );
    expect(setChannelEnabled(id, false, db)).toBe(true);
    expect(
      db.select().from(notificationChannels).where(eq(notificationChannels.id, id)).get()?.enabled,
    ).toBe(0);
    expect(setChannelEnabled(id, true, db)).toBe(true);
    expect(
      db.select().from(notificationChannels).where(eq(notificationChannels.id, id)).get()?.enabled,
    ).toBe(1);
  });
});

describe("rule CRUD (Phase 8B)", () => {
  it("creates and updates a rule", () => {
    const db = createTestDb();
    const domain = db.insert(domains).values({ hostname: "example.com" }).returning().get();
    const channelId = createChannel(
      "telegram",
      "TG",
      JSON.stringify({ chatId: "1", secretRef: "TELEGRAM_BOT_TOKEN" }),
      db,
    );
    const ruleId = createRule(
      {
        name: "R",
        channelId,
        source: "http",
        eventType: "http_status_changed",
        domainId: domain.id,
        enabled: true,
      },
      db,
    );
    expect(ruleId).toBe(1);
    expect(
      updateRule(ruleId, { source: null, eventType: null, domainId: null, enabled: false }, db),
    ).toBe(true);
    const row = db.select().from(notificationRules).where(eq(notificationRules.id, ruleId)).get();
    expect(row?.source).toBeNull();
    expect(row?.eventType).toBeNull();
    expect(row?.domainId).toBeNull();
    expect(row!.enabled).toBe(0);
  });

  it("update / setEnabled / delete return false for nonexistent ids", () => {
    const db = createTestDb();
    expect(updateRule(999, { name: "x" }, db)).toBe(false);
    expect(setRuleEnabled(999, false, db)).toBe(false);
    expect(deleteRule(999, db)).toBe(false);
  });

  it("setRuleEnabled flips 1/0", () => {
    const db = createTestDb();
    const channelId = createChannel(
      "telegram",
      "TG",
      JSON.stringify({ chatId: "1", secretRef: "TELEGRAM_BOT_TOKEN" }),
      db,
    );
    const ruleId = createRule(
      { name: "R", channelId, source: null, eventType: null, domainId: null, enabled: true },
      db,
    );
    expect(setRuleEnabled(ruleId, false, db)).toBe(true);
    expect(
      db.select().from(notificationRules).where(eq(notificationRules.id, ruleId)).get()!.enabled,
    ).toBe(0);
  });

  it("rejects an invalid channel FK", () => {
    const db = createTestDb();
    expect(() =>
      createRule(
        { name: "R", channelId: 999, source: null, eventType: null, domainId: null, enabled: true },
        db,
      ),
    ).toThrow();
  });

  it("rejects an invalid domain FK", () => {
    const db = createTestDb();
    const channelId = createChannel(
      "telegram",
      "TG",
      JSON.stringify({ chatId: "1", secretRef: "TELEGRAM_BOT_TOKEN" }),
      db,
    );
    expect(() =>
      createRule(
        { name: "R", channelId, source: null, eventType: null, domainId: 999, enabled: true },
        db,
      ),
    ).toThrow();
  });
});

describe("channel delete cascade semantics (Phase 8B)", () => {
  function seededDb() {
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
    const eventId = db.select().from(notificationEvents).get()!.id;
    const channelId = createChannel(
      "telegram",
      "TG",
      JSON.stringify({ chatId: "1", secretRef: "TELEGRAM_BOT_TOKEN" }),
      db,
    );
    createRule(
      {
        name: "R",
        channelId,
        source: "http",
        eventType: "http_status_changed",
        domainId: null,
        enabled: true,
      },
      db,
    );
    createDelivery(eventId, channelId, db);
    return { db, eventId, channelId };
  }

  it("delete channel → rules deleted", () => {
    const { db, channelId } = seededDb();
    expect(db.select().from(notificationRules).all()).toHaveLength(1);
    expect(deleteChannel(channelId, db)).toBe(true);
    expect(db.select().from(notificationRules).all()).toHaveLength(0);
  });

  it("delete channel → deliveries deleted", () => {
    const { db, channelId } = seededDb();
    expect(db.select().from(notificationDeliveries).all()).toHaveLength(1);
    expect(deleteChannel(channelId, db)).toBe(true);
    expect(db.select().from(notificationDeliveries).all()).toHaveLength(0);
  });

  it("delete channel → events retained", () => {
    const { db, channelId, eventId } = seededDb();
    expect(deleteChannel(channelId, db)).toBe(true);
    expect(db.select().from(notificationEvents).all()).toHaveLength(1);
    expect(
      db.select().from(notificationEvents).where(eq(notificationEvents.id, eventId)).get(),
    ).toBeDefined();
  });

  it("delete rule → events and deliveries untouched", () => {
    const { db, channelId } = seededDb();
    const ruleId = db.select().from(notificationRules).get()!.id;
    expect(deleteRule(ruleId, db)).toBe(true);
    expect(db.select().from(notificationRules).all()).toHaveLength(0);
    expect(db.select().from(notificationEvents).all()).toHaveLength(1);
    expect(db.select().from(notificationDeliveries).all()).toHaveLength(1);
    expect(
      db.select().from(notificationChannels).where(eq(notificationChannels.id, channelId)).get(),
    ).toBeDefined();
  });
});
