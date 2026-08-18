/**
 * Domain hostname validation and normalization.
 *
 * Accepts a user-supplied domain input (possibly with scheme, path, query,
 * uppercase letters or surrounding whitespace) and normalizes it to a bare
 * hostname such as `example.com`.
 */

export type ValidationResult = { ok: true; hostname: string } | { ok: false; error: string };

const HOSTNAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * Normalize a user-supplied domain string to a canonical hostname.
 *
 * - Trims surrounding whitespace and lowercases the input.
 * - Strips `http://` / `https://` schemes, paths, query strings and ports.
 * - Requires at least two dot-separated labels (a bare TLD is not accepted).
 * - Rejects bare IP addresses (out of scope for a domain monitor).
 *
 * Returns `{ ok: true, hostname }` on success or `{ ok: false, error }`
 * with a human-readable message on failure.
 */
export function normalizeHostname(input: string): ValidationResult {
  const trimmed = input.trim().toLowerCase();

  if (trimmed.length === 0) {
    return { ok: false, error: "Please enter a valid domain name." };
  }

  // Reject strings that clearly contain whitespace (e.g. "exa mple.com").
  if (/\s/.test(trimmed)) {
    return { ok: false, error: "Please enter a valid domain name." };
  }

  let hostname: string;

  if (trimmed.includes("://")) {
    try {
      const url = new URL(trimmed);
      // `URL.hostname` excludes the port and any path/query fragments.
      hostname = url.hostname;
    } catch {
      return { ok: false, error: "Please enter a valid domain name." };
    }
  } else {
    // No scheme supplied — parse as `https://<input>` to reuse URL semantics
    // for host extraction (also strips ports and path fragments).
    try {
      hostname = new URL(`https://${trimmed}`).hostname;
    } catch {
      return { ok: false, error: "Please enter a valid domain name." };
    }
  }

  // Strip an optional trailing dot (fully-qualified domain name notation).
  hostname = hostname.replace(/\.$/, "");

  // Reject IPv4 addresses (e.g. "192.168.1.1") — out of scope.
  if (/^\d+(\.\d+){3}$/.test(hostname)) {
    return { ok: false, error: "IP addresses are not supported." };
  }

  if (!HOSTNAME_PATTERN.test(hostname)) {
    return { ok: false, error: "Please enter a valid domain name." };
  }

  return { ok: true, hostname };
}

// ---------------------------------------------------------------------------
// Manual expiration validation (Phase 11A-5)
// ---------------------------------------------------------------------------

export type ManualDateValidationResult =
  | { ok: true; registrationDate: string | null; expirationDate: string | null }
  | { ok: false; error: string };

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Validate a calendar date string of the form YYYY-MM-DD.
 *
 * The regex alone would accept impossible dates (e.g. 2026-02-31), so the
 * parsed values are round-tripped through `Date.UTC` to reject them.
 * Returns `true` when the string is a real calendar date.
 */
export function isValidIsoDate(value: string): boolean {
  const match = ISO_DATE_PATTERN.exec(value);
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/**
 * Normalize a user-supplied date field.
 *
 * Accepts an empty string → null (field not provided). Otherwise the value
 * must be a valid YYYY-MM-DD calendar date; anything else fails with
 * "invalid_date".
 */
export function normalizeOptionalIsoDate(
  raw: string | undefined | null,
): string | null | "invalid_date" {
  if (raw === undefined || raw === null || raw.trim() === "") {
    return null;
  }
  const trimmed = raw.trim();
  if (!isValidIsoDate(trimmed)) {
    return "invalid_date";
  }
  return trimmed;
}

/**
 * Validate the manual date pair:
 * - both fields, when present, must be valid YYYY-MM-DD dates;
 * - when both are present, `expiration` must be >= `registration`.
 *
 * Returns "invalid_date" | "invalid_date_range" on failure.
 */
export function validateManualDates(
  registrationRaw: string | undefined | null,
  expirationRaw: string | undefined | null,
): ManualDateValidationResult {
  const registrationDate = normalizeOptionalIsoDate(registrationRaw);
  if (registrationDate === "invalid_date") {
    return { ok: false, error: "invalid_date" };
  }
  const expirationDate = normalizeOptionalIsoDate(expirationRaw);
  if (expirationDate === "invalid_date") {
    return { ok: false, error: "invalid_date" };
  }
  if (registrationDate !== null && expirationDate !== null) {
    if (expirationDate < registrationDate) {
      return { ok: false, error: "invalid_date_range" };
    }
  }
  return { ok: true, registrationDate, expirationDate };
}

export type ReminderValidationResult = { ok: true; days: number[] } | { ok: false; error: string };

/** Allowed reminder range (days before expiration). */
export const REMINDER_MIN_DAYS = 1;
export const REMINDER_MAX_DAYS = 3650;

/**
 * Normalize a reminder-days input: positive integer in [1, 3650], supplied
 * either as a numeric string ("30") or as a number (30 — the client form
 * sends numbers from its checkbox/custom-day state). Anything else
 * (non-integer, <= 0, > 3650, boolean, object) fails with
 * "invalid_reminder".
 */
export function normalizeReminderDays(raw: unknown): number | "invalid_reminder" {
  const value = typeof raw === "string" ? raw.trim() : raw;
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < REMINDER_MIN_DAYS || value > REMINDER_MAX_DAYS) {
      return "invalid_reminder";
    }
    return value;
  }
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    return "invalid_reminder";
  }
  const days = Number(value);
  if (!Number.isInteger(days) || days < REMINDER_MIN_DAYS || days > REMINDER_MAX_DAYS) {
    return "invalid_reminder";
  }
  return days;
}

/**
 * Normalize a list of reminder days: every entry must be a valid integer in
 * [1, 3650]; duplicates are removed (30, 30 → [30]).
 */
export function normalizeReminderDaysList(raw: unknown[]): ReminderValidationResult {
  const seen = new Set<number>();
  const days: number[] = [];
  for (const entry of raw) {
    const normalized = normalizeReminderDays(entry);
    if (normalized === "invalid_reminder") {
      return { ok: false, error: "invalid_reminder" };
    }
    if (!seen.has(normalized)) {
      seen.add(normalized);
      days.push(normalized);
    }
  }
  days.sort((a, b) => b - a);
  return { ok: true, days };
}
