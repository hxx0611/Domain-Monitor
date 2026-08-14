import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  domains,
  notificationChannels,
  notificationDeliveries,
  notificationEvents,
  notificationRules,
} from "@/db/schema";
import { createTestDb } from "../../../test/helpers";
import { generateDeliveries } from "./service";
import { createDelivery, getEventDeliveries } from "./repository";
import type { NotificationDb } from "./repository";
import type { NotificationEvent } from "./types";

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

async function setup(db: NotificationDb) {
  db.insert(domains).values({ id: 5, hostname: "example.com" }).run();

  const channel = (name: string, enabled = 1, type: "email" | "webhook" = "email") =>
    db
      .insert(notificationChannels)
      .values({ type, name, config: '{"to":"x@example.com"}', enabled })
      .returning({ id: notificationChannels.id })
      .get().id;

  const rule = (
    channelId: number,
    filters: { source?: string | null; eventType?: string | null; domainId?: number | null } = {},
    enabled = 1,
  ) =>
    db
      .insert(notificationRules)
      .values({
        name: `rule-${channelId}`,
        channelId,
        source: filters.source ?? null,
        eventType: filters.eventType ?? null,
        domainId: filters.domainId ?? null,
        enabled,
      })
      .run();

  const insertEvent = (event: NotificationEvent) =>
    db
      .insert(notificationEvents)
      .values({
        domainId: event.domainId,
        source: event.source,
        eventType: event.eventType,
        previousState: event.previousState,
        currentState: event.currentState,
        dedupKey: event.dedupKey,
        occurredAt: event.occurredAt,
      })
      .returning({ id: notificationEvents.id })
      .get().id;

  return { channel, rule, insertEvent };
}

describe("generateDeliveries", () => {
  let db: NotificationDb;
  let helper: Awaited<ReturnType<typeof setup>>;

  beforeEach(async () => {
    db = createTestDb();
    helper = await setup(db);
  });

  it("produces zero deliveries when no rule matches", async () => {
    const eventId = await helper.insertEvent(makeEvent());
    const result = generateDeliveries(eventId, makeEvent(), { db });
    expect(result.created).toEqual([]);
    expect(getEventDeliveries(eventId, db)).toHaveLength(0);
  });

  it("matches by source", async () => {
    const ch = await helper.channel("c");
    await helper.rule(ch, { source: "http" });
    const eventId = await helper.insertEvent(makeEvent());
    const result = generateDeliveries(eventId, makeEvent(), { db });
    expect(result.created).toEqual([ch]);
  });

  it("matches by eventType", async () => {
    const ch = await helper.channel("c");
    await helper.rule(ch, { eventType: "http_status_changed" });
    const eventId = await helper.insertEvent(makeEvent());
    const result = generateDeliveries(eventId, makeEvent(), { db });
    expect(result.created).toEqual([ch]);
  });

  it("matches by domain", async () => {
    const ch = await helper.channel("c");
    await helper.rule(ch, { domainId: 5 });
    const eventId = await helper.insertEvent(makeEvent());
    const result = generateDeliveries(eventId, makeEvent(), { db });
    expect(result.created).toEqual([ch]);
  });

  it("applies AND semantics across all three filters", async () => {
    const ch = await helper.channel("c");
    await helper.rule(ch, { source: "ssl", eventType: "http_status_changed", domainId: 5 });
    const eventId = await helper.insertEvent(makeEvent());
    const result = generateDeliveries(eventId, makeEvent(), { db });
    expect(result.created).toEqual([]); // source mismatch

    await helper.rule(ch, { source: "http", eventType: "http_status_changed", domainId: 5 });
    const result2 = generateDeliveries(eventId, makeEvent(), { db });
    expect(result2.created).toEqual([ch]);
  });

  it("a null filter matches everything", async () => {
    const ch = await helper.channel("c");
    await helper.rule(ch); // all nulls
    const eventId = await helper.insertEvent(
      makeEvent({ source: "dns", eventType: "dns_record_added" }),
    );
    const result = generateDeliveries(
      eventId,
      makeEvent({ source: "dns", eventType: "dns_record_added" }),
      { db },
    );
    expect(result.created).toEqual([ch]);
  });

  it("does not generate deliveries for a disabled rule", async () => {
    const ch = await helper.channel("c");
    await helper.rule(ch, {}, 0); // disabled
    const eventId = await helper.insertEvent(makeEvent());
    const result = generateDeliveries(eventId, makeEvent(), { db });
    expect(result.created).toEqual([]);
  });

  it("creates ONE delivery when multiple rules match the same channel", async () => {
    const ch = await helper.channel("c");
    await helper.rule(ch); // catch-all
    await helper.rule(ch, { source: "http" }); // also matches
    await helper.rule(ch, { eventType: "http_status_changed" }); // and this
    const eventId = await helper.insertEvent(makeEvent());
    const result = generateDeliveries(eventId, makeEvent(), { db });
    expect(result.created).toEqual([ch]);
    expect(getEventDeliveries(eventId, db)).toHaveLength(1);
  });

  it("creates one delivery per channel for different channels", async () => {
    const ch1 = await helper.channel("c1");
    const ch2 = await helper.channel("c2");
    await helper.rule(ch1);
    await helper.rule(ch2);
    const eventId = await helper.insertEvent(makeEvent());
    const result = generateDeliveries(eventId, makeEvent(), { db });
    expect(result.created.sort()).toEqual([ch1, ch2].sort());
    expect(getEventDeliveries(eventId, db)).toHaveLength(2);
  });

  it("skips a disabled channel", async () => {
    const ch1 = await helper.channel("enabled");
    const ch2 = await helper.channel("disabled", 0);
    await helper.rule(ch1);
    await helper.rule(ch2);
    const eventId = await helper.insertEvent(makeEvent());
    const result = generateDeliveries(eventId, makeEvent(), { db });
    expect(result.created).toEqual([ch1]);
    expect(result.skipped).toEqual([ch2]);
  });

  it("is idempotent: reprocessing the same event does not duplicate deliveries", async () => {
    const ch = await helper.channel("c");
    await helper.rule(ch);
    const eventId = await helper.insertEvent(makeEvent());

    generateDeliveries(eventId, makeEvent(), { db });
    generateDeliveries(eventId, makeEvent(), { db }); // same event again

    expect(getEventDeliveries(eventId, db)).toHaveLength(1);
  });

  it("creates independent deliveries for different events", async () => {
    const ch = await helper.channel("c");
    await helper.rule(ch);

    const ev1 = makeEvent({ dedupKey: "http:5:x:ok:down" });
    const ev2 = makeEvent({
      dedupKey: "ssl:5:ssl_cert_replaced:AA:BB",
      source: "ssl",
      eventType: "ssl_cert_replaced",
    });
    const id1 = await helper.insertEvent(ev1);
    const id2 = await helper.insertEvent(ev2);

    generateDeliveries(id1, ev1, { db });
    generateDeliveries(id2, ev2, { db });

    expect(getEventDeliveries(id1, db)).toHaveLength(1);
    expect(getEventDeliveries(id2, db)).toHaveLength(1);
  });

  it("cascade-deletes deliveries when the event is deleted", async () => {
    const ch = await helper.channel("c");
    await helper.rule(ch);
    const eventId = await helper.insertEvent(makeEvent());
    generateDeliveries(eventId, makeEvent(), { db });
    expect(getEventDeliveries(eventId, db)).toHaveLength(1);

    db.delete(notificationEvents).where(eq(notificationEvents.id, eventId)).run();
    expect(db.select().from(notificationDeliveries).all()).toHaveLength(0);
  });
});

describe("createDelivery (direct)", () => {
  it("returns the delivery id on first insert and null on duplicate", () => {
    const db = createTestDb();
    db.insert(domains).values({ id: 1, hostname: "example.com" }).run();
    const ch = db
      .insert(notificationChannels)
      .values({ type: "email", name: "c", config: "{}", enabled: 1 })
      .returning({ id: notificationChannels.id })
      .get().id;
    const ev = db
      .insert(notificationEvents)
      .values({
        domainId: 1,
        source: "http",
        eventType: "http_status_changed",
        previousState: null,
        currentState: null,
        dedupKey: "k1",
        occurredAt: new Date(),
      })
      .returning({ id: notificationEvents.id })
      .get().id;

    const first = createDelivery(ev, ch, db);
    expect(first).not.toBeNull();
    const second = createDelivery(ev, ch, db);
    expect(second).toBeNull();
    expect(getEventDeliveries(ev, db)).toHaveLength(1);
  });
});
