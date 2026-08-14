import { describe, expect, it } from "vitest";
import { domains, notificationChannels, notificationEvents } from "@/db/schema";
import { createTestDb } from "../../../test/helpers";
import {
  claimPendingDelivery,
  createDelivery,
  getDelivery,
  markDeliveryFailed,
  markDeliverySent,
  recoverStaleSending,
  retryDelivery,
  type NotificationDb,
} from "./repository";

function seed(db: NotificationDb) {
  db.insert(domains).values({ id: 1, hostname: "example.com" }).run();
  const channel = db
    .insert(notificationChannels)
    .values({ type: "email", name: "c", config: "{}", enabled: 1 })
    .returning({ id: notificationChannels.id })
    .get().id;
  const event = db
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
  const deliveryId = createDelivery(event, channel, db)!;
  return { channel, event, deliveryId };
}

describe("claimPendingDelivery", () => {
  it("claims a pending delivery: status → sending, attempts +1, claimedAt set", () => {
    const db = createTestDb();
    const { deliveryId } = seed(db);
    const now = new Date("2026-08-14T12:00:00.000Z");

    expect(claimPendingDelivery(deliveryId, db, now)).toBe(true);
    const d = getDelivery(deliveryId, db)!;
    expect(d.status).toBe("sending");
    expect(d.attempts).toBe(1);
    expect(d.claimedAt?.toISOString()).toBe(now.toISOString());
  });

  it("rejects a second concurrent claim (single-winner CAS)", () => {
    const db = createTestDb();
    const { deliveryId } = seed(db);

    expect(claimPendingDelivery(deliveryId, db)).toBe(true);
    expect(claimPendingDelivery(deliveryId, db)).toBe(false);
    expect(getDelivery(deliveryId, db)!.attempts).toBe(1);
  });

  it("rejects claiming a sent delivery (no double send)", () => {
    const db = createTestDb();
    const { deliveryId } = seed(db);
    claimPendingDelivery(deliveryId, db);
    markDeliverySent(deliveryId, db);
    expect(claimPendingDelivery(deliveryId, db)).toBe(false);
  });

  it("rejects claiming a failed delivery directly", () => {
    const db = createTestDb();
    const { deliveryId } = seed(db);
    claimPendingDelivery(deliveryId, db);
    markDeliveryFailed(deliveryId, "boom", db);
    expect(claimPendingDelivery(deliveryId, db)).toBe(false);
  });
});

describe("markDeliverySent", () => {
  it("marks a sending delivery as sent with deliveredAt", () => {
    const db = createTestDb();
    const { deliveryId } = seed(db);
    claimPendingDelivery(deliveryId, db);
    const now = new Date("2026-08-14T12:05:00.000Z");

    expect(markDeliverySent(deliveryId, db, now)).toBe(true);
    const d = getDelivery(deliveryId, db)!;
    expect(d.status).toBe("sent");
    expect(d.deliveredAt?.toISOString()).toBe(now.toISOString());
  });

  it("rejects marking a pending delivery as sent (illegal transition)", () => {
    const db = createTestDb();
    const { deliveryId } = seed(db);
    expect(markDeliverySent(deliveryId, db)).toBe(false);
    expect(getDelivery(deliveryId, db)!.status).toBe("pending");
  });

  it("is idempotent for an already-sent delivery", () => {
    const db = createTestDb();
    const { deliveryId } = seed(db);
    claimPendingDelivery(deliveryId, db);
    markDeliverySent(deliveryId, db);
    expect(markDeliverySent(deliveryId, db)).toBe(false); // no-op, stays sent
    expect(getDelivery(deliveryId, db)!.status).toBe("sent");
  });
});

describe("markDeliveryFailed", () => {
  it("marks a sending delivery as failed with the error", () => {
    const db = createTestDb();
    const { deliveryId } = seed(db);
    claimPendingDelivery(deliveryId, db);

    expect(markDeliveryFailed(deliveryId, "timeout", db)).toBe(true);
    const d = getDelivery(deliveryId, db)!;
    expect(d.status).toBe("failed");
    expect(d.error).toBe("timeout");
  });

  it("rejects failing a pending delivery (must claim first)", () => {
    const db = createTestDb();
    const { deliveryId } = seed(db);
    expect(markDeliveryFailed(deliveryId, "nope", db)).toBe(false);
    expect(getDelivery(deliveryId, db)!.status).toBe("pending");
  });

  it("rejects failing a sent delivery (terminal state)", () => {
    const db = createTestDb();
    const { deliveryId } = seed(db);
    claimPendingDelivery(deliveryId, db);
    markDeliverySent(deliveryId, db);
    expect(markDeliveryFailed(deliveryId, "late error", db)).toBe(false);
    expect(getDelivery(deliveryId, db)!.status).toBe("sent");
  });
});

describe("retryDelivery", () => {
  it("retries a failed delivery back to pending (error kept)", () => {
    const db = createTestDb();
    const { deliveryId } = seed(db);
    claimPendingDelivery(deliveryId, db);
    markDeliveryFailed(deliveryId, "timeout", db);

    expect(retryDelivery(deliveryId, db)).toBe(true);
    const d = getDelivery(deliveryId, db)!;
    expect(d.status).toBe("pending");
    expect(d.error).toBe("timeout");
  });

  it("rejects retrying a pending or sent delivery", () => {
    const db = createTestDb();
    const { deliveryId } = seed(db);
    expect(retryDelivery(deliveryId, db)).toBe(false); // pending

    claimPendingDelivery(deliveryId, db);
    markDeliverySent(deliveryId, db);
    expect(retryDelivery(deliveryId, db)).toBe(false); // sent
  });

  it("increments attempts across retries", () => {
    const db = createTestDb();
    const { deliveryId } = seed(db);
    claimPendingDelivery(deliveryId, db);
    markDeliveryFailed(deliveryId, "t1", db);
    retryDelivery(deliveryId, db);
    claimPendingDelivery(deliveryId, db);
    expect(getDelivery(deliveryId, db)!.attempts).toBe(2);
  });
});

describe("recoverStaleSending", () => {
  it("recovers stale sending deliveries back to pending", () => {
    const db = createTestDb();
    const { deliveryId } = seed(db);
    // Claim with an old timestamp.
    claimPendingDelivery(deliveryId, db, new Date("2026-08-14T10:00:00.000Z"));

    const recovered = recoverStaleSending(db, 60_000, new Date("2026-08-14T12:00:00.000Z"));
    expect(recovered).toBe(1);
    expect(getDelivery(deliveryId, db)!.status).toBe("pending");
  });

  it("does not recover fresh sending deliveries", () => {
    const db = createTestDb();
    const { deliveryId } = seed(db);
    claimPendingDelivery(deliveryId, db, new Date("2026-08-14T11:59:30.000Z"));

    const recovered = recoverStaleSending(db, 60_000, new Date("2026-08-14T12:00:00.000Z"));
    expect(recovered).toBe(0);
    expect(getDelivery(deliveryId, db)!.status).toBe("sending");
  });

  it("leaves non-sending deliveries untouched", () => {
    const db = createTestDb();
    const { deliveryId } = seed(db);
    // pending (never claimed) is not stale-recovered.
    expect(recoverStaleSending(db, 0, new Date("2026-08-14T12:00:00.000Z"))).toBe(0);
    expect(getDelivery(deliveryId, db)!.status).toBe("pending");
  });
});

describe("full state machine", () => {
  it("pending → sending → failed → pending → sending → sent", () => {
    const db = createTestDb();
    const { deliveryId } = seed(db);

    claimPendingDelivery(deliveryId, db); // attempts 1
    markDeliveryFailed(deliveryId, "first attempt failed", db);
    retryDelivery(deliveryId, db);
    claimPendingDelivery(deliveryId, db); // attempts 2
    markDeliverySent(deliveryId, db);

    const d = getDelivery(deliveryId, db)!;
    expect(d.status).toBe("sent");
    expect(d.attempts).toBe(2);
    expect(d.error).toBe("first attempt failed");
    expect(d.deliveredAt).not.toBeNull();
  });
});
