/**
 * Phase 11J — notification message timezone unit tests.
 *
 * Covers IANA validation, the renderer's numeric `YYYY-MM-DD HH:mm:ss
 * (Timezone)` format, DST behavior and the raw-ISO fallback for invalid
 * names. All dates are constructed in UTC to keep expectations
 * deterministic regardless of the runner's local timezone.
 */
import { describe, expect, it } from "vitest";
import {
  COMMON_NOTIFICATION_TIMEZONES,
  DEFAULT_NOTIFICATION_TIMEZONE,
  formatNotificationTime,
  isValidTimezone,
} from "./timezone";

describe("isValidTimezone", () => {
  it("accepts UTC and common IANA names", () => {
    expect(isValidTimezone("UTC")).toBe(true);
    expect(isValidTimezone("Asia/Shanghai")).toBe(true);
    expect(isValidTimezone("America/New_York")).toBe(true);
  });

  it("rejects empty, non-string and unknown names", () => {
    expect(isValidTimezone("")).toBe(false);
    expect(isValidTimezone("   ")).toBe(false);
    expect(isValidTimezone(undefined)).toBe(false);
    expect(isValidTimezone(null)).toBe(false);
    expect(isValidTimezone("Not/AZone")).toBe(false);
    expect(isValidTimezone("Asia/Shanghai/Extra")).toBe(false);
  });

  it("exposes the default and a datalist of common timezones", () => {
    expect(DEFAULT_NOTIFICATION_TIMEZONE).toBe("UTC");
    expect(COMMON_NOTIFICATION_TIMEZONES).toContain("Asia/Shanghai");
    expect(COMMON_NOTIFICATION_TIMEZONES).toContain("UTC");
  });
});

describe("formatNotificationTime", () => {
  const noonUtc = new Date("2026-08-16T12:00:00.000Z");

  it("renders UTC as numeric YYYY-MM-DD HH:mm:ss (Timezone)", () => {
    expect(formatNotificationTime(noonUtc, "UTC")).toBe("2026-08-16 12:00:00 (UTC)");
  });

  it("renders Asia/Shanghai with the +08:00 offset applied", () => {
    expect(formatNotificationTime(noonUtc, "Asia/Shanghai")).toBe(
      "2026-08-16 20:00:00 (Asia/Shanghai)",
    );
  });

  it("renders America/New_York with the UTC-04:00 (DST) offset applied", () => {
    // 2026-08-16 is EDT (UTC-04:00): 12:00Z → 08:00 local.
    expect(formatNotificationTime(noonUtc, "America/New_York")).toBe(
      "2026-08-16 08:00:00 (America/New_York)",
    );
  });

  it("falls back to the raw ISO string for an invalid timezone", () => {
    expect(formatNotificationTime(noonUtc, "Not/AZone")).toBe("2026-08-16T12:00:00.000Z");
  });
});
