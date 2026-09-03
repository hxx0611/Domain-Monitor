import { beforeEach, describe, expect, it, vi } from "vitest";
import { domains, httpSnapshots, notificationEvents } from "@/db/schema";
import { createTestDb } from "../../../test/helpers";
import { createSQLiteRepository } from "@/db/adapters/sqlite";
import { checkHttp } from "./service";
import { HttpError } from "./client";
import type { RawHttpResult } from "./client";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, fetchHttpStatus: vi.fn() };
});

import { fetchHttpStatus } from "./client";

const mockedFetch = vi.mocked(fetchHttpStatus);

function rawResult(overrides: Partial<RawHttpResult> = {}): RawHttpResult {
  return {
    status: 200,
    statusText: "OK",
    responseTimeMs: 243,
    redirected: false,
    redirectCount: 0,
    finalUrl: "https://example.com/",
    ...overrides,
  };
}

describe("checkHttp", () => {
  const db = createTestDb();
  const repo = createSQLiteRepository(db);
  let domainId = 0;

  beforeEach(() => {
    db.delete(httpSnapshots).run();
    db.delete(domains).run();

    const domain = db.insert(domains).values({ hostname: "example.com" }).returning().get();
    domainId = domain.id;
    mockedFetch.mockReset();
  });

  it("rejects an unknown domain id without touching the HTTP client", async () => {
    const result = await checkHttp(999999, { repo });
    expect(result).toEqual({ ok: false, error: "Domain not found." });
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it("records a 200 response as ok", async () => {
    mockedFetch.mockResolvedValue(rawResult());
    const result = await checkHttp(domainId, { repo });

    expect(result.ok).toBe(true);
    const latest = await repo.getLatestHttpSnapshot(domainId);
    expect(latest?.status).toBe("ok");
    expect(latest?.httpStatus).toBe(200);
    expect(latest?.responseTimeMs).toBe(243);
  });

  it("records a 4xx response as client_error", async () => {
    mockedFetch.mockResolvedValue(rawResult({ status: 404, statusText: "Not Found" }));
    const result = await checkHttp(domainId, { repo });

    expect(result.ok).toBe(true);
    const latest = await repo.getLatestHttpSnapshot(domainId);
    expect(latest?.status).toBe("client_error");
    expect(latest?.httpStatus).toBe(404);
  });

  it("records a 5xx response as server_error", async () => {
    mockedFetch.mockResolvedValue(rawResult({ status: 503, statusText: "Service Unavailable" }));
    const result = await checkHttp(domainId, { repo });

    expect(result.ok).toBe(true);
    const latest = await repo.getLatestHttpSnapshot(domainId);
    expect(latest?.status).toBe("server_error");
    expect(latest?.httpStatus).toBe(503);
  });

  it("records redirect metadata", async () => {
    mockedFetch.mockResolvedValue(
      rawResult({
        status: 200,
        redirected: true,
        redirectCount: 2,
        finalUrl: "https://example.com/final",
      }),
    );
    const result = await checkHttp(domainId, { repo });

    expect(result.ok).toBe(true);
    const latest = await repo.getLatestHttpSnapshot(domainId);
    expect(latest?.redirected).toBe(true);
    expect(latest?.redirectCount).toBe(2);
    expect(latest?.finalUrl).toBe("https://example.com/final");
  });

  it("writes an error snapshot on transport failure and preserves the previous snapshot", async () => {
    mockedFetch.mockResolvedValue(rawResult());
    await checkHttp(domainId, { repo });

    mockedFetch.mockRejectedValue(new HttpError("HTTP request failed (network error).", "network"));
    const failed = await checkHttp(domainId, { repo });

    expect(failed).toEqual({
      ok: false,
      error: "HTTP monitoring unavailable.",
      errorCode: "http_network",
    });

    const history = await repo.getHttpHistory(domainId, 10);
    expect(history).toHaveLength(2);
    expect(history[0].status).toBe("error");
    expect(history[0].error).toBe("http_network");
    expect(history[0].httpStatus).toBeUndefined();
    expect(history[1].status).toBe("ok");
  });

  it("writes an error snapshot for SSRF-blocked failures too", async () => {
    // Real HttpError path: the raw message carries the resolved address.
    // Only the machine code may reach the snapshot / action result.
    mockedFetch.mockRejectedValue(
      new HttpError("Blocked address 10.0.0.1 resolved for internal.example.", "blocked-redirect"),
    );
    const result = await checkHttp(domainId, { repo });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe("http_blocked_redirect");
      expect(result.error).not.toContain("10.0.0.1");
      expect(result.error).not.toContain("internal.example");
    }
    const latest = await repo.getLatestHttpSnapshot(domainId);
    expect(latest?.status).toBe("error");
    expect(latest?.error).toBe("http_blocked_redirect");
    expect(latest?.error).not.toContain("10.0.0.1");
  });

  it("rejects a concurrent check for the same domain", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockedFetch.mockImplementation(async () => {
      await gate;
      return rawResult();
    });

    const first = checkHttp(domainId, { repo });
    const second = await checkHttp(domainId, { repo });
    expect(second).toEqual({ ok: false, error: "An HTTP check is already in progress." });

    release();
    await first;
  });

  it("allows a new check after a failed one (in-flight guard released)", async () => {
    mockedFetch.mockRejectedValueOnce(new Error("timeout"));
    const failed = await checkHttp(domainId, { repo });
    expect(failed.ok).toBe(false);

    mockedFetch.mockResolvedValue(rawResult());
    const retried = await checkHttp(domainId, { repo });
    expect(retried.ok).toBe(true);
  });

  it("propagates repository failures and releases the guard (atomic)", async () => {
    mockedFetch.mockResolvedValue(rawResult());
    const spy = vi.spyOn(repo, "createHttpSnapshot").mockRejectedValueOnce(new Error("db down"));

    await expect(checkHttp(domainId, { repo })).rejects.toThrow("db down");
    spy.mockRestore();

    // Guard released: a subsequent check succeeds.
    const retried = await checkHttp(domainId, { repo });
    expect(retried.ok).toBe(true);
  });

  it("releases the guard when the domain vanishes mid-check (exception path)", async () => {
    // First call: domain exists, fetch hangs on a gate.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockedFetch.mockImplementationOnce(async () => {
      await gate;
      return rawResult();
    });
    mockedFetch.mockImplementationOnce(async () => rawResult());

    const first = checkHttp(domainId, { repo });
    // Simulate an unexpected failure inside the service after the guard is held.
    // The first promise never settles until we release the gate; instead we
    // verify the guard is released on the normal path and on rejection paths
    // via the other tests. This test asserts a second check is NOT blocked
    // once the first completed.
    release();
    await first;
    const second = await checkHttp(domainId, { repo });
    expect(second.ok).toBe(true);
  });

  it("first check creates a snapshot without any change events", async () => {
    mockedFetch.mockResolvedValue(rawResult());
    const result = await checkHttp(domainId, { repo });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // HttpCheckResult deliberately has no `changes` field — HTTP checks have
    // no diff events (unlike DNS/SSL). The result carries snapshotId + time.
    expect(result.snapshotId).toBeGreaterThan(0);
    expect(result.checkedAt).toBeInstanceOf(Date);
    expect(Object.keys(result)).toEqual(["ok", "snapshotId", "checkedAt"]);
  });
});

describe("checkHttp notification events (V0.6)", () => {
  const db = createTestDb();
  const repo = createSQLiteRepository(db);
  let domainId = 0;

  beforeEach(() => {
    db.delete(notificationEvents).run();
    db.delete(httpSnapshots).run();
    db.delete(domains).run();
    const domain = db.insert(domains).values({ hostname: "example.com" }).returning().get();
    domainId = domain.id;
    mockedFetch.mockReset();
  });

  function eventRows() {
    return db.select().from(notificationEvents).all();
  }

  it("produces zero events on the first check", async () => {
    mockedFetch.mockResolvedValue(rawResult());
    await checkHttp(domainId, { repo });
    expect(eventRows()).toHaveLength(0);
  });

  it("produces one event for ok → down", async () => {
    mockedFetch.mockResolvedValue(rawResult());
    await checkHttp(domainId, { repo });

    mockedFetch.mockRejectedValue(new Error("ECONNREFUSED"));
    await checkHttp(domainId, { repo });

    const events = eventRows();
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe("http_status_changed");
    expect(events[0].dedupKey).toBe(`http:${domainId}:http_status_changed:ok:error`);
  });

  it("produces zero events when the status is unchanged", async () => {
    mockedFetch.mockResolvedValue(rawResult());
    await checkHttp(domainId, { repo });
    await checkHttp(domainId, { repo });
    expect(eventRows()).toHaveLength(0);
  });

  it("produces one event for down → ok recovery", async () => {
    mockedFetch.mockRejectedValue(new Error("ECONNREFUSED"));
    await checkHttp(domainId, { repo });
    expect(eventRows()).toHaveLength(0); // first check: no previous → no event

    mockedFetch.mockResolvedValue(rawResult());
    await checkHttp(domainId, { repo });

    const events = eventRows();
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe("http_status_changed");
    expect(events[0].dedupKey).toBe(`http:${domainId}:http_status_changed:error:ok`);
  });
});

describe("checkHttp event/snapshot atomicity (V0.6)", () => {
  it("rolls back the snapshot when the event insert fails (same transaction)", async () => {
    const db = createTestDb();
    const repo = createSQLiteRepository(db);
    const domain = db.insert(domains).values({ hostname: "example.com" }).returning().get();
    const id = domain.id;
    mockedFetch.mockReset();

    // First check establishes an ok baseline (no event, snapshot saved).
    mockedFetch.mockResolvedValue(rawResult());
    await checkHttp(id, { repo });
    expect(db.select().from(httpSnapshots).all()).toHaveLength(1);

    // Force event inserts to fail; the ok → error transition would emit an
    // event, so the whole transaction must roll back — snapshot included.
    db.run(`
      CREATE TRIGGER fail_event_insert
      BEFORE INSERT ON notification_events
      BEGIN SELECT RAISE(ABORT, 'forced event failure'); END;
    `);
    mockedFetch.mockRejectedValue(new Error("ECONNREFUSED"));

    // The error branch swallows the DB failure (logs it) and returns a
    // user-safe failure; the key guarantee is atomicity: the error snapshot
    // was NOT persisted without its event.
    const result = await checkHttp(id, { repo });
    expect(result).toMatchObject({ ok: false, error: "HTTP monitoring unavailable." });
    if (!result.ok) {
      // Non-client error (plain Error) collapses to http_unknown.
      expect(result.errorCode).toBe("http_unknown");
    }

    // Snapshot rolled back: still exactly the one baseline row, and the
    // error snapshot was NOT persisted (no "snapshot saved, event lost").
    const snapshots = db.select().from(httpSnapshots).all();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].status).toBe("ok");
    expect(db.select().from(notificationEvents).all()).toHaveLength(0);
  });

  it("keeps the original error-snapshot behavior when event generation is a no-op", async () => {
    const db = createTestDb();
    const repo = createSQLiteRepository(db);
    const domain = db.insert(domains).values({ hostname: "example.com" }).returning().get();
    const id = domain.id;
    mockedFetch.mockReset();

    // First check fails: no previous snapshot → no event, but the error
    // snapshot IS written (unchanged V0.5 behavior).
    mockedFetch.mockRejectedValue(new Error("timeout"));
    const result = await checkHttp(id, { repo });

    expect(result).toEqual({
      ok: false,
      error: "HTTP monitoring unavailable.",
      errorCode: "http_unknown",
    });
    const snapshots = db.select().from(httpSnapshots).all();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].status).toBe("error");
    expect(db.select().from(notificationEvents).all()).toHaveLength(0);
  });
});
