/**
 * Expiration reminder evaluation (Phase 11A-7/8).
 *
 * The worker evaluates reminders at tick start. Idempotency comes from the
 * events table UNIQUE dedupKey index — repeated evaluation with the same
 * clock inserts nothing new.
 */
import { describe, expect, it } from "vitest";
import { createSQLiteRepository } from "@/db/adapters/sqlite";
import { createTestDb } from "../../../test/helpers";
import { createDomain, setExpirationReminders, updateDomain } from "@/lib/domains/repository";
import { notificationEvents } from "@/db/schema";
import {
  compareCalendarDates,
  evaluateExpirationReminders,
  parseExpirationDate,
  reminderTargetDate,
  utcToday,
} from "./expiration";
import { runOnce } from "./worker";

function remindersOf(
  db: ReturnType<typeof createTestDb>,
): { source: string; eventType: string; dedupKey: string }[] {
  return db
    .select()
    .from(notificationEvents)
    .all()
    .map((event) => ({
      source: event.source,
      eventType: event.eventType,
      dedupKey: event.dedupKey,
    }));
}

describe("date helpers", () => {
  it("parseExpirationDate accepts date-only and full ISO strings", () => {
    expect(parseExpirationDate("2031-03-26")).toEqual({ year: 2031, month: 3, day: 26 });
    expect(parseExpirationDate("2031-03-26T04:00:00Z")).toEqual({ year: 2031, month: 3, day: 26 });
    expect(parseExpirationDate("garbage")).toBeNull();
  });

  it("reminderTargetDate subtracts calendar days (UTC)", () => {
    expect(reminderTargetDate("2031-03-26", 30)).toEqual({ year: 2031, month: 2, day: 24 });
    expect(reminderTargetDate("2031-03-01", 1)).toEqual({ year: 2031, month: 2, day: 28 });
    expect(reminderTargetDate("2026-03-01", 1)).toEqual({ year: 2026, month: 2, day: 28 });
    expect(reminderTargetDate("2031-03-26", 0)).toEqual({ year: 2031, month: 3, day: 26 });
  });

  it("compareCalendarDates orders correctly", () => {
    expect(
      compareCalendarDates({ year: 2031, month: 2, day: 24 }, { year: 2031, month: 2, day: 24 }),
    ).toBe(0);
    expect(
      compareCalendarDates({ year: 2031, month: 2, day: 23 }, { year: 2031, month: 2, day: 24 }),
    ).toBe(-1);
    expect(
      compareCalendarDates({ year: 2031, month: 2, day: 25 }, { year: 2031, month: 2, day: 24 }),
    ).toBe(1);
  });

  it("utcToday reads the UTC calendar day", () => {
    expect(utcToday(new Date("2031-02-24T12:00:00Z"))).toEqual({ year: 2031, month: 2, day: 24 });
  });
});

describe("evaluateExpirationReminders", () => {
  it("inserts one event per due reminder with the Phase 11A-8 dedup key", async () => {
    const db = createTestDb();
    const domain = createDomain(
      "opusai.eu.cc",
      { expirationSource: "manual", expirationDate: "2031-03-26" },
      db,
    )!;
    setExpirationReminders(domain.id, [30, 7, 1], db);

    // 2031-02-24: the 30-day reminder target day (03-26 minus 30).
    const inserted = await evaluateExpirationReminders(
      new Date("2031-02-24T08:00:00Z"),
      createSQLiteRepository(db),
    );
    expect(inserted).toBe(1);
    const events = remindersOf(db);
    expect(events).toHaveLength(1);
    expect(events[0].source).toBe("expiration");
    expect(events[0].eventType).toBe("expiration_reminder");
    expect(events[0].dedupKey).toBe("expiration:1:2031-03-26:30");
  });

  it("fires only once per reminder for the same expiration (dedup idempotency)", async () => {
    const db = createTestDb();
    const domain = createDomain(
      "opusai.eu.cc",
      { expirationSource: "manual", expirationDate: "2031-03-26" },
      db,
    )!;
    setExpirationReminders(domain.id, [30], db);

    expect(
      await evaluateExpirationReminders(
        new Date("2031-02-24T08:00:00Z"),
        createSQLiteRepository(db),
      ),
    ).toBe(1);
    // Second tick, same clock: nothing new (the dedup key already exists).
    expect(
      await evaluateExpirationReminders(
        new Date("2031-02-24T08:00:00Z"),
        createSQLiteRepository(db),
      ),
    ).toBe(0);
    // Third tick, next day: still nothing new for the same key.
    expect(
      await evaluateExpirationReminders(
        new Date("2031-02-25T08:00:00Z"),
        createSQLiteRepository(db),
      ),
    ).toBe(0);
    expect(remindersOf(db)).toHaveLength(1);
  });

  it("a late tick still records a due reminder (never silently dropped)", async () => {
    const db = createTestDb();
    const domain = createDomain(
      "opusai.eu.cc",
      { expirationSource: "manual", expirationDate: "2031-03-26" },
      db,
    )!;
    setExpirationReminders(domain.id, [30], db);

    // The worker did not run on 02-24; it runs on 02-25 — still records.
    expect(
      await evaluateExpirationReminders(
        new Date("2031-02-25T08:00:00Z"),
        createSQLiteRepository(db),
      ),
    ).toBe(1);
  });

  it("does not fire before the target day", async () => {
    const db = createTestDb();
    const domain = createDomain(
      "opusai.eu.cc",
      { expirationSource: "manual", expirationDate: "2031-03-26" },
      db,
    )!;
    setExpirationReminders(domain.id, [30], db);

    expect(
      await evaluateExpirationReminders(
        new Date("2031-02-23T23:59:00Z"),
        createSQLiteRepository(db),
      ),
    ).toBe(0);
    expect(remindersOf(db)).toEqual([]);
  });

  it("a changed expiration date starts a fresh reminder cycle (new dedup key)", async () => {
    const db = createTestDb();
    const domain = createDomain(
      "opusai.eu.cc",
      { expirationSource: "manual", expirationDate: "2031-03-26" },
      db,
    )!;
    setExpirationReminders(domain.id, [30], db);
    expect(
      await evaluateExpirationReminders(
        new Date("2031-02-24T08:00:00Z"),
        createSQLiteRepository(db),
      ),
    ).toBe(1);

    // Operator moves the expiry to 2031-04-26 → the 30-day target becomes
    // 03-27, which has arrived by then → a new event for the new date.
    updateDomain(domain.id, { expirationSource: "manual", expirationDate: "2031-04-26" }, db);
    expect(
      await evaluateExpirationReminders(
        new Date("2031-03-27T08:00:00Z"),
        createSQLiteRepository(db),
      ),
    ).toBe(1);
    const keys = remindersOf(db).map((event) => event.dedupKey);
    expect(keys).toContain("expiration:1:2031-03-26:30");
    expect(keys).toContain("expiration:1:2031-04-26:30");
  });

  it("domains without expiration dates or reminders are skipped", async () => {
    const db = createTestDb();
    createDomain("chatgpt.com", undefined, db); // no expiration, rdap source
    expect(
      await evaluateExpirationReminders(
        new Date("2031-02-24T08:00:00Z"),
        createSQLiteRepository(db),
      ),
    ).toBe(0);
  });
});

describe("worker integration", () => {
  it("runOnce evaluates reminders at tick start (expirationEvents in summary)", async () => {
    const db = createTestDb();
    const domain = createDomain(
      "opusai.eu.cc",
      { expirationSource: "manual", expirationDate: "2031-03-26" },
      db,
    )!;
    setExpirationReminders(domain.id, [30], db);

    const result = await runOnce({
      repo: createSQLiteRepository(db),
      now: new Date("2031-02-24T08:00:00Z"),
      senders: () => {
        throw new Error("no deliveries expected");
      },
    });

    expect(result.expirationEvents).toBe(1);
    expect(remindersOf(db)).toHaveLength(1);

    // A second tick records nothing new.
    const again = await runOnce({
      repo: createSQLiteRepository(db),
      now: new Date("2031-02-24T09:00:00Z"),
      senders: () => {
        throw new Error("no deliveries expected");
      },
    });
    expect(again.expirationEvents).toBe(0);
    expect(remindersOf(db)).toHaveLength(1);
  });
});
