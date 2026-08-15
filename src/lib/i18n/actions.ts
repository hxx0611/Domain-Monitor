/**
 * Locale persistence server action (V0.7.x — Phase 3).
 *
 * Writes the language choice to the `domain-monitor-locale` cookie.
 * Strict validation: invalid values are rejected and never written.
 * Touches no database, no notifications, no secrets — cookie only.
 */
"use server";

import { cookies } from "next/headers";

import { COOKIE_NAME, isLocale } from "./config";

export type SetLocaleActionResult = { ok: true; locale: "en" | "zh-CN" } | { ok: false };

/**
 * Persist the language choice in a cookie.
 *
 * - valid locale ("en" | "zh-CN") → cookie written, { ok: true }
 * - invalid locale               → nothing written, { ok: false }
 */
export async function setLocaleAction(locale: string): Promise<SetLocaleActionResult> {
  if (!isLocale(locale)) {
    return { ok: false };
  }

  const store = await cookies();
  store.set(COOKIE_NAME, locale, {
    path: "/",
    sameSite: "lax",
  });

  return { ok: true, locale };
}
