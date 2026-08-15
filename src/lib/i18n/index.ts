/**
 * Server-side i18n API (V0.7.x — Phase 2).
 *
 * This module is SERVER-ONLY: it reads cookies from the request context.
 * Client Components must import dictionaries (en.ts / zh-CN.ts) or
 * config.ts directly — never this file. `import "server-only"` enforces
 * the boundary at build time: pulling this into a Client Component fails
 * the build.
 */
import "server-only";

import { cookies } from "next/headers";

import { COOKIE_NAME, DEFAULT_LOCALE, interpolate, isLocale, type Locale } from "./config";
import { en, type Dictionary } from "./en";
import { zhCN } from "./zh-CN";

const dictionaries: Record<Locale, Dictionary> = {
  en,
  "zh-CN": zhCN,
};

/**
 * Resolve the current locale from the `domain-monitor-locale` cookie.
 *
 * - no cookie            → DEFAULT_LOCALE ("en")
 * - invalid cookie value → DEFAULT_LOCALE ("en")
 * - valid locale         → that locale
 */
export async function getLocale(): Promise<Locale> {
  const store = await cookies();
  const value = store.get(COOKIE_NAME)?.value;
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

/** Look up the dictionary for a locale (synchronous, server-side). */
export function getDictionary(locale: Locale): Dictionary {
  return dictionaries[locale];
}

/** Alias for callers that want the resolved dictionary in one step. */
export async function getLocaleDictionary(): Promise<Dictionary> {
  return getDictionary(await getLocale());
}

/**
 * Lightweight typed-path lookup + interpolation.
 *
 *   t(dict, "domains.expires", { date: "Aug 11, 2026" })
 *     → "Expires: Aug 11, 2026"
 *
 * Unknown paths fall back to the path itself (fail-safe).
 */
export function t(
  dictionary: Dictionary,
  path: string,
  params?: Record<string, string | number>,
): string {
  const value = path
    .split(".")
    .reduce<unknown>(
      (acc, key) =>
        acc && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined,
      dictionary,
    );
  if (typeof value !== "string") {
    return path;
  }
  return interpolate(value, params);
}
