"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { setLocaleAction } from "@/lib/i18n/actions";
import type { Locale } from "@/lib/i18n/config";

const OPTIONS: Array<{ locale: Locale; label: string }> = [
  { locale: "en", label: "English" },
  { locale: "zh-CN", label: "简体中文" },
];

/**
 * Language switcher (the single `"use client"` UI element for i18n).
 *
 * Click → setLocaleAction() (writes the cookie server-side) →
 * router.refresh() → Server Components re-render with the new locale.
 * The current URL never changes — no /en or /zh-CN prefixes.
 */
export function LanguageSwitcher({ locale }: { locale: Locale }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function switchTo(next: Locale) {
    if (next === locale || isPending) {
      return;
    }
    startTransition(async () => {
      await setLocaleAction(next);
      router.refresh();
    });
  }

  return (
    <div
      className="flex shrink-0 items-center gap-1 rounded-md border border-gray-200 bg-white px-1 py-0.5 text-xs"
      role="group"
      aria-label="Language"
    >
      {OPTIONS.map((option, index) => (
        <span key={option.locale} className="flex items-center gap-1">
          {index > 0 ? <span className="text-gray-300">|</span> : null}
          <button
            type="button"
            onClick={() => switchTo(option.locale)}
            aria-pressed={locale === option.locale}
            disabled={isPending}
            className={`rounded px-1.5 py-0.5 font-medium transition-colors ${
              locale === option.locale
                ? "bg-blue-600 text-white"
                : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
            } disabled:opacity-60`}
          >
            {option.label}
          </button>
        </span>
      ))}
    </div>
  );
}
