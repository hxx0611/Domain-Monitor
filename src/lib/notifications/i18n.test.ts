/**
 * Notification i18n dictionary integrity (Phase 11I).
 *
 * Guarantees that every language has the SAME set of keys for both the
 * event labels and the template labels — a missing translation must fail
 * the build, not silently render an English fallback.
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_NOTIFICATION_LANGUAGE,
  NOTIFICATION_EVENT_LABELS,
  NOTIFICATION_LANGUAGES,
  NOTIFICATION_TEMPLATE_LABELS,
  isNotificationLanguage,
} from "./i18n";

describe("notification i18n", () => {
  it("exposes exactly the supported languages", () => {
    expect(NOTIFICATION_LANGUAGES).toEqual(["en", "zh-CN"]);
    expect(DEFAULT_NOTIFICATION_LANGUAGE).toBe("en");
    expect(isNotificationLanguage("en")).toBe(true);
    expect(isNotificationLanguage("zh-CN")).toBe(true);
    expect(isNotificationLanguage("fr")).toBe(false);
    expect(isNotificationLanguage(undefined)).toBe(false);
    expect(isNotificationLanguage(7)).toBe(false);
  });

  it("event label key sets are identical across languages", () => {
    const keySets = NOTIFICATION_LANGUAGES.map((lang) =>
      Object.keys(NOTIFICATION_EVENT_LABELS[lang]).sort(),
    );
    const first = keySets[0];
    for (const keys of keySets) {
      expect(keys).toEqual(first);
    }
    // every event type in the sender's English labels is covered
    expect(first).toContain("dns_record_added");
    expect(first).toContain("dns_record_removed");
    expect(first).toContain("ssl_cert_replaced");
    expect(first).toContain("ssl_status_changed");
    expect(first).toContain("http_status_changed");
    expect(first).toContain("test_notification");
  });

  it("template label key sets are identical across languages", () => {
    const keySets = NOTIFICATION_LANGUAGES.map((lang) =>
      Object.keys(NOTIFICATION_TEMPLATE_LABELS[lang]).sort(),
    );
    const first = keySets[0];
    for (const keys of keySets) {
      expect(keys).toEqual(first);
    }
    expect(first).toEqual(["appTitle", "domain", "event", "eventId", "status", "time"].sort());
  });

  it("no template value is empty", () => {
    for (const lang of NOTIFICATION_LANGUAGES) {
      for (const value of Object.values(NOTIFICATION_TEMPLATE_LABELS[lang])) {
        expect(value.length).toBeGreaterThan(0);
      }
      for (const value of Object.values(NOTIFICATION_EVENT_LABELS[lang])) {
        expect(value.length).toBeGreaterThan(0);
      }
    }
  });
});
