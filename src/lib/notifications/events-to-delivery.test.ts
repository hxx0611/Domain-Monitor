/**
 * V0.7 Phase 4 — Event → Delivery automatic generation inside the check
 * transaction.
 *
 * Proves the closed loop:
 *
 *   Check → create*Snapshot → transaction {
 *     snapshot (+records/certificate)
 *     insertEventsAndGenerateDeliveries → event + pending delivery
 *   } → worker runOnce → sender → sent
 *
 * Also proves atomicity (delivery-generation failure rolls back the whole
 * transaction) and that the V0.6 dedup / rule / channel semantics are
 * unchanged. The HTTP service-level test exercises the REAL checkHttp →
 * createHttpSnapshot → event → delivery → runOnce path with a fake
 * sender (no network).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  domains,
  dnsSnapshots,
  notificationChannels,
  notificationDeliveries,
  notificationEvents,
  notificationRules,
} from "@/db/schema";
import { createTestDb } from "../../../test/helpers";
import { createDnsSnapshot } from "@/lib/dns/repository";
import { createSslSnapshot } from "@/lib/ssl/repository";
import { createHttpSnapshot } from "@/lib/http/repository";
import { checkHttp } from "@/lib/http/service";
import { dnsChangesToEvents, httpStatusChangeEvent, sslChangesToEvents } from "./events";
import { runOnce } from "./worker";
import { type NotificationDb } from "./repository";
import * as notificationsRepository from "./repository";
import type { DeliverySender, NotificationEvent } from "./types";
import type { HttpSnapshot } from "@/lib/http/types";

// HTTP service mocks: ONLY the network/domain lookup; the repository and
// the whole notifications pipeline run for real.
vi.mock("@/lib/http/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/http/client")>();
  return { ...actual, fetchHttpStatus: vi.fn() };
});
vi.mock("@/lib/domains", () => ({ getDomainById: vi.fn() }));

import { fetchHttpStatus } from "@/lib/http/client";
import { getDomainById } from "@/lib/domains";

const mockedFetch = vi.mocked(fetchHttpStatus);
const mockedGetDomain = vi.mocked(getDomainById);

const OCCURRED = new Date("2026-08-15T00:00:00.000Z");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHttpEvent(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    domainId: 5,
    source: "http",
    eventType: "http_status_changed",
    previousState: '"ok"',
    currentState: '"down"',
    occurredAt: OCCURRED,
    dedupKey: "http:5:http_status_changed:ok:down",
    ...overrides,
  };
}

function seedDomain(db: NotificationDb): number {
  return db.insert(domains).values({ hostname: "example.com" }).returning({ id: domains.id }).get()
    .id;
}

function seedChannel(
  db: NotificationDb,
  overrides: Partial<{
    name: string;
    type: "email" | "webhook";
    config: string;
    enabled: number;
  }> = {},
): number {
  return db
    .insert(notificationChannels)
    .values({
      type: "webhook",
      name: "wh",
      config: JSON.stringify({ url: "https://127.0.0.1/wh" }),
      enabled: 1,
      ...overrides,
    })
    .returning({ id: notificationChannels.id })
    .get().id;
}

function seedRule(
  db: NotificationDb,
  channelId: number,
  overrides: Partial<{
    source: string | null;
    eventType: string | null;
    domainId: number | null;
    enabled: number;
  }> = {},
): number {
  return db
    .insert(notificationRules)
    .values({
      name: `rule-${channelId}`,
      channelId,
      source: null,
      eventType: null,
      domainId: null,
      enabled: 1,
      ...overrides,
    })
    .returning({ id: notificationRules.id })
    .get().id;
}

function deliveriesFor(db: NotificationDb, eventId: number) {
  return db
    .select()
    .from(notificationDeliveries)
    .where(eq(notificationDeliveries.eventId, eventId))
    .all();
}

function eventsFor(db: NotificationDb) {
  return db.select().from(notificationEvents).all();
}

class RecordingSender implements DeliverySender {
  readonly channelType = "webhook" as const;
  calls: number[] = [];
  async send(deliveryId: number): Promise<void> {
    this.calls.push(deliveryId);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1-4. DNS / SSL / HTTP events → pending deliveries (repository level)
// ---------------------------------------------------------------------------

describe("event → delivery inside the check transaction", () => {
  it("DNS record added → one pending delivery", () => {
    const db = createTestDb();
    const domainId = seedDomain(db);
    const channelId = seedChannel(db);
    seedRule(db, channelId, { source: "dns" });

    const [event] = dnsChangesToEvents(
      domainId,
      [{ type: "RECORD_ADDED", record: { type: "A", name: "www", value: "1.2.3.4" } }],
      OCCURRED,
    );

    const snapshotId = createDnsSnapshot(domainId, [], db, [event]);
    const snapshots = db.select().from(dnsSnapshots).all();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].id).toBe(snapshotId);
    const deliveries = db.select().from(notificationDeliveries).all();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].status).toBe("pending");
    expect(deliveries[0].channelId).toBe(channelId);
    expect(deliveries[0].attempts).toBe(0);
  });

  it("SSL cert replaced → one pending delivery", () => {
    const db = createTestDb();
    const domainId = seedDomain(db);
    const channelId = seedChannel(db);
    seedRule(db, channelId, { source: "ssl" });

    const events = sslChangesToEvents({
      domainId,
      changes: [{ type: "CERT_REPLACED", previousFingerprint: "AA", currentFingerprint: "BB" }],
      previousStatus: undefined,
      currentStatus: "ok",
      occurredAt: OCCURRED,
    });

    createSslSnapshot({ domainId, status: "ok" }, db, events);

    const deliveries = db.select().from(notificationDeliveries).all();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].status).toBe("pending");
    expect(deliveries[0].channelId).toBe(channelId);
  });

  it("SSL status change → one pending delivery", () => {
    const db = createTestDb();
    const domainId = seedDomain(db);
    const channelId = seedChannel(db);
    seedRule(db, channelId, { source: "ssl" });

    const events = sslChangesToEvents({
      domainId,
      changes: [],
      previousStatus: "ok",
      currentStatus: "expires_soon",
      occurredAt: OCCURRED,
    });
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe("ssl_status_changed");

    createSslSnapshot({ domainId, status: "expires_soon" }, db, events);

    const deliveries = deliveriesFor(db, 0);
    void deliveries;
    const all = db.select().from(notificationDeliveries).all();
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe("pending");
  });

  it("HTTP status change → one pending delivery", () => {
    const db = createTestDb();
    const domainId = seedDomain(db);
    const channelId = seedChannel(db);
    seedRule(db, channelId, { source: "http" });

    const previous: HttpSnapshot = {
      id: 1,
      domainId,
      checkedAt: OCCURRED,
      status: "ok",
      httpStatus: 200,
      redirected: false,
      redirectCount: 0,
    };
    const current: HttpSnapshot = {
      id: 2,
      domainId,
      checkedAt: OCCURRED,
      status: "down",
      redirected: false,
      redirectCount: 0,
    };
    const event = httpStatusChangeEvent(domainId, previous, current, OCCURRED)!;
    expect(event.eventType).toBe("http_status_changed");

    createHttpSnapshot(
      { domainId, status: "down", httpStatus: 503, redirected: false, redirectCount: 0 },
      db,
      [event],
    );

    const deliveries = db.select().from(notificationDeliveries).all();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].status).toBe("pending");
    expect(deliveries[0].channelId).toBe(channelId);
  });
});

// ---------------------------------------------------------------------------
// 5-8. No-match / disabled cases
// ---------------------------------------------------------------------------

describe("no-match and disabled cases keep V0.6 semantics", () => {
  it("first check (no event) → zero events, zero deliveries", () => {
    const db = createTestDb();
    const domainId = seedDomain(db);
    const channelId = seedChannel(db);
    seedRule(db, channelId);

    createHttpSnapshot(
      { domainId, status: "ok", httpStatus: 200, redirected: false, redirectCount: 0 },
      db,
      [],
    );

    expect(eventsFor(db)).toHaveLength(0);
    expect(db.select().from(notificationDeliveries).all()).toHaveLength(0);
  });

  it("no matching rule → event exists, zero deliveries", () => {
    const db = createTestDb();
    const domainId = seedDomain(db);
    const channelId = seedChannel(db);
    seedRule(db, channelId, { source: "dns" }); // matches DNS only

    const event = makeHttpEvent({ domainId });
    createHttpSnapshot(
      { domainId, status: "down", httpStatus: 503, redirected: false, redirectCount: 0 },
      db,
      [event],
    );

    expect(eventsFor(db)).toHaveLength(1);
    expect(db.select().from(notificationDeliveries).all()).toHaveLength(0);
  });

  it("disabled rule → event exists, zero deliveries", () => {
    const db = createTestDb();
    const domainId = seedDomain(db);
    const channelId = seedChannel(db);
    seedRule(db, channelId, { enabled: 0 });

    const event = makeHttpEvent({ domainId });
    createHttpSnapshot(
      { domainId, status: "down", httpStatus: 503, redirected: false, redirectCount: 0 },
      db,
      [event],
    );

    expect(eventsFor(db)).toHaveLength(1);
    expect(db.select().from(notificationDeliveries).all()).toHaveLength(0);
  });

  it("disabled channel → event exists, zero deliveries", () => {
    const db = createTestDb();
    const domainId = seedDomain(db);
    const channelId = seedChannel(db, { enabled: 0 });
    seedRule(db, channelId);

    const event = makeHttpEvent({ domainId });
    createHttpSnapshot(
      { domainId, status: "down", httpStatus: 503, redirected: false, redirectCount: 0 },
      db,
      [event],
    );

    expect(eventsFor(db)).toHaveLength(1);
    expect(db.select().from(notificationDeliveries).all()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 9-11. Fan-out / multi-event
// ---------------------------------------------------------------------------

describe("fan-out and multi-event checks", () => {
  it("multiple rules for the same channel → exactly one delivery", () => {
    const db = createTestDb();
    const domainId = seedDomain(db);
    const channelId = seedChannel(db);
    seedRule(db, channelId, { source: null });
    seedRule(db, channelId, { source: "http" });

    const event = makeHttpEvent({ domainId });
    createHttpSnapshot(
      { domainId, status: "down", httpStatus: 503, redirected: false, redirectCount: 0 },
      db,
      [event],
    );

    const deliveries = db.select().from(notificationDeliveries).all();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].channelId).toBe(channelId);
  });

  it("multiple channels → one delivery per channel", () => {
    const db = createTestDb();
    const domainId = seedDomain(db);
    const ch1 = seedChannel(db, { name: "wh-1" });
    const ch2 = seedChannel(db, { name: "wh-2" });
    seedRule(db, ch1);
    seedRule(db, ch2);

    const event = makeHttpEvent({ domainId });
    createHttpSnapshot(
      { domainId, status: "down", httpStatus: 503, redirected: false, redirectCount: 0 },
      db,
      [event],
    );

    const deliveries = db.select().from(notificationDeliveries).all();
    expect(deliveries).toHaveLength(2);
    expect(deliveries.map((d) => d.channelId).sort()).toEqual([ch1, ch2].sort());
  });

  it("one SSL check with two events → independent deliveries per event", () => {
    const db = createTestDb();
    const domainId = seedDomain(db);
    const channelId = seedChannel(db);
    seedRule(db, channelId, { source: "ssl" });

    const events = sslChangesToEvents({
      domainId,
      changes: [{ type: "CERT_REPLACED", previousFingerprint: "AA", currentFingerprint: "BB" }],
      previousStatus: "ok",
      currentStatus: "expired",
      occurredAt: OCCURRED,
    });
    expect(events).toHaveLength(2); // cert_replaced + status_changed

    createSslSnapshot({ domainId, status: "expired" }, db, events);

    const deliveries = db.select().from(notificationDeliveries).all();
    expect(deliveries).toHaveLength(2);
    const eventIds = new Set(deliveries.map((d) => d.eventId));
    expect(eventIds.size).toBe(2); // one delivery per distinct event
    for (const d of deliveries) {
      expect(d.status).toBe("pending");
      expect(d.channelId).toBe(channelId);
    }
  });
});

// ---------------------------------------------------------------------------
// 12. Dedup
// ---------------------------------------------------------------------------

describe("dedup semantics are preserved", () => {
  it("duplicate dedupKey across two checks → still one event and one delivery", () => {
    const db = createTestDb();
    const domainId = seedDomain(db);
    const channelId = seedChannel(db);
    seedRule(db, channelId, { source: "http" });

    const data = {
      domainId,
      status: "down" as const,
      httpStatus: 503,
      redirected: false,
      redirectCount: 0,
    };
    const event = makeHttpEvent({ domainId });

    createHttpSnapshot(data, db, [event]);
    createHttpSnapshot(data, db, [event]); // same dedupKey again

    expect(eventsFor(db)).toHaveLength(1);
    const deliveries = db.select().from(notificationDeliveries).all();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].attempts).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 13. Atomicity
// ---------------------------------------------------------------------------

describe("transaction atomicity", () => {
  it("delivery-generation failure rolls back snapshot + event + delivery", () => {
    const db = createTestDb();
    const domainId = seedDomain(db);
    const channelId = seedChannel(db);
    seedRule(db, channelId);

    const event = makeHttpEvent({ domainId });

    // Force createDelivery (inside the check transaction) to throw.
    const spy = vi.spyOn(notificationsRepository, "createDelivery").mockImplementation(() => {
      throw new Error("forced delivery failure");
    });

    expect(() => createDnsSnapshot(domainId, [], db, [event])).toThrow("forced delivery failure");

    spy.mockRestore();

    // Nothing may exist: no snapshot, no event, no delivery.
    const snapshots = db.select().from(notificationDeliveries).all();
    expect(snapshots).toHaveLength(0);
    expect(eventsFor(db)).toHaveLength(0);
    const deliveries = db.select().from(notificationDeliveries).all();
    expect(deliveries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 14-15. Worker consumes auto-generated pending deliveries
// ---------------------------------------------------------------------------

describe("worker consumes auto-generated deliveries", () => {
  it("pending → runOnce → sent, with stable delivery/event ids", async () => {
    const db = createTestDb();
    const domainId = seedDomain(db);
    const channelId = seedChannel(db);
    seedRule(db, channelId, { source: "http" });

    const event = makeHttpEvent({ domainId });
    createHttpSnapshot(
      { domainId, status: "down", httpStatus: 503, redirected: false, redirectCount: 0 },
      db,
      [event],
    );

    const eventRow = eventsFor(db)[0];
    const [delivery] = deliveriesFor(db, eventRow.id);
    expect(delivery).toBeDefined();
    expect(delivery.eventId).toBe(eventRow.id); // stable eventId linkage

    const sender = new RecordingSender();
    const result = await runOnce({ db, senders: () => sender });

    expect(result).toEqual({ recovered: 0, attempted: 1, sent: 1, failed: 0, skipped: 0 });
    expect(sender.calls).toEqual([delivery.id]); // stable deliveryId

    const after = db.select().from(notificationDeliveries).all();
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(delivery.id);
    expect(after[0].status).toBe("sent");
    expect(after[0].attempts).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 16-17. Real HTTP service path (checkHttp → event → delivery → worker)
// ---------------------------------------------------------------------------

describe("real HTTP service path (checkHttp)", () => {
  it("ok → error transition generates a delivery; recovery semantics unchanged", async () => {
    const db = createTestDb();
    const domain = db.insert(domains).values({ hostname: "example.com" }).returning().get();
    const channelId = seedChannel(db);
    seedRule(db, channelId, { source: "http" });
    mockedGetDomain.mockReturnValue({ id: domain.id, hostname: "example.com" } as never);

    // First check: ok, no previous → no event, no delivery.
    mockedFetch.mockResolvedValue({
      status: 200,
      statusText: "OK",
      redirected: false,
      redirectCount: 0,
      finalUrl: undefined,
      responseTimeMs: 12,
    } as never);
    const first = await checkHttp(domain.id, { db });
    expect(first.ok).toBe(true);
    expect(eventsFor(db)).toHaveLength(0);
    expect(db.select().from(notificationDeliveries).all()).toHaveLength(0);

    // Second check: transport failure → ok → error transition event.
    mockedFetch.mockRejectedValue(new Error("connection refused"));
    const second = await checkHttp(domain.id, { db });
    expect(second.ok).toBe(false);

    const events = eventsFor(db);
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe("http_status_changed");
    expect(events[0].previousState).toContain("ok");
    expect(events[0].currentState).toContain("error");

    const deliveries = db.select().from(notificationDeliveries).all();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].eventId).toBe(events[0].id);
    expect(deliveries[0].status).toBe("pending");

    // Third check: still error → no NEW event (same status), no new delivery.
    mockedFetch.mockRejectedValue(new Error("connection refused"));
    await checkHttp(domain.id, { db });
    expect(eventsFor(db)).toHaveLength(1);
    expect(db.select().from(notificationDeliveries).all()).toHaveLength(1);
  });

  it("full loop: checkHttp → event → delivery → worker → sent (fake sender)", async () => {
    const db = createTestDb();
    const domain = db.insert(domains).values({ hostname: "example.com" }).returning().get();
    const channelId = seedChannel(db);
    seedRule(db, channelId, { source: "http" });
    mockedGetDomain.mockReturnValue({ id: domain.id, hostname: "example.com" } as never);

    mockedFetch.mockResolvedValue({
      status: 200,
      statusText: "OK",
      redirected: false,
      redirectCount: 0,
      finalUrl: undefined,
      responseTimeMs: 12,
    } as never);
    await checkHttp(domain.id, { db });

    mockedFetch.mockResolvedValue({
      status: 503,
      statusText: "Service Unavailable",
      redirected: false,
      redirectCount: 0,
      finalUrl: undefined,
      responseTimeMs: 8,
    } as never);
    const second = await checkHttp(domain.id, { db });
    expect(second.ok).toBe(true);

    const deliveries = db.select().from(notificationDeliveries).all();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].status).toBe("pending");

    const sender = new RecordingSender();
    const result = await runOnce({ db, senders: () => sender });
    expect(result.sent).toBe(1);
    expect(sender.calls).toEqual([deliveries[0].id]);

    const after = db.select().from(notificationDeliveries).all();
    expect(after[0].status).toBe("sent");
  });
});
