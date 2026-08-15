import type { Locale } from "@/lib/i18n/config";

const dateFormatters: Record<Locale, Intl.DateTimeFormat> = {
  en: new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }),
  "zh-CN": new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }),
};

/**
 * Format a date for display.
 *
 * Machine timestamps / DB storage / API payloads are never touched — this
 * only changes the display layer. The default locale is English, preserving
 * the existing output ("Aug 11, 2026") for all current callers.
 */
export function formatDate(date: Date, locale: Locale = "en"): string {
  return dateFormatters[locale].format(date);
}
