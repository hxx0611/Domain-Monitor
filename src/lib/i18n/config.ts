/**
 * i18n configuration (V0.7.x — Phase 2).
 *
 * Pure configuration + a tiny template helper. This module is intentionally
 * dependency-free: no server-only, no cookies, no React — it must be safe to
 * import from Client Components.
 */

/** Supported locales. Order matters: the first entry is the default. */
export const LOCALES = ["en", "zh-CN"] as const;

/** Locale used when no cookie is present or the cookie value is invalid. */
export const DEFAULT_LOCALE: Locale = "en";

/** Cookie name for the persisted language choice. */
export const COOKIE_NAME = "domain-monitor-locale";

/** Union of supported locales: "en" | "zh-CN". */
export type Locale = (typeof LOCALES)[number];

/**
 * Narrow a raw cookie value to a supported locale.
 *
 *   isLocale("en")     → true
 *   isLocale("zh-CN")  → true
 *   isLocale("EN")     → false  (case-sensitive)
 *   isLocale("en-US")  → false  (no region variants)
 *   isLocale("zh")     → false  (no bare language codes)
 *   isLocale(undefined)→ false
 */
export function isLocale(value: string | undefined): value is Locale {
  return value === "en" || value === "zh-CN";
}

/**
 * Lightweight template interpolation: replaces `{key}` placeholders with
 * params values. Unknown keys are left as-is (fail-safe). No ICU, no
 * plural rules — count handling stays in the caller where needed.
 *
 *   interpolate("Expires: {date}", { date: "Aug 11, 2026" })
 *     → "Expires: Aug 11, 2026"
 */
export function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = params[key];
    return value === undefined || value === null ? match : String(value);
  });
}
