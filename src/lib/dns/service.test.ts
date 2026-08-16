import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { domains, dnsRecords, dnsSnapshots, notificationEvents } from "@/db/schema";
import { createTestDb } from "../../../test/helpers";
import { DnsError, queryDnsRecords } from "./client";
import { checkDns } from "./service";
import type { DnsRecord, DnsRecordType } from "./types";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, queryDnsRecords: vi.fn() };
});

vi.mock("@/lib/domains", () => ({
  getDomainById: vi.fn(),
}));

import { getDomainById } from "@/lib/domains";
import { createDnsSnapshot, getLatestDnsSnapshot } from "./repository";

const mockedQuery = vi.mocked(queryDnsRecords);
const mockedGetDomain = vi.mocked(getDomainById);

function mockClient(byType: Partial<Record<DnsRecordType, DnsRecord[]>>) {
  mockedQuery.mockImplementation(async (_hostname, type) => byType[type] ?? []);
}

function aRecord(value: string, ttl?: number): DnsRecord {
  return { type: "A", name: "example.com", value, ...(ttl !== undefined ? { ttl } : {}) };
}

describe("checkDns", () => {
  const db = createTestDb();
  let domainId = 0;

  beforeEach(async () => {
    // Reset all tables between tests.
    db.delete(dnsRecords).run();
    db.delete(dnsSnapshots).run();
    db.delete(domains).run();

    const domain = db.insert(domains).values({ hostname: "example.com" }).returning().get();
    domainId = domain.id;
    mockedGetDomain.mockReturnValue({ id: domain.id, hostname: "example.com" } as never);
    mockedQuery.mockReset();
  });

  it("rejects an unknown domain id without querying DNS", async () => {
    mockedGetDomain.mockReturnValue(undefined as never);
    const result = await checkDns(999999, { db });
    expect(result).toEqual({ ok: false, error: "Domain not found." });
    expect(mockedQuery).not.toHaveBeenCalled();
  });

  it("creates a first snapshot without change events", async () => {
    mockClient({
      A: [aRecord("1.2.3.4")],
      MX: [{ type: "MX", name: "example.com", value: "mail.example.com", priority: 10 }],
    });
    const result = await checkDns(domainId, { db });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changes).toEqual([]);

    const stored = getLatestDnsSnapshot(domainId, db);
    expect(stored).toBeDefined();
    expect(stored?.records).toHaveLength(2);
  });

  it("reports added and removed records on the second check", async () => {
    mockClient({ A: [aRecord("1.2.3.4")] });
    await checkDns(domainId, { db });

    mockClient({ A: [aRecord("5.6.7.8")] });
    const result = await checkDns(domainId, { db });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changes).toEqual([
      { type: "RECORD_ADDED", record: aRecord("5.6.7.8") },
      { type: "RECORD_REMOVED", record: aRecord("1.2.3.4") },
    ]);
  });

  it("does not report a change for TTL-only differences", async () => {
    mockClient({ A: [aRecord("1.2.3.4", 300)] });
    await checkDns(domainId, { db });

    mockClient({ A: [aRecord("1.2.3.4", 600)] });
    const result = await checkDns(domainId, { db });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.changes).toEqual([]);
    }
  });

  it("fails the whole check when one record type fails (atomic)", async () => {
    mockClient({ A: [aRecord("1.2.3.4")] });
    await checkDns(domainId, { db });

    mockedQuery.mockImplementation(async (_hostname, type) => {
      if (type === "TXT") {
        throw new DnsError("DoH request timed out.", "timeout");
      }
      return [];
    });
    const result = await checkDns(domainId, { db });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("DNS monitoring unavailable.");
    expect(result.errorCode).toBe("dns_timeout");

    // No new snapshot was written; the previous one is preserved.
    const snapshots = db.select().from(dnsSnapshots).all();
    expect(snapshots).toHaveLength(1);
    const latest = getLatestDnsSnapshot(domainId, db);
    expect(latest?.records).toEqual([aRecord("1.2.3.4")]);
  });

  it("fails without writing anything on a network error", async () => {
    mockedQuery.mockRejectedValue(new DnsError("DoH request failed (network error).", "network"));
    const result = await checkDns(domainId, { db });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe("dns_network");
    }
    expect(db.select().from(dnsSnapshots).all()).toHaveLength(0);
  });

  it("creates an empty snapshot when the domain has no records", async () => {
    mockClient({});
    const result = await checkDns(domainId, { db });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changes).toEqual([]);
    const latest = getLatestDnsSnapshot(domainId, db);
    expect(latest?.records).toEqual([]);
  });

  it("rejects a concurrent check for the same domain", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockedQuery.mockImplementation(async () => {
      await gate;
      return [aRecord("1.2.3.4")];
    });

    const first = checkDns(domainId, { db });
    const second = await checkDns(domainId, { db });
    expect(second).toEqual({ ok: false, error: "A DNS check is already in progress." });

    release();
    const firstResult = await first;
    expect(firstResult.ok).toBe(true);
  });

  it("persists records through the repository (end-to-end within service)", async () => {
    mockClient({
      A: [aRecord("1.2.3.4")],
      TXT: [{ type: "TXT", name: "example.com", value: "v=spf1 -all" }],
    });
    const result = await checkDns(domainId, { db });
    expect(result.ok).toBe(true);

    const stored = getLatestDnsSnapshot(domainId, db);
    expect(stored?.records).toEqual([
      { type: "A", name: "example.com", value: "1.2.3.4" },
      { type: "TXT", name: "example.com", value: "v=spf1 -all" },
    ]);
  });

  it("allows a new check after a failed one completes", async () => {
    mockedQuery.mockRejectedValueOnce(new Error("boom"));
    const failed = await checkDns(domainId, { db });
    expect(failed.ok).toBe(false);

    mockClient({ A: [aRecord("1.2.3.4")] });
    const retried = await checkDns(domainId, { db });
    expect(retried.ok).toBe(true);
    if (retried.ok) {
      expect(retried.changes).toEqual([]);
    }
  });
});

describe("createDnsSnapshot via repository", () => {
  it("stores records with nullable priority and ttl", () => {
    const db = createTestDb();
    db.insert(domains).values({ hostname: "example.com" }).returning().get();

    const snapshotId = createDnsSnapshot(
      1,
      [
        { type: "A", name: "example.com", value: "1.2.3.4", ttl: 300 },
        { type: "MX", name: "example.com", value: "mail.example.com", priority: 10 },
      ],
      db,
    );

    const rows = db.select().from(dnsRecords).where(eq(dnsRecords.snapshotId, snapshotId)).all();
    expect(rows).toHaveLength(2);
    const a = rows.find((r) => r.type === "A");
    const mx = rows.find((r) => r.type === "MX");
    expect(a?.priority).toBeNull();
    expect(a?.ttl).toBe(300);
    expect(mx?.priority).toBe(10);
    expect(mx?.ttl).toBeNull();
  });
});

describe("checkDns notification events (V0.6)", () => {
  const db = createTestDb();
  let domainId = 0;

  beforeEach(() => {
    db.delete(notificationEvents).run();
    db.delete(dnsRecords).run();
    db.delete(dnsSnapshots).run();
    db.delete(domains).run();
    const domain = db.insert(domains).values({ hostname: "example.com" }).returning().get();
    domainId = domain.id;
    mockedGetDomain.mockReturnValue({ id: domain.id, hostname: "example.com" } as never);
    mockedQuery.mockReset();
  });

  function eventRows() {
    return db.select().from(notificationEvents).all();
  }

  it("produces zero events on the first check", async () => {
    mockClient({ A: [aRecord("1.2.3.4")] });
    await checkDns(domainId, { db });
    expect(eventRows()).toHaveLength(0);
  });

  it("produces one event when a record is added", async () => {
    mockClient({ A: [aRecord("1.2.3.4")] });
    await checkDns(domainId, { db });

    mockClient({ A: [aRecord("1.2.3.4"), aRecord("5.6.7.8")] });
    await checkDns(domainId, { db });

    const events = eventRows();
    expect(events).toHaveLength(1);
    expect(events[0].source).toBe("dns");
    expect(events[0].eventType).toBe("dns_record_added");
    expect(events[0].dedupKey).toContain("5.6.7.8");
  });

  it("produces one event when a record is removed", async () => {
    mockClient({ A: [aRecord("1.2.3.4"), aRecord("5.6.7.8")] });
    await checkDns(domainId, { db });

    mockClient({ A: [aRecord("1.2.3.4")] });
    await checkDns(domainId, { db });

    const events = eventRows();
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe("dns_record_removed");
  });

  it("records removed and re-added as two distinct events (different keys)", async () => {
    // Removing then re-adding the same record is two real transitions with
    // different dedup keys (REMOVED vs ADDED) — both must be recorded.
    mockClient({ A: [aRecord("1.2.3.4"), aRecord("5.6.7.8")] });
    await checkDns(domainId, { db });

    mockClient({ A: [aRecord("1.2.3.4")] });
    await checkDns(domainId, { db });
    expect(eventRows()).toHaveLength(1); // removed

    mockClient({ A: [aRecord("1.2.3.4"), aRecord("5.6.7.8")] });
    await checkDns(domainId, { db });
    const events = eventRows();
    expect(events).toHaveLength(2); // removed + added
    expect(new Set(events.map((e) => e.dedupKey)).size).toBe(2); // distinct keys
  });
});
