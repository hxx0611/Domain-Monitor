import { describe, expect, it } from "vitest";
import { matchesRule, matchRules } from "./rules";
import type { NotificationEvent, NotificationRuleFilter } from "./types";

function event(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    domainId: 5,
    source: "http",
    eventType: "http_status_changed",
    previousState: '"ok"',
    currentState: '"down"',
    occurredAt: new Date("2026-08-14T00:00:00.000Z"),
    dedupKey: "http:5:http_status_changed:ok:down",
    ...overrides,
  };
}

function rule(overrides: Partial<NotificationRuleFilter> = {}): NotificationRuleFilter {
  return {
    channelId: 1,
    source: null,
    eventType: null,
    domainId: null,
    enabled: true,
    ...overrides,
  };
}

describe("matchesRule", () => {
  it("matches everything with all-null filters", () => {
    expect(matchesRule(rule(), event())).toBe(true);
  });

  it("never matches a disabled rule", () => {
    expect(matchesRule(rule({ enabled: false }), event())).toBe(false);
  });

  it("filters by source", () => {
    const sslRule = rule({ source: "ssl" });
    expect(matchesRule(sslRule, event({ source: "ssl" }))).toBe(true);
    expect(matchesRule(sslRule, event({ source: "http" }))).toBe(false);
  });

  it("filters by event type", () => {
    const dnsRule = rule({ eventType: "dns_record_added" });
    expect(matchesRule(dnsRule, event({ eventType: "dns_record_added" }))).toBe(true);
    expect(matchesRule(dnsRule, event({ eventType: "http_status_changed" }))).toBe(false);
  });

  it("filters by domain", () => {
    const domainRule = rule({ domainId: 5 });
    expect(matchesRule(domainRule, event({ domainId: 5 }))).toBe(true);
    expect(matchesRule(domainRule, event({ domainId: 9 }))).toBe(false);
  });

  it("combines filters with AND semantics", () => {
    const combined = rule({ source: "http", eventType: "http_status_changed", domainId: 5 });
    expect(matchesRule(combined, event())).toBe(true);
    expect(matchesRule(combined, event({ source: "ssl" }))).toBe(false);
    expect(matchesRule(combined, event({ eventType: "ssl_cert_replaced" }))).toBe(false);
    expect(matchesRule(combined, event({ domainId: 9 }))).toBe(false);
  });

  it("treats null source as matching any source even when other filters apply", () => {
    const rule1 = rule({ source: null, eventType: "http_status_changed" });
    expect(matchesRule(rule1, event({ source: "http" }))).toBe(true);
    expect(matchesRule(rule1, event({ source: "ssl", eventType: "http_status_changed" }))).toBe(
      true,
    );
  });
});

describe("matchRules", () => {
  it("returns all matching rules", () => {
    const rules = [
      rule({ channelId: 1, source: "http" }),
      rule({ channelId: 2, source: "http" }),
      rule({ channelId: 3, source: "ssl" }),
      rule({ channelId: 4, enabled: false }),
    ];
    const matched = matchRules(rules, event({ source: "http" }));
    expect(matched.map((r) => r.channelId)).toEqual([1, 2]);
  });

  it("returns an empty array when nothing matches", () => {
    expect(matchRules([rule({ source: "ssl" })], event({ source: "http" }))).toEqual([]);
  });

  it("returns an empty array for no rules", () => {
    expect(matchRules([], event())).toEqual([]);
  });

  it("lets a catch-all rule match any event", () => {
    const matched = matchRules(
      [rule({ channelId: 7 })],
      event({ source: "dns", eventType: "dns_record_added" }),
    );
    expect(matched.map((r) => r.channelId)).toEqual([7]);
  });
});
