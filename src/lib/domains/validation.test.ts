/**
 * Manual expiration validation (Phase 11A-5).
 */
import { describe, expect, it } from "vitest";
import {
  isValidIsoDate,
  normalizeOptionalIsoDate,
  normalizeReminderDays,
  normalizeReminderDaysList,
  validateManualDates,
} from "./validation";

describe("isValidIsoDate", () => {
  it("accepts real calendar dates", () => {
    expect(isValidIsoDate("2026-08-18")).toBe(true);
    expect(isValidIsoDate("2028-02-29")).toBe(true); // leap year
    expect(isValidIsoDate("2031-03-26")).toBe(true);
  });

  it("rejects impossible calendar dates", () => {
    expect(isValidIsoDate("2026-02-31")).toBe(false);
    expect(isValidIsoDate("2026-13-01")).toBe(false);
    expect(isValidIsoDate("2026-00-10")).toBe(false);
    expect(isValidIsoDate("2026-04-31")).toBe(false);
    expect(isValidIsoDate("2027-02-29")).toBe(false); // not a leap year
  });

  it("rejects malformed strings", () => {
    expect(isValidIsoDate("")).toBe(false);
    expect(isValidIsoDate("2026-8-18")).toBe(false);
    expect(isValidIsoDate("2026/08/18")).toBe(false);
    expect(isValidIsoDate("Aug 18 2026")).toBe(false);
    expect(isValidIsoDate("2026-08-18T00:00:00Z")).toBe(false);
  });
});

describe("normalizeOptionalIsoDate", () => {
  it("maps empty/undefined to null", () => {
    expect(normalizeOptionalIsoDate(undefined)).toBeNull();
    expect(normalizeOptionalIsoDate(null)).toBeNull();
    expect(normalizeOptionalIsoDate("")).toBeNull();
    expect(normalizeOptionalIsoDate("   ")).toBeNull();
  });

  it("trims and returns valid dates", () => {
    expect(normalizeOptionalIsoDate(" 2031-03-26 ")).toBe("2031-03-26");
  });

  it("rejects invalid dates with the error sentinel", () => {
    expect(normalizeOptionalIsoDate("2026-02-31")).toBe("invalid_date");
    expect(normalizeOptionalIsoDate("hello")).toBe("invalid_date");
  });
});

describe("validateManualDates", () => {
  it("accepts only expiration, only registration, or neither", () => {
    expect(validateManualDates(undefined, "2031-03-26")).toEqual({
      ok: true,
      registrationDate: null,
      expirationDate: "2031-03-26",
    });
    expect(validateManualDates("2024-05-01", undefined)).toEqual({
      ok: true,
      registrationDate: "2024-05-01",
      expirationDate: null,
    });
    expect(validateManualDates(undefined, undefined)).toEqual({
      ok: true,
      registrationDate: null,
      expirationDate: null,
    });
  });

  it("accepts expiration >= registration", () => {
    expect(validateManualDates("2024-05-01", "2031-03-26")).toEqual({
      ok: true,
      registrationDate: "2024-05-01",
      expirationDate: "2031-03-26",
    });
    expect(validateManualDates("2031-03-26", "2031-03-26")).toEqual({
      ok: true,
      registrationDate: "2031-03-26",
      expirationDate: "2031-03-26",
    });
  });

  it("rejects expiration < registration with invalid_date_range", () => {
    expect(validateManualDates("2031-03-26", "2024-05-01")).toEqual({
      ok: false,
      error: "invalid_date_range",
    });
  });

  it("rejects malformed dates with invalid_date", () => {
    expect(validateManualDates("2026-02-31", "2031-03-26")).toEqual({
      ok: false,
      error: "invalid_date",
    });
    expect(validateManualDates("2024-05-01", "not-a-date")).toEqual({
      ok: false,
      error: "invalid_date",
    });
  });
});

describe("normalizeReminderDays", () => {
  it("accepts integers in [1, 3650]", () => {
    expect(normalizeReminderDays("1")).toBe(1);
    expect(normalizeReminderDays("30")).toBe(30);
    expect(normalizeReminderDays("3650")).toBe(3650);
    expect(normalizeReminderDays(" 7 ")).toBe(7);
  });

  it("rejects non-integers, zero, negatives and out-of-range values", () => {
    expect(normalizeReminderDays("0")).toBe("invalid_reminder");
    expect(normalizeReminderDays("-5")).toBe("invalid_reminder");
    expect(normalizeReminderDays("3651")).toBe("invalid_reminder");
    expect(normalizeReminderDays("1.5")).toBe("invalid_reminder");
    expect(normalizeReminderDays("abc")).toBe("invalid_reminder");
    expect(normalizeReminderDays("")).toBe("invalid_reminder");
    expect(normalizeReminderDays(undefined)).toBe("invalid_reminder");
  });

  // Number input (the client form sends numbers from checkbox/custom state).
  it("accepts number input", () => {
    expect(normalizeReminderDays(1)).toBe(1);
    expect(normalizeReminderDays(30)).toBe(30);
    expect(normalizeReminderDays(3650)).toBe(3650);
  });

  it("rejects invalid numbers", () => {
    expect(normalizeReminderDays(0)).toBe("invalid_reminder");
    expect(normalizeReminderDays(-5)).toBe("invalid_reminder");
    expect(normalizeReminderDays(3651)).toBe("invalid_reminder");
    expect(normalizeReminderDays(30.5)).toBe("invalid_reminder");
  });
});

describe("normalizeReminderDaysList", () => {
  it("normalizes, dedupes and sorts descending", () => {
    expect(normalizeReminderDaysList(["30", "7", "30", "1", "90"])).toEqual({
      ok: true,
      days: [90, 30, 7, 1],
    });
  });

  it("accepts an empty list", () => {
    expect(normalizeReminderDaysList([])).toEqual({ ok: true, days: [] });
  });

  it("rejects any invalid entry", () => {
    expect(normalizeReminderDaysList(["30", "0"])).toEqual({
      ok: false,
      error: "invalid_reminder",
    });
    expect(normalizeReminderDaysList(["x"])).toEqual({
      ok: false,
      error: "invalid_reminder",
    });
  });
});
