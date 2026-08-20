/**
 * Notification message timezone (Phase 11J — v0.8.7).
 *
 * Channel-level timezone for the timestamp line in notification messages
 * (Telegram first; webhook/email adopt later). Defaults to "UTC" so
 * existing channels render exactly as before. Node's built-in
 * Intl.DateTimeFormat (full-icu) handles IANA names and DST — no extra
 * dependency, no server-side TZ env changes.
 *
 * Scope: only the RENDERED message timestamp is converted. Internal
 * storage (event.occurredAt), the worker, dedup/CAS and the DB all stay
 * UTC — never touch them here.
 */

export const DEFAULT_NOTIFICATION_TIMEZONE = "UTC";

/** IANA timezone names offered in the UI datalist. */
export const COMMON_NOTIFICATION_TIMEZONES: readonly string[] = [
  "UTC",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Asia/Singapore",
  "Asia/Hong_Kong",
  "Asia/Taipei",
  "Asia/Seoul",
  "Asia/Kolkata",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "America/New_York",
  "America/Los_Angeles",
  "America/Chicago",
  "America/Sao_Paulo",
  "Australia/Sydney",
];

/**
 * Validate an IANA timezone name by asking Intl to build a formatter.
 * Returns false for empty/non-string/invalid names; never throws.
 */
export function isValidTimezone(value: unknown): value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * Render a timestamp in the given IANA timezone as
 * `YYYY-MM-DD HH:mm:ss (Timezone)` — language-independent numeric
 * format, with the canonical IANA name attached so DST ambiguity is
 * impossible. Falls back to the raw ISO string if the timezone is
 * invalid (should never happen after config validation).
 */
export function formatNotificationTime(date: Date, timezone: string): string {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(date);
  } catch {
    return date.toISOString();
  }
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  // en-GB 24h hour12:false can yield "24" at midnight in some engines.
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${get("year")}-${get("month")}-${get("day")} ${hour}:${get("minute")}:${get("second")} (${timezone})`;
}
