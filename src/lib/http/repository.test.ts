import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { domains, httpSnapshots } from "@/db/schema";
import { createTestDb } from "../../../test/helpers";
import {
  createHttpSnapshot,
  getHttpHistory,
  getLatestHttpSnapshot,
  type HttpDb,
  type NewHttpCheckData,
} from "./repository";

function setupDomain(db: HttpDb, hostname = "example.com"): number {
  const row = db.insert(domains).values({ hostname }).returning().get();
  return row.id;
}

function checkData(domainId: number, overrides: Partial<NewHttpCheckData> = {}): NewHttpCheckData {
  return {
    domainId,
    status: "ok",
    httpStatus: 200,
    responseTimeMs: 243,
    redirected: false,
    redirectCount: 0,
    finalUrl: "https://example.com/",
    ...overrides,
  };
}

describe("createHttpSnapshot", () => {
  it("creates a snapshot and reads it back", () => {
    const db = createTestDb();
    const domainId = setupDomain(db);

    const snapshotId = createHttpSnapshot(checkData(domainId), db);
    expect(snapshotId).toBeGreaterThan(0);

    const latest = getLatestHttpSnapshot(domainId, db);
    expect(latest?.id).toBe(snapshotId);
    expect(latest?.status).toBe("ok");
    expect(latest?.httpStatus).toBe(200);
    expect(latest?.responseTimeMs).toBe(243);
    expect(latest?.redirected).toBe(false);
    expect(latest?.redirectCount).toBe(0);
    expect(latest?.finalUrl).toBe("https://example.com/");
    expect(latest?.error).toBeUndefined();
  });

  it("stores redirect metadata", () => {
    const db = createTestDb();
    const domainId = setupDomain(db);
    createHttpSnapshot(
      checkData(domainId, {
        redirected: true,
        redirectCount: 2,
        finalUrl: "https://example.com/final",
      }),
      db,
    );
    const latest = getLatestHttpSnapshot(domainId, db);
    expect(latest?.redirected).toBe(true);
    expect(latest?.redirectCount).toBe(2);
    expect(latest?.finalUrl).toBe("https://example.com/final");
  });

  it("stores error snapshots without http status", () => {
    const db = createTestDb();
    const domainId = setupDomain(db);
    createHttpSnapshot(
      checkData(domainId, {
        status: "error",
        httpStatus: undefined,
        responseTimeMs: undefined,
        error: "HTTP monitoring unavailable.",
      }),
      db,
    );
    const latest = getLatestHttpSnapshot(domainId, db);
    expect(latest?.status).toBe("error");
    expect(latest?.error).toBe("HTTP monitoring unavailable.");
    expect(latest?.httpStatus).toBeUndefined();
    expect(latest?.responseTimeMs).toBeUndefined();
  });

  it("stores down snapshots without http status", () => {
    const db = createTestDb();
    const domainId = setupDomain(db);
    createHttpSnapshot(checkData(domainId, { status: "down", httpStatus: undefined }), db);
    const latest = getLatestHttpSnapshot(domainId, db);
    expect(latest?.status).toBe("down");
    expect(latest?.httpStatus).toBeUndefined();
  });
});

describe("getLatestHttpSnapshot", () => {
  it("returns the newest snapshot by checked_at (then id)", () => {
    const db = createTestDb();
    const domainId = setupDomain(db);

    createHttpSnapshot(checkData(domainId, { httpStatus: 200 }), db);
    const second = createHttpSnapshot(checkData(domainId, { httpStatus: 503 }), db);
    db.update(httpSnapshots)
      .set({ checkedAt: new Date(Date.now() + 60_000) })
      .where(eq(httpSnapshots.id, second))
      .run();

    const latest = getLatestHttpSnapshot(domainId, db);
    expect(latest?.id).toBe(second);
    expect(latest?.httpStatus).toBe(503);
  });

  it("returns undefined when a domain has no snapshots", () => {
    const db = createTestDb();
    const domainId = setupDomain(db);
    expect(getLatestHttpSnapshot(domainId, db)).toBeUndefined();
  });
});

describe("getHttpHistory", () => {
  it("returns snapshots newest first", () => {
    const db = createTestDb();
    const domainId = setupDomain(db);

    const first = createHttpSnapshot(checkData(domainId, { httpStatus: 200 }), db);
    const second = createHttpSnapshot(checkData(domainId, { httpStatus: 503 }), db);
    db.update(httpSnapshots)
      .set({ checkedAt: new Date(Date.now() + 60_000) })
      .where(eq(httpSnapshots.id, second))
      .run();

    const history = getHttpHistory(domainId, 10, db);
    expect(history).toHaveLength(2);
    expect(history[0].id).toBe(second);
    expect(history[1].id).toBe(first);
  });

  it("respects the limit", () => {
    const db = createTestDb();
    const domainId = setupDomain(db);
    for (let i = 0; i < 5; i++) {
      createHttpSnapshot(checkData(domainId, { httpStatus: 200 }), db);
    }
    expect(getHttpHistory(domainId, 3, db)).toHaveLength(3);
  });

  it("does not mix histories across domains", () => {
    const db = createTestDb();
    const a = setupDomain(db, "alpha.com");
    const b = setupDomain(db, "beta.com");

    createHttpSnapshot(checkData(a, { httpStatus: 200 }), db);
    createHttpSnapshot(checkData(b, { httpStatus: 500 }), db);

    const historyA = getHttpHistory(a, 10, db);
    const historyB = getHttpHistory(b, 10, db);
    expect(historyA).toHaveLength(1);
    expect(historyB).toHaveLength(1);
    expect(historyA[0].httpStatus).toBe(200);
    expect(historyB[0].httpStatus).toBe(500);
  });

  it("returns an empty array when a domain has no snapshots", () => {
    const db = createTestDb();
    const domainId = setupDomain(db);
    expect(getHttpHistory(domainId, 10, db)).toEqual([]);
  });
});

describe("foreign key cascade", () => {
  it("deletes snapshots when the domain is deleted", () => {
    const db = createTestDb();
    const domainId = setupDomain(db);
    createHttpSnapshot(checkData(domainId), db);

    db.delete(domains).where(eq(domains.id, domainId)).run();

    expect(db.select().from(httpSnapshots).all()).toHaveLength(0);
  });
});
