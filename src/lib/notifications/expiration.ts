/**
 * Expiration reminder evaluation (Phase 11A-7/8).
 *
 * The delivery worker evaluates reminders at the start of every tick:
 * for each domain with an expiration date and at least one reminder, when
 * the target day (`expiration − days_before`, calendar math on UTC dates)
 * has arrived, ONE `expiration_reminder` event is inserted. Idempotency is
 * guaranteed by the events table's UNIQUE index on `dedupKey`
 * (`expiration:{domainId}:{expirationDate}:{daysBefore}`): the same
 * reminder for the same expiration date is only ever reported once, no
 * matter how many ticks run. Changing the expiration date changes the key,
 * so an updated expiry naturally starts a fresh reminder cycle.
 *
 * The inserted event flows through the existing V0.6 pipeline
 * (event → rule match → delivery → sender); nothing in the pipeline was
 * rewritten. Notification rule matching, delivery and sending are reused
 * unchanged; `source`/`eventType` unions were extended with "expiration" /
 * "expiration_reminder" only.
 *
 * No real sends happen here — this module only records events. Sending is
 * the worker's delivery loop.
 */

import { db } from "@/db";
import { domains, type Domain } from "@/db/schema";
import { isNotNull } from "drizzle-orm";
import { getAllExpirationReminders } from "@/lib/domains/repository";
import type { NotificationDb } from "./repository";
// Phase 11D: insert the reminder event AND generate its deliveries in one
// call, so a reminder recorded by the worker actually produces a pending
// delivery (previously only the event row was inserted — the event existed
// but nothing ever delivered it).
import { insertEventsAndGenerateDeliveries } from "./service";
import { expirationReminderEvent } from "./events";

/**
 * Parse an ISO date string (date-only "YYYY-MM-DD" or full timestamp) into
 * a UTC calendar date [y, m, d] tuple. Returns null when unparseable.
 */
export function parseExpirationDate(
  value: string,
): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  // Round-trip to reject impossible dates.
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

/** The target reminder calendar date: expiration − daysBefore (UTC days). */
export function reminderTargetDate(
  expirationDate: string,
  daysBefore: number,
): { year: number; month: number; day: number } | null {
  const parsed = parseExpirationDate(expirationDate);
  if (!parsed) {
    return null;
  }
  const ms = Date.UTC(parsed.year, parsed.month - 1, parsed.day) - daysBefore * 86_400_000;
  const date = new Date(ms);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

/** Today's UTC calendar date as [y, m, d]. */
export function utcToday(now: Date): { year: number; month: number; day: number } {
  return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1, day: now.getUTCDate() };
}

/** Compare two calendar dates: -1 (a < b), 0 (a === b), 1 (a > b). */
export function compareCalendarDates(
  a: { year: number; month: number; day: number },
  b: { year: number; month: number; day: number },
): number {
  const aValue = a.year * 10_000 + a.month * 100 + a.day;
  const bValue = b.year * 10_000 + b.month * 100 + b.day;
  return aValue < bValue ? -1 : aValue > bValue ? 1 : 0;
}

/**
 * Evaluate all expiration reminders against the given clock.
 *
 * Returns the number of NEW events inserted (events whose dedup key did
 * not already exist). Repeated evaluation with the same clock inserts 0.
 */
export function evaluateExpirationReminders(
  now: Date = new Date(),
  target: NotificationDb = db,
): number {
  const reminderRows = getAllExpirationReminders(target);
  if (reminderRows.length === 0) {
    return 0;
  }

  const domainRows = target.select().from(domains).where(isNotNull(domains.expirationDate)).all();
  const domainById = new Map<number, Domain>(domainRows.map((domain) => [domain.id, domain]));

  const today = utcToday(now);
  const events: ReturnType<typeof expirationReminderEvent>[] = [];

  for (const reminder of reminderRows) {
    const domain = domainById.get(reminder.domainId);
    if (!domain || !domain.expirationDate) {
      continue;
    }
    const targetDate = reminderTargetDate(domain.expirationDate, reminder.daysBefore);
    if (!targetDate) {
      continue;
    }
    // Fired as soon as the target day has arrived; the dedup key prevents
    // repeats, and a late tick still catches a reminder that was due
    // earlier (never silently dropped).
    if (compareCalendarDates(targetDate, today) <= 0) {
      events.push(
        expirationReminderEvent({
          domainId: domain.id,
          expirationDate: domain.expirationDate,
          daysBefore: reminder.daysBefore,
          occurredAt: now,
        }),
      );
    }
  }

  if (events.length === 0) {
    return 0;
  }

  // Phase 11D: insert + generate deliveries atomically (new events only —
  // dedup-key hits return null ids and never re-generate deliveries).
  const ids = insertEventsAndGenerateDeliveries(target, events);
  return ids.filter((id) => id !== null).length;
}
