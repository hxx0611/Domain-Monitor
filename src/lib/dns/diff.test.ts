import { describe, expect, it } from "vitest";
import { diffDnsSnapshots } from "./diff";
import type { DnsRecord, DnsSnapshot } from "./types";

function snapshot(id: number, records: DnsRecord[]): DnsSnapshot {
  return { id, domainId: 1, checkedAt: new Date(), records };
}

function aRecord(value: string, ttl?: number): DnsRecord {
  return { type: "A", name: "example.com", value, ...(ttl !== undefined ? { ttl } : {}) };
}

describe("diffDnsSnapshots", () => {
  it("produces no changes for identical snapshots", () => {
    const records = [aRecord("1.2.3.4"), aRecord("5.6.7.8")];
    expect(diffDnsSnapshots(snapshot(1, records), snapshot(2, records))).toEqual([]);
  });

  it("produces no changes for an undefined previous snapshot (first check)", () => {
    const current = snapshot(1, [aRecord("1.2.3.4")]);
    expect(diffDnsSnapshots(undefined, current)).toEqual([]);
  });

  it("reports a RECORD_ADDED for a new record", () => {
    const changes = diffDnsSnapshots(
      snapshot(1, [aRecord("1.2.3.4")]),
      snapshot(2, [aRecord("1.2.3.4"), aRecord("5.6.7.8")]),
    );
    expect(changes).toEqual([{ type: "RECORD_ADDED", record: aRecord("5.6.7.8") }]);
  });

  it("reports a RECORD_REMOVED for a deleted record", () => {
    const changes = diffDnsSnapshots(snapshot(1, [aRecord("1.2.3.4")]), snapshot(2, []));
    expect(changes).toEqual([{ type: "RECORD_REMOVED", record: aRecord("1.2.3.4") }]);
  });

  it("reports REMOVED then ADDED when a record value changes", () => {
    const changes = diffDnsSnapshots(
      snapshot(1, [aRecord("1.2.3.4")]),
      snapshot(2, [aRecord("5.6.7.8")]),
    );
    expect(changes).toEqual([
      { type: "RECORD_ADDED", record: aRecord("5.6.7.8") },
      { type: "RECORD_REMOVED", record: aRecord("1.2.3.4") },
    ]);
  });

  it("ignores TTL-only changes", () => {
    const changes = diffDnsSnapshots(
      snapshot(1, [aRecord("1.2.3.4", 300)]),
      snapshot(2, [aRecord("1.2.3.4", 600)]),
    );
    expect(changes).toEqual([]);
  });

  it("detects an MX priority change as removed + added", () => {
    const low: DnsRecord = {
      type: "MX",
      name: "example.com",
      value: "mail.example.com",
      priority: 10,
    };
    const high: DnsRecord = {
      type: "MX",
      name: "example.com",
      value: "mail.example.com",
      priority: 20,
    };
    const changes = diffDnsSnapshots(snapshot(1, [low]), snapshot(2, [high]));
    expect(changes).toEqual([
      { type: "RECORD_ADDED", record: high },
      { type: "RECORD_REMOVED", record: low },
    ]);
  });

  it("treats different answer orderings as equal", () => {
    const first = snapshot(1, [aRecord("1.2.3.4"), aRecord("5.6.7.8")]);
    const second = snapshot(2, [aRecord("5.6.7.8"), aRecord("1.2.3.4")]);
    expect(diffDnsSnapshots(first, second)).toEqual([]);
  });

  it("treats trailing-dot differences as equal (canonicalized upstream)", () => {
    const bare: DnsRecord = { type: "NS", name: "example.com", value: "ns1.example.com" };
    const dotted: DnsRecord = { type: "NS", name: "example.com", value: "ns1.example.com" };
    expect(diffDnsSnapshots(snapshot(1, [bare]), snapshot(2, [dotted]))).toEqual([]);
  });

  it("treats case differences as equal (canonicalized upstream)", () => {
    const lower: DnsRecord = {
      type: "CNAME",
      name: "www.example.com",
      value: "target.example.net",
    };
    const upper: DnsRecord = {
      type: "CNAME",
      name: "www.example.com",
      value: "target.example.net",
    };
    expect(diffDnsSnapshots(snapshot(1, [lower]), snapshot(2, [upper]))).toEqual([]);
  });

  it("handles mixed changes across multiple record types", () => {
    const previous = snapshot(1, [
      { type: "A", name: "example.com", value: "1.2.3.4" },
      { type: "MX", name: "example.com", value: "mail.example.com", priority: 10 },
      { type: "TXT", name: "example.com", value: "v=spf1 -all" },
    ]);
    const current = snapshot(2, [
      { type: "A", name: "example.com", value: "5.6.7.8" },
      { type: "MX", name: "example.com", value: "mail.example.com", priority: 10 },
      { type: "TXT", name: "example.com", value: "v=spf1 -all" },
      { type: "CAA", name: "example.com", value: "0 issue pki.goog" },
    ]);
    const changes = diffDnsSnapshots(previous, current);
    expect(changes).toEqual([
      { type: "RECORD_ADDED", record: { type: "A", name: "example.com", value: "5.6.7.8" } },
      {
        type: "RECORD_ADDED",
        record: { type: "CAA", name: "example.com", value: "0 issue pki.goog" },
      },
      { type: "RECORD_REMOVED", record: { type: "A", name: "example.com", value: "1.2.3.4" } },
    ]);
  });
});
