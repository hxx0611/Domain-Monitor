import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { domains, sslCertificates, sslSnapshots } from "@/db/schema";
import { createTestDb } from "../../../test/helpers";
import {
  createSslSnapshot,
  getLatestSslSnapshot,
  getSslHistory,
  type NewSslCheckData,
  type SslDb,
} from "./repository";
import type { SslCertificate } from "./types";

function setupDomain(db: SslDb, hostname = "example.com"): number {
  const row = db.insert(domains).values({ hostname }).returning().get();
  return row.id;
}

function cert(overrides: Partial<SslCertificate> = {}): SslCertificate {
  return {
    fingerprint256: "AA:BB:CC:DD",
    subject: "CN=example.com",
    issuer: "CN=Test CA",
    validFrom: "2026-01-01T00:00:00.000Z",
    validTo: "2026-12-31T00:00:00.000Z",
    serialNumber: "01",
    san: ["DNS:example.com"],
    isSelfSigned: false,
    hostnameMatched: true,
    ...overrides,
  };
}

function checkData(domainId: number, overrides: Partial<NewSslCheckData> = {}): NewSslCheckData {
  return {
    domainId,
    tlsVersion: "TLSv1.3",
    cipherName: "TLS_AES_256_GCM_SHA384",
    status: "ok",
    certificate: cert(),
    ...overrides,
  };
}

describe("createSslSnapshot", () => {
  it("creates a snapshot with certificate and reads it back", () => {
    const db = createTestDb();
    const domainId = setupDomain(db);

    const snapshotId = createSslSnapshot(checkData(domainId), db);
    expect(snapshotId).toBeGreaterThan(0);

    const latest = getLatestSslSnapshot(domainId, db);
    expect(latest).toBeDefined();
    expect(latest?.id).toBe(snapshotId);
    expect(latest?.status).toBe("ok");
    expect(latest?.tlsVersion).toBe("TLSv1.3");
    expect(latest?.cipherName).toBe("TLS_AES_256_GCM_SHA384");
    expect(latest?.certificate?.fingerprint256).toBe("AA:BB:CC:DD");
    expect(latest?.certificate?.san).toEqual(["DNS:example.com"]);
  });

  it("stores error snapshots without a certificate row", () => {
    const db = createTestDb();
    const domainId = setupDomain(db);

    const snapshotId = createSslSnapshot(
      checkData(domainId, {
        status: "error",
        error: "SSL monitoring unavailable.",
        certificate: undefined,
      }),
      db,
    );
    const latest = getLatestSslSnapshot(domainId, db);
    expect(latest?.id).toBe(snapshotId);
    expect(latest?.status).toBe("error");
    expect(latest?.error).toBe("SSL monitoring unavailable.");
    expect(latest?.certificate).toBeUndefined();

    const certRows = db.select().from(sslCertificates).all();
    expect(certRows).toHaveLength(0);
  });

  it("writes snapshot and certificate in one transaction", () => {
    const db = createTestDb();
    const domainId = setupDomain(db);
    const snapshotId = createSslSnapshot(checkData(domainId), db);

    // Both tables have exactly one row each, linked by snapshot_id.
    const snap = db.select().from(sslSnapshots).all();
    const certRows = db.select().from(sslCertificates).all();
    expect(snap).toHaveLength(1);
    expect(certRows).toHaveLength(1);
    expect(certRows[0].snapshotId).toBe(snapshotId);
  });

  it("persists boolean flags as integers", () => {
    const db = createTestDb();
    const domainId = setupDomain(db);
    createSslSnapshot(
      checkData(domainId, {
        certificate: cert({ isSelfSigned: true, hostnameMatched: false }),
      }),
      db,
    );
    const row = db.select().from(sslCertificates).get();
    expect(row?.isSelfSigned).toBe(1);
    expect(row?.hostnameMatched).toBe(0);
  });
});

describe("getLatestSslSnapshot", () => {
  it("returns the newest snapshot by checked_at (then id)", () => {
    const db = createTestDb();
    const domainId = setupDomain(db);

    // Insert two snapshots with distinct checked_at values.
    createSslSnapshot(checkData(domainId, { certificate: cert({ fingerprint256: "AA:AA" }) }), db);
    const second = createSslSnapshot(
      checkData(domainId, {
        certificate: cert({ fingerprint256: "BB:BB" }),
        tlsVersion: "TLSv1.2",
      }),
      db,
    );
    db.update(sslSnapshots)
      .set({ checkedAt: new Date(Date.now() + 60_000) })
      .where(eq(sslSnapshots.id, second))
      .run();

    const latest = getLatestSslSnapshot(domainId, db);
    expect(latest?.id).toBe(second);
    expect(latest?.certificate?.fingerprint256).toBe("BB:BB");
  });

  it("returns undefined when a domain has no snapshots", () => {
    const db = createTestDb();
    const domainId = setupDomain(db);
    expect(getLatestSslSnapshot(domainId, db)).toBeUndefined();
  });
});

describe("getSslHistory", () => {
  it("returns snapshots newest first with certificates", () => {
    const db = createTestDb();
    const domainId = setupDomain(db);

    const first = createSslSnapshot(
      checkData(domainId, { certificate: cert({ fingerprint256: "AA:AA" }) }),
      db,
    );
    const second = createSslSnapshot(
      checkData(domainId, { certificate: cert({ fingerprint256: "BB:BB" }) }),
      db,
    );
    db.update(sslSnapshots)
      .set({ checkedAt: new Date(Date.now() + 60_000) })
      .where(eq(sslSnapshots.id, second))
      .run();

    const history = getSslHistory(domainId, 10, db);
    expect(history).toHaveLength(2);
    expect(history[0].id).toBe(second);
    expect(history[0].certificate?.fingerprint256).toBe("BB:BB");
    expect(history[1].id).toBe(first);
    expect(history[1].certificate?.fingerprint256).toBe("AA:AA");
  });

  it("respects the limit", () => {
    const db = createTestDb();
    const domainId = setupDomain(db);
    for (let i = 0; i < 5; i++) {
      createSslSnapshot(
        checkData(domainId, { certificate: cert({ fingerprint256: `FF:${i}` }) }),
        db,
      );
    }
    expect(getSslHistory(domainId, 3, db)).toHaveLength(3);
  });

  it("does not mix histories across domains", () => {
    const db = createTestDb();
    const a = setupDomain(db, "alpha.com");
    const b = setupDomain(db, "beta.com");

    createSslSnapshot(checkData(a, { certificate: cert({ fingerprint256: "AA:AA" }) }), db);
    createSslSnapshot(checkData(b, { certificate: cert({ fingerprint256: "BB:BB" }) }), db);

    const historyA = getSslHistory(a, 10, db);
    const historyB = getSslHistory(b, 10, db);
    expect(historyA).toHaveLength(1);
    expect(historyB).toHaveLength(1);
    expect(historyA[0].certificate?.fingerprint256).toBe("AA:AA");
    expect(historyB[0].certificate?.fingerprint256).toBe("BB:BB");
  });

  it("returns an empty array when a domain has no snapshots", () => {
    const db = createTestDb();
    const domainId = setupDomain(db);
    expect(getSslHistory(domainId, 10, db)).toEqual([]);
  });
});

describe("foreign key cascade", () => {
  it("deletes certificates when their snapshot is deleted", () => {
    const db = createTestDb();
    const domainId = setupDomain(db);
    const snapshotId = createSslSnapshot(checkData(domainId), db);

    db.delete(sslSnapshots).where(eq(sslSnapshots.id, snapshotId)).run();

    expect(db.select().from(sslCertificates).all()).toHaveLength(0);
  });

  it("deletes snapshots and certificates when the domain is deleted", () => {
    const db = createTestDb();
    const domainId = setupDomain(db);
    createSslSnapshot(checkData(domainId), db);

    db.delete(domains).where(eq(domains.id, domainId)).run();

    expect(db.select().from(sslSnapshots).all()).toHaveLength(0);
    expect(db.select().from(sslCertificates).all()).toHaveLength(0);
  });
});
