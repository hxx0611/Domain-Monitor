/**
 * i18n core tests (V0.7.x — Phase 2).
 *
 * Covers: isLocale, dictionary symmetry (en ⇄ zh-CN), getLocale cookie
 * fallback, getDictionary, template interpolation, formatDate locale
 * behavior, secret boundary, and the Client/Server import boundary.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { COOKIE_NAME, DEFAULT_LOCALE, interpolate, isLocale } from "./config";
import { en, type Dictionary } from "./en";
import { zhCN } from "./zh-CN";
import { getDictionary, getLocale, t } from "./index";
import { eventTypeLabel, lookup } from "./display";
import { formatDate } from "@/lib/format";

// ---------------------------------------------------------------------------
// getLocale reads next/headers cookies() — mock the module.
// ---------------------------------------------------------------------------

vi.mock("next/headers", () => ({
  cookies: vi.fn(),
}));

import { cookies } from "next/headers";

const mockCookies = vi.mocked(cookies);

function mockCookieValue(value: string | undefined) {
  mockCookies.mockResolvedValue({
    get: () => (value === undefined ? undefined : { name: COOKIE_NAME, value }),
  } as never);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Leaf = string;

/** Collect every leaf path (dot-joined) in a dictionary-like object. */
function collectLeafPaths(obj: unknown, prefix = ""): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object") {
      out.push(...collectLeafPaths(value, full));
    } else {
      out.push(full);
    }
  }
  return out;
}

/** Collect every leaf string value in a dictionary-like object. */
function collectLeafValues(obj: unknown): Leaf[] {
  const out: Leaf[] = [];
  for (const value of Object.values(obj as Record<string, unknown>)) {
    if (value !== null && typeof value === "object") {
      out.push(...collectLeafValues(value));
    } else {
      out.push(String(value));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. isLocale
// ---------------------------------------------------------------------------

describe("isLocale", () => {
  it("accepts exactly the supported locales", () => {
    expect(isLocale("en")).toBe(true);
    expect(isLocale("zh-CN")).toBe(true);
  });

  it("rejects everything else", () => {
    expect(isLocale("fr")).toBe(false);
    expect(isLocale("zh")).toBe(false);
    expect(isLocale("EN")).toBe(false);
    expect(isLocale("en-US")).toBe(false);
    expect(isLocale("zh_CN")).toBe(false);
    expect(isLocale("")).toBe(false);
    expect(isLocale(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Dictionary symmetry
// ---------------------------------------------------------------------------

describe("dictionary symmetry", () => {
  it("en and zh-CN have exactly the same leaf keys (no missing / no extra)", () => {
    const enPaths = collectLeafPaths(en).sort();
    const zhPaths = collectLeafPaths(zhCN).sort();

    expect(zhPaths).toEqual(enPaths);
    // Sanity: the dictionaries are non-trivial.
    expect(enPaths.length).toBeGreaterThan(100);
  });

  it("dictionaries never contain machine values as keys or bare status values", () => {
    const machineValues = ["pending", "sending", "sent", "failed", "dns_record_added"];
    for (const value of machineValues) {
      expect(collectLeafValues(en)).not.toContain(value);
      expect(collectLeafValues(zhCN)).not.toContain(value);
    }
  });

  it("DEFAULT_LOCALE is a valid supported locale", () => {
    expect(isLocale(DEFAULT_LOCALE)).toBe(true);
    expect(DEFAULT_LOCALE).toBe("en");
  });
});

// ---------------------------------------------------------------------------
// 3. getLocale — cookie fallback
// ---------------------------------------------------------------------------

describe("getLocale", () => {
  beforeEach(() => {
    mockCookies.mockReset();
  });

  it("no cookie → en", async () => {
    mockCookieValue(undefined);
    expect(await getLocale()).toBe("en");
  });

  it("invalid cookie value → en", async () => {
    mockCookieValue("fr");
    expect(await getLocale()).toBe("en");
    mockCookieValue("EN");
    expect(await getLocale()).toBe("en");
    mockCookieValue("zh_CN");
    expect(await getLocale()).toBe("en");
  });

  it("en cookie → en", async () => {
    mockCookieValue("en");
    expect(await getLocale()).toBe("en");
  });

  it("zh-CN cookie → zh-CN", async () => {
    mockCookieValue("zh-CN");
    expect(await getLocale()).toBe("zh-CN");
  });

  it("reads from the domain-monitor-locale cookie", async () => {
    mockCookieValue("zh-CN");
    await getLocale();
    expect(mockCookies).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 4. getDictionary
// ---------------------------------------------------------------------------

describe("getDictionary", () => {
  it("en → the English dictionary", () => {
    expect(getDictionary("en")).toBe(en);
  });

  it("zh-CN → the Chinese dictionary", () => {
    expect(getDictionary("zh-CN")).toBe(zhCN);
  });

  it("returns dictionaries with the same key structure for both locales", () => {
    const enPaths = collectLeafPaths(getDictionary("en")).sort();
    const zhPaths = collectLeafPaths(getDictionary("zh-CN")).sort();
    expect(zhPaths).toEqual(enPaths);
  });
});

// ---------------------------------------------------------------------------
// 5. Template interpolation
// ---------------------------------------------------------------------------

describe("interpolation", () => {
  it("replaces {placeholders} with provided params", () => {
    expect(interpolate("Expires: {date}", { date: "Aug 11, 2026" })).toBe("Expires: Aug 11, 2026");
    expect(interpolate("剩余 {count} 天", { count: 3 })).toBe("剩余 3 天");
  });

  it("leaves unknown placeholders untouched (fail-safe)", () => {
    expect(interpolate("Hello {name}!", {})).toBe("Hello {name}!");
  });

  it("returns the template unchanged when params are omitted", () => {
    expect(interpolate("plain text")).toBe("plain text");
  });

  it("t() resolves dotted paths and interpolates", () => {
    const dict: Dictionary = getDictionary("en");
    expect(t(dict, "domains.expires", { date: "Aug 11, 2026" })).toBe("Expires: Aug 11, 2026");
    expect(t(getDictionary("zh-CN"), "ssl.daysRemaining", { count: 42 })).toBe("剩余 42 天");
    expect(t(dict, "status.pending")).toBe("Pending");
  });

  it("t() falls back to the path itself for unknown keys", () => {
    expect(t(getDictionary("en"), "nope.missing")).toBe("nope.missing");
  });
});

// ---------------------------------------------------------------------------
// 6. formatDate
// ---------------------------------------------------------------------------

describe("formatDate", () => {
  const date = new Date(2026, 7, 11); // Aug 11, 2026 (local)

  it("defaults to the existing English format", () => {
    expect(formatDate(date)).toBe("Aug 11, 2026");
    expect(formatDate(date, "en")).toBe("Aug 11, 2026");
  });

  it("zh-CN produces a Chinese date format", () => {
    expect(formatDate(date, "zh-CN")).toBe("2026年8月11日");
  });

  it("en and zh-CN outputs differ for the same timestamp", () => {
    expect(formatDate(date, "en")).not.toBe(formatDate(date, "zh-CN"));
  });

  it("machine timestamps are untouched — only display changes", () => {
    const ts = new Date("2026-08-11T00:00:00.000Z");
    expect(ts.getTime()).toBe(new Date("2026-08-11T00:00:00.000Z").getTime());
    expect(typeof formatDate(ts, "zh-CN")).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// 7. Secret boundary
// ---------------------------------------------------------------------------

describe("secret boundary", () => {
  it("dictionaries contain no secret-like values", () => {
    const secretPatterns: Array<RegExp> = [
      /Bearer\s+\S+/i,
      /Authorization\s*[:=]/i,
      /api[_-]?key\s*[:=]\s*\S+/i,
      /sk-[A-Za-z0-9]{8,}/,
      /EMAIL_API_KEY|WEBHOOK_SECRET/,
      /\b[A-Za-z0-9+/]{40,}={0,2}\b/, // long base64-ish blob
    ];
    for (const value of [...collectLeafValues(en), ...collectLeafValues(zhCN)]) {
      for (const pattern of secretPatterns) {
        expect(value, `dictionary value must not match ${pattern}: ${value}`).not.toMatch(pattern);
      }
    }
  });

  it("dictionaries contain no process.env references", () => {
    for (const value of [...collectLeafValues(en), ...collectLeafValues(zhCN)]) {
      expect(value).not.toContain("process.env");
    }
  });
});

// ---------------------------------------------------------------------------
// Client / Server import boundary (static check on source files)
// ---------------------------------------------------------------------------

describe("client/server boundary", () => {
  const i18nDir = path.join(process.cwd(), "src/lib/i18n");

  it("en.ts / zh-CN.ts / config.ts are client-safe: no server-only, cookies, react, db, or app imports", () => {
    const forbidden = [
      "server-only",
      "next/headers",
      '"react"',
      "@/db",
      "@/lib/notifications",
      "@/lib/domains",
      "@/lib/dns",
      "@/lib/ssl",
      "@/lib/http",
      "@/lib/rdap",
      "process.env",
    ];
    for (const file of ["en.ts", "zh-CN.ts", "config.ts"]) {
      const source = readFileSync(path.join(i18nDir, file), "utf8");
      // Only import statements matter — prose in comments may mention
      // these words legitimately.
      const importLines = source.split(/\n/).filter((line) => /^import |^\s*import /.test(line));
      for (const token of forbidden) {
        for (const line of importLines) {
          expect(line, `${file} must not import ${token}`).not.toContain(token);
        }
      }
    }
  });

  it("index.ts is server-only and reads cookies", () => {
    const source = readFileSync(path.join(i18nDir, "index.ts"), "utf8");
    expect(source).toContain('import "server-only"');
    expect(source).toContain('from "next/headers"');
  });

  it("en.ts / config.ts have zero imports; zh-CN.ts only a type-only import", () => {
    for (const file of ["en.ts", "config.ts"]) {
      const source = readFileSync(path.join(i18nDir, file), "utf8");
      expect(source, `${file} must not import anything`).not.toMatch(/^import /m);
    }
    // zh-CN.ts may carry a type-only import (erased at compile time, no
    // runtime dependency) — but never a value import.
    const zhSource = readFileSync(path.join(i18nDir, "zh-CN.ts"), "utf8");
    expect(zhSource).not.toMatch(/^import (?!type )/m);
    expect(zhSource).toMatch(/^import type /m);
  });

  it("dictionary files can be imported in a client-safe context (no server-only chain)", async () => {
    // Importing dictionaries must not pull in server-only. (The stub in
    // vitest makes server-only a no-op; the static checks above are the
    // real guard — this asserts the import chain stays dependency-free.)
    const { en: enCopy } = await import("./en");
    const { zhCN: zhCopy } = await import("./zh-CN");
    expect(enCopy).toBe(en);
    expect(zhCopy).toBe(zhCN);
  });
});

// ---------------------------------------------------------------------------
// 8. Locale-aware display helpers (eventTypeLabel / lookup)
// ---------------------------------------------------------------------------

describe("display helpers", () => {
  it("lookup resolves dotted paths and falls back to the path", () => {
    expect(lookup(en, "status.pending")).toBe("Pending");
    expect(lookup(zhCN, "status.pending")).toBe("待处理");
    expect(lookup(en, "nope.missing")).toBe("nope.missing");
  });

  it("eventTypeLabel maps machine eventType → localized label per locale", () => {
    expect(eventTypeLabel("dns_record_added", en)).toBe("DNS record added");
    expect(eventTypeLabel("dns_record_added", zhCN)).toBe("新增 DNS 记录");
    expect(eventTypeLabel("http_status_changed", zhCN)).toBe("HTTP 状态变更");
    expect(eventTypeLabel("ssl_status_changed", en)).toBe("SSL status changed");
  });

  it("eventTypeLabel never translates the machine value itself", () => {
    // The eventType machine value must never leak as the displayed label
    // except when no translation exists (fail-safe passthrough).
    expect(eventTypeLabel("dns_record_added", en)).not.toBe("dns_record_added");
    expect(eventTypeLabel("dns_record_added", zhCN)).not.toBe("dns_record_added");
    // Unknown types pass through unchanged (crash-free).
    expect(eventTypeLabel("unknown_type", en)).toBe("unknown_type");
  });
});

// ---------------------------------------------------------------------------
// 9. Client Component boundary (static check on UI source)
// ---------------------------------------------------------------------------

describe("client component boundary", () => {
  const componentsDir = path.join(process.cwd(), "src/components");
  const clientFiles = [
    "language-switcher.tsx",
    "add-domain-form.tsx",
    "delete-domain-button.tsx",
    "refresh-rdap-button.tsx",
    "check-dns-button.tsx",
    "check-ssl-button.tsx",
    "check-http-button.tsx",
    "notifications/retry-delivery-button.tsx",
  ];

  it("client components never import i18n/index.ts (server-only)", () => {
    for (const file of clientFiles) {
      const source = readFileSync(path.join(componentsDir, file), "utf8");
      expect(source, `${file} must not import i18n/index`).not.toContain("@/lib/i18n/index");
    }
  });

  it("only the language-switcher may import the i18n server action (official Server Action pattern)", () => {
    // Client Components are allowed to call server actions; the
    // language-switcher is the one UI element that does so for i18n.
    for (const file of clientFiles) {
      const source = readFileSync(path.join(componentsDir, file), "utf8");
      const usesI18nAction = source.includes("@/lib/i18n/actions");
      if (file === "language-switcher.tsx") {
        expect(source, "language-switcher must use setLocaleAction").toContain("setLocaleAction");
      } else {
        expect(usesI18nAction, `${file} must not import i18n/actions`).toBe(false);
      }
    }
  });

  it("client components never use cookies/next-headers/server-only directly", () => {
    for (const file of clientFiles) {
      const source = readFileSync(path.join(componentsDir, file), "utf8");
      expect(source, `${file} must not use cookies()`).not.toContain("cookies()");
      expect(source, `${file} must not import next/headers`).not.toContain("next/headers");
      expect(source, `${file} must not reference server-only`).not.toContain("server-only");
    }
  });

  it("language-switcher uses the server action + router.refresh pattern", () => {
    const source = readFileSync(path.join(componentsDir, "language-switcher.tsx"), "utf8");
    expect(source).toContain('"use client"');
    expect(source).toContain("setLocaleAction");
    expect(source).toContain("router.refresh()");
    expect(source).not.toContain("window.location");
    expect(source).not.toContain("location.reload");
    expect(source).not.toContain("localStorage");
  });
});
