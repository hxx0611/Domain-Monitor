/**
 * V0.6 Phase 5B — read-only display queries backing the /notifications UI.
 *
 * These are pure SELECTs (channels, rules, deliveries) that join channels /
 * events / domains for display. The main risk is join-column collisions
 * (e.g. `id` existing on both deliveries and events), so the tests assert
 * the aliased display shape explicitly.
 */

import { describe, expect, it } from "vitest";
import {
  domains,
  notificationChannels,
  notificationDeliveries,
  notificationEvents,
  notificationRules,
} from "@/db/schema";
import { createTestDb } from "../../../test/helpers";
import {
  getChannels,
  getDeliveriesWithDetails,
  getEvent,
  getRules,
  type NotificationDb,
} from "./repository";

function seed(db: NotificationDb): { eventId: number; deliveryId: number } {
  db.insert(domains).values({ id: 5, hostname: "example.com" }).run();
  db.insert(notificationChannels)
    .values({
      id: 1,
      type: "email",
      name: "Ops email",
      config: JSON.stringify({
        to: "ops@example.com",
        from: "dm@example.com",
        apiKeyRef: "EMAIL_API_KEY",
      }),
      enabled: 1,
    })
    .run();
  db.insert(notificationChannels)
    .values({
      id: 2,
      type: "webhook",
      name: "Alerts webhook",
      config: JSON.stringify({ url: "https://hooks.example.com/dm", secretRef: "WEBHOOK_SECRET" }),
      enabled: 1,
    })
    .run();
  db.insert(notificationRules)
    .values({
      id: 1,
      name: "http-down",
      channelId: 1,
      source: "http",
      eventType: null,
      domainId: 5,
      enabled: 1,
    })
    .run();
  const eventId = db
    .insert(notificationEvents)
    .values({
      id: 10,
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
  const deliveryId = db
    .insert(notificationDeliveries)
    .values({
      id: 100,
      eventId,
      channelId: 1,
      status: "sent",
      attempts: 1,
      deliveredAt: new Date("2026-08-14T00:01:00.000Z"),
    })
    .returning({ id: notificationDeliveries.id })
    .get().id;
  return { eventId, deliveryId };
}

describe("notification display queries (V0.6 Phase 5B)", () => {
  it("getChannels returns all channels including config", () => {
    const db = createTestDb();
    seed(db);

    const channels = getChannels(db);
    expect(channels.map((c) => c.name)).toEqual(["Ops email", "Alerts webhook"]);
    expect(JSON.parse(channels[0].config)).toMatchObject({ apiKeyRef: "EMAIL_API_KEY" });
    expect(channels[0].enabled).toBe(1);
  });

  it("getRules joins the channel name and domain hostname", () => {
    const db = createTestDb();
    seed(db);

    const [rule] = getRules(db);
    expect(rule).toMatchObject({
      name: "http-down",
      source: "http",
      eventType: null,
      channelName: "Ops email",
      channelType: "email",
      hostname: "example.com",
      enabled: 1,
    });
  });

  it("getEvent returns the full persisted event row", () => {
    const db = createTestDb();
    const { eventId } = seed(db);

    const event = getEvent(eventId, db);
    expect(event?.id).toBe(eventId);
    expect(event?.eventType).toBe("http_status_changed");
    expect(event?.dedupKey).toBe("http:5:http_status_changed:ok:down");
    expect(event?.occurredAt).toEqual(new Date("2026-08-14T00:00:00.000Z"));
  });

  it("getDeliveriesWithDetails joins channel name + event details, newest first", () => {
    const db = createTestDb();
    seed(db);
    // Second, older delivery to assert ordering (desc by id).
    const second = db
      .insert(notificationDeliveries)
      .values({
        eventId: 10,
        channelId: 2,
        status: "failed",
        attempts: 2,
        error: "Webhook returned HTTP 500.",
      })
      .returning({ id: notificationDeliveries.id })
      .get();

    const rows = getDeliveriesWithDetails(db);
    expect(rows).toHaveLength(2);
    expect(rows[0].deliveryId).toBe(second.id);
    expect(rows[0]).toMatchObject({
      eventId: 10,
      channelName: "Alerts webhook",
      channelType: "webhook",
      eventType: "http_status_changed",
      source: "http",
      hostname: "example.com",
      status: "failed",
      attempts: 2,
      error: "Webhook returned HTTP 500.",
      deliveredAt: null,
    });
    expect(rows[1].deliveryId).toBe(100);
    expect(rows[1].channelName).toBe("Ops email");
    expect(rows[1].status).toBe("sent");
    expect(rows[1].deliveredAt).toEqual(new Date("2026-08-14T00:01:00.000Z"));
  });
});
