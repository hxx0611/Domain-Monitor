/**
 * Phase 11D STEP 3 — expiration-reminder E2E (fake sender, no network).
 *
 * Full pipeline: domain (manual expiration) → reminder → expiration rule →
 * worker tick → event → delivery → fake sender → sent. Then a second tick
 * must not duplicate anything (dedup by event dedupKey + UNIQUE delivery).
 *
 * This locks down the Phase 11D fix: `evaluateExpirationReminders` now uses
 * `insertEventsAndGenerateDeliveries`, so a recorded reminder actually
 * produces a pending delivery (before, only the event row was inserted and
 * nothing ever delivered it).
 */

import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  domains,
  expirationReminders,
  notificationChannels,
  notificationDeliveries,
  notificationEvents,
  notificationRules,
} from "@/db/schema";
import { createTestDb } from "../../../test/helpers";
import { runOnce } from "./worker";
import type { ChannelType, DeliverySender, NotificationEvent } from "./types";
import type { NotificationDb } from "./repository";

class FakeSender implements DeliverySender {
  readonly channelType: ChannelType;
  readonly calls: Array<{ deliveryId: number; event: NotificationEvent }> = [];
  constructor(readonly type: ChannelType) {
    this.channelType = type;
  }
  async send(deliveryId: number, event: NotificationEvent): Promise<void> {
    this.calls.push({ deliveryId, event });
  }
}

function seedExpirationE2E(db: NotificationDb): void {
  db.insert(domains)
    .values({
      hostname: "expiry-e2e.example.com",
      expirationSource: "manual",
      expirationDate: "2026-08-20",
    })
    .run();
  const domain = db.select().from(domains).get()!;
  const channelId = db
    .insert(notificationChannels)
    .values({
      type: "webhook",
      name: "e2e-wh",
      config: JSON.stringify({ url: "https://hooks.example.com/e2e" }),
      enabled: 1,
    })
    .returning({ id: notificationChannels.id })
    .get().id;
  db.insert(expirationReminders).values({ domainId: domain.id, daysBefore: 7 }).run();
  db.insert(notificationRules)
    .values({
      name: "expiration-rule",
      domainId: domain.id,
      source: "expiration",
      eventType: "expiration_reminder",
      channelId,
      enabled: 1,
    })
    .run();
}

describe("Phase 11D — expiration reminder E2E (fake sender)", () => {
  it("manual expiration → reminder → event → delivery → sent; second tick duplicates nothing", async () => {
    const db = createTestDb();
    seedExpirationE2E(db);
    const sender = new FakeSender("webhook");
    // Target day = 2026-08-20 − 7d = 2026-08-13; NOW is on/after that day.
    const NOW = new Date("2026-08-14T12:00:00.000Z");

    const first = await runOnce({ db, now: NOW, senders: () => sender });
    expect(first).toEqual({
      expirationEvents: 1,
      recovered: 0,
      attempted: 1,
      sent: 1,
      failed: 0,
      skipped: 0,
    });

    const events = db.select().from(notificationEvents).all();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      source: "expiration",
      eventType: "expiration_reminder",
      dedupKey: `expiration:${events[0].domainId}:2026-08-20:7`,
    });

    const deliveries = db.select().from(notificationDeliveries).all();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ status: "sent", attempts: 1 });
    expect(deliveries[0].error).toBeNull();
    expect(sender.calls).toHaveLength(1);

    // Second tick: nothing new (dedup at event layer + UNIQUE(event_id, channel_id)).
    const second = await runOnce({ db, now: NOW, senders: () => sender });
    expect(second).toEqual({
      expirationEvents: 0,
      recovered: 0,
      attempted: 0,
      sent: 0,
      failed: 0,
      skipped: 0,
    });
    expect(db.select().from(notificationEvents).all()).toHaveLength(1);
    expect(db.select().from(notificationDeliveries).all()).toHaveLength(1);
    expect(sender.calls).toHaveLength(1);
  });

  it("no expiration rule → event exists but no delivery (rule semantics preserved)", async () => {
    const db = createTestDb();
    seedExpirationE2E(db);
    // Disable the rule so matching yields nothing.
    db.update(notificationRules)
      .set({ enabled: 0 })
      .where(eq(notificationRules.source, "expiration"))
      .run();

    const result = await runOnce({
      db,
      now: new Date("2026-08-14T12:00:00.000Z"),
      senders: () => new FakeSender("webhook"),
    });
    expect(result.expirationEvents).toBe(1);
    expect(result.attempted).toBe(0);
    expect(db.select().from(notificationEvents).all()).toHaveLength(1);
    expect(db.select().from(notificationDeliveries).all()).toHaveLength(0);
  });
});
