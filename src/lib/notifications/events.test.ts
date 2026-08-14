import { describe, expect, it } from "vitest";
import type { DnsChange, DnsRecord } from "@/lib/dns";
import type { SslChange } from "@/lib/ssl";
import type { HttpSnapshot } from "@/lib/http";
import {
  buildDedupKey,
  dnsChangesToEvents,
  eventTypeLabel,
  httpStatusChangeEvent,
  serializeState,
  sslChangesToEvents,
} from "./events";

const OCCURRED = new Date("2026-08-14T00:00:00.000Z");

function dnsRecord(value: string, type: DnsRecord["type"] = "A"): DnsRecord {
  return { type, name: "example.com", value };
}

function dnsChange(type: "RECORD_ADDED" | "RECORD_REMOVED", record: DnsRecord): DnsChange {
  return { type, record };
}

function httpSnapshot(status: HttpSnapshot["status"], id = 1): HttpSnapshot {
  return {
    id,
    domainId: 5,
    checkedAt: OCCURRED,
    status,
    httpStatus: status === "ok" ? 200 : undefined,
    responseTimeMs: status === "ok" ? 120 : undefined,
    redirected: false,
    redirectCount: 0,
  };
}

describe("buildDedupKey", () => {
  it("joins parts with colons", () => {
    expect(buildDedupKey(["http", 5, "status_changed", "ok", "down"])).toBe(
      "http:5:status_changed:ok:down",
    );
  });

  it("is stable for identical input", () => {
    const a = buildDedupKey(["ssl", 5, "cert", "AA", "BB"]);
    const b = buildDedupKey(["ssl", 5, "cert", "AA", "BB"]);
    expect(a).toBe(b);
  });

  it("differs when any part differs", () => {
    expect(buildDedupKey(["http", 5, "s", "ok", "down"])).not.toBe(
      buildDedupKey(["http", 5, "s", "ok", "up"]),
    );
    expect(buildDedupKey(["http", 5, "s", "ok", "down"])).not.toBe(
      buildDedupKey(["http", 6, "s", "ok", "down"]),
    );
  });
});

describe("serializeState", () => {
  it("serializes objects to JSON", () => {
    expect(serializeState({ status: "ok", httpStatus: 200 })).toBe(
      '{"status":"ok","httpStatus":200}',
    );
  });

  it("maps undefined and null to null", () => {
    expect(serializeState(undefined)).toBeNull();
    expect(serializeState(null)).toBeNull();
  });
});

describe("dnsChangesToEvents", () => {
  it("produces no events for no changes", () => {
    expect(dnsChangesToEvents(5, [], OCCURRED)).toEqual([]);
  });

  it("converts an added record to dns_record_added with null previous state", () => {
    const [event] = dnsChangesToEvents(
      5,
      [dnsChange("RECORD_ADDED", dnsRecord("1.2.3.4"))],
      OCCURRED,
    );
    expect(event).toMatchObject({
      domainId: 5,
      source: "dns",
      eventType: "dns_record_added",
      previousState: null,
      occurredAt: OCCURRED,
    });
    expect(event.currentState).toContain("1.2.3.4");
    expect(event.dedupKey).toBe("dns:5:RECORD_ADDED:A:1.2.3.4");
  });

  it("converts a removed record to dns_record_removed with null current state", () => {
    const [event] = dnsChangesToEvents(
      5,
      [dnsChange("RECORD_REMOVED", dnsRecord("1.2.3.4"))],
      OCCURRED,
    );
    expect(event.eventType).toBe("dns_record_removed");
    expect(event.currentState).toBeNull();
    expect(event.previousState).toContain("1.2.3.4");
    expect(event.dedupKey).toBe("dns:5:RECORD_REMOVED:A:1.2.3.4");
  });

  it("distinguishes records by type in the dedup key", () => {
    const [a] = dnsChangesToEvents(5, [dnsChange("RECORD_ADDED", dnsRecord("1.2.3.4"))], OCCURRED);
    const [b] = dnsChangesToEvents(
      5,
      [dnsChange("RECORD_ADDED", dnsRecord("1.2.3.4", "AAAA"))],
      OCCURRED,
    );
    expect(a.dedupKey).not.toBe(b.dedupKey);
  });

  it("maps multiple changes to multiple events", () => {
    const events = dnsChangesToEvents(
      5,
      [
        dnsChange("RECORD_ADDED", dnsRecord("1.2.3.4")),
        dnsChange("RECORD_REMOVED", dnsRecord("5.6.7.8")),
      ],
      OCCURRED,
    );
    expect(events).toHaveLength(2);
  });
});

describe("sslChangesToEvents", () => {
  it("produces no events when there are no changes and no status transition", () => {
    const events = sslChangesToEvents({
      domainId: 5,
      changes: [],
      previousStatus: "ok",
      currentStatus: "ok",
      occurredAt: OCCURRED,
    });
    expect(events).toEqual([]);
  });

  it("produces no status event on the first check (no previous)", () => {
    const events = sslChangesToEvents({
      domainId: 5,
      changes: [],
      previousStatus: undefined,
      currentStatus: "ok",
      occurredAt: OCCURRED,
    });
    expect(events).toEqual([]);
  });

  it("creates ssl_cert_replaced with old/new fingerprints in the key", () => {
    const change: SslChange = {
      type: "CERT_REPLACED",
      previousFingerprint: "AA:BB",
      currentFingerprint: "CC:DD",
    };
    const events = sslChangesToEvents({
      domainId: 5,
      changes: [change],
      previousStatus: "ok",
      currentStatus: "ok",
      occurredAt: OCCURRED,
    });
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe("ssl_cert_replaced");
    expect(events[0].dedupKey).toBe("ssl:5:ssl_cert_replaced:AA:BB:CC:DD");
    expect(events[0].previousState).toContain("AA:BB");
    expect(events[0].currentState).toContain("CC:DD");
  });

  it("creates ssl_status_changed when the status transitions", () => {
    const events = sslChangesToEvents({
      domainId: 5,
      changes: [],
      previousStatus: "ok",
      currentStatus: "expires_soon",
      occurredAt: OCCURRED,
    });
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe("ssl_status_changed");
    expect(events[0].dedupKey).toBe("ssl:5:ssl_status_changed:ok:expires_soon");
    expect(events[0].previousState).toBe('"ok"');
    expect(events[0].currentState).toBe('"expires_soon"');
  });

  it("emits both cert_replaced and status_changed together", () => {
    const change: SslChange = {
      type: "CERT_REPLACED",
      previousFingerprint: "AA:BB",
      currentFingerprint: "CC:DD",
    };
    const events = sslChangesToEvents({
      domainId: 5,
      changes: [change],
      previousStatus: "ok",
      currentStatus: "expired",
      occurredAt: OCCURRED,
    });
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.eventType)).toEqual(["ssl_cert_replaced", "ssl_status_changed"]);
  });
});

describe("httpStatusChangeEvent", () => {
  it("returns null on the first check (no previous snapshot)", () => {
    expect(httpStatusChangeEvent(5, undefined, httpSnapshot("ok"), OCCURRED)).toBeNull();
  });

  it("returns null when the status is unchanged", () => {
    expect(
      httpStatusChangeEvent(5, httpSnapshot("down", 1), httpSnapshot("down", 2), OCCURRED),
    ).toBeNull();
  });

  it("creates an event for ok → down", () => {
    const event = httpStatusChangeEvent(
      5,
      httpSnapshot("ok", 1),
      httpSnapshot("down", 2),
      OCCURRED,
    );
    expect(event).not.toBeNull();
    expect(event?.eventType).toBe("http_status_changed");
    expect(event?.dedupKey).toBe("http:5:http_status_changed:ok:down");
    expect(event?.previousState).toContain('"ok"');
    expect(event?.currentState).toContain('"down"');
  });

  it("creates an event for down → ok", () => {
    const event = httpStatusChangeEvent(
      5,
      httpSnapshot("down", 1),
      httpSnapshot("ok", 2),
      OCCURRED,
    );
    expect(event?.dedupKey).toBe("http:5:http_status_changed:down:ok");
  });

  it("creates an event for client_error → server_error", () => {
    const event = httpStatusChangeEvent(
      5,
      httpSnapshot("client_error", 1),
      httpSnapshot("server_error", 2),
      OCCURRED,
    );
    expect(event?.dedupKey).toBe("http:5:http_status_changed:client_error:server_error");
  });

  it("returns null when the current snapshot is missing", () => {
    expect(httpStatusChangeEvent(5, httpSnapshot("ok"), undefined, OCCURRED)).toBeNull();
  });
});

describe("eventTypeLabel", () => {
  it("labels every event type", () => {
    expect(eventTypeLabel("dns_record_added")).toBe("DNS record added");
    expect(eventTypeLabel("dns_record_removed")).toBe("DNS record removed");
    expect(eventTypeLabel("ssl_cert_replaced")).toBe("SSL certificate replaced");
    expect(eventTypeLabel("ssl_status_changed")).toBe("SSL status changed");
    expect(eventTypeLabel("http_status_changed")).toBe("HTTP status changed");
  });
});
