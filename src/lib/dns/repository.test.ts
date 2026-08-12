import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { domains, dnsRecords, dnsSnapshots } from "@/db/schema";
import { createTestDb } from "../../../test/helpers";
import { createDnsSnapshot, getDnsSnapshots, getLatestDnsSnapshot, type DnsDb } from "./repository";
import type { DnsRecord } from "./types";

function setupDomain(db: DnsDb, hostname = "example.com"): number {
  const row = db.insert(domains).values({ hostname }).returning().get();
  return row.id;
}

function records(...values: string[]): DnsRecord[] {
  return values.map((value) => ({ type: "A" as const, name: "example.com", value }));
}

describe("dns repository", () => {
  it("creates a snapshot with records and reads it back", () => {
    const db = createTestDb();
    const domainId = setupDomain(db);

    const snapshotId = createDnsSnapshot(domainId, records("1.2.3.4", "5.6.7.8"), db);
    expect(snapshotId).toBeGreaterThan(0);

    const latest = getLatestDnsSnapshot(domainId, db);
    expect(latest).toBeDefined();
    expect(latest?.id).toBe(snapshotId);
    expect(latest?.records.map((r) => r.value)).toEqual(["1.2.3.4", "5.6.7.8"]);
  });

  it("keeps multiple snapshots per domain (history is retained)", () => {
    const db = createTestDb();
    const domainId = setupDomain(db);

    createDnsSnapshot(domainId, records("1.2.3.4"), db);
    createDnsSnapshot(domainId, records("5.6.7.8"), db);
    createDnsSnapshot(domainId, records("9.9.9.9"), db);

    const history = getDnsSnapshots(domainId, 10, db);
    expect(history).toHaveLength(3);
    // Newest first.
    expect(history[0].records[0].value).toBe("9.9.9.9");
    expect(history[2].records[0].value).toBe("1.2.3.4");
  });

  it("returns the latest snapshot with its own records", () => {
    const db = createTestDb();
    const domainId = setupDomain(db);

    createDnsSnapshot(domainId, records("1.2.3.4"), db);
    createDnsSnapshot(domainId, records("5.6.7.8"), db);

    const latest = getLatestDnsSnapshot(domainId, db);
    expect(latest?.records.map((r) => r.value)).toEqual(["5.6.7.8"]);
  });

  it("returns undefined when a domain has no snapshots", () => {
    const db = createTestDb();
    const domainId = setupDomain(db);
    expect(getLatestDnsSnapshot(domainId, db)).toBeUndefined();
    expect(getDnsSnapshots(domainId, 10, db)).toEqual([]);
  });

  it("respects the limit on history queries", () => {
    const db = createTestDb();
    const domainId = setupDomain(db);
    for (let i = 0; i < 5; i++) {
      createDnsSnapshot(domainId, records(`1.2.3.${i}`), db);
    }
    expect(getDnsSnapshots(domainId, 3, db)).toHaveLength(3);
  });

  it("cascades deletion when the domain is removed", () => {
    const db = createTestDb();
    const domainId = setupDomain(db);
    createDnsSnapshot(domainId, records("1.2.3.4"), db);

    db.delete(domains).where(eq(domains.id, domainId)).run();

    expect(db.select().from(dnsSnapshots).all()).toHaveLength(0);
    expect(db.select().from(dnsRecords).all()).toHaveLength(0);
  });

  it("stores TXT and CAA values verbatim", () => {
    const db = createTestDb();
    const domainId = setupDomain(db);
    createDnsSnapshot(
      domainId,
      [
        { type: "TXT", name: "example.com", value: '"v=spf1 -all"' },
        { type: "CAA", name: "example.com", value: "0 issue pki.goog" },
      ],
      db,
    );

    const latest = getLatestDnsSnapshot(domainId, db);
    expect(latest?.records.map((r) => r.value)).toEqual(['"v=spf1 -all"', "0 issue pki.goog"]);
  });
});
