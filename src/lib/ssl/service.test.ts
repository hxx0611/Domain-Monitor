import { beforeEach, describe, expect, it, vi } from "vitest";
import { domains, sslCertificates, sslSnapshots, notificationEvents } from "@/db/schema";
import { createTestDb } from "../../../test/helpers";
import { createSQLiteRepository } from "@/db/adapters/sqlite";
import { checkSsl } from "./service";
import { SslError } from "./client";
import type { RawSslResult } from "./client";
import type { RawCertificateLike } from "./normalize";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, fetchSslCertificate: vi.fn() };
});

import { fetchSslCertificate } from "./client";

const mockedFetch = vi.mocked(fetchSslCertificate);

/** Raw certificate with dates relative to "now" for deterministic status. */
function rawCert(
  overrides: Partial<RawCertificateLike> & { validToDate?: Date } = {},
): RawCertificateLike {
  const { validToDate, ...rest } = overrides;
  return {
    fingerprint256: "AA:BB:CC:DD",
    subject: "CN=example.com",
    issuer: "CN=Test CA",
    validFrom: "Jan 1 00:00:00 2026 GMT",
    validTo: (validToDate ?? new Date(Date.now() + 90 * 86_400_000)).toISOString(),
    serialNumber: "01",
    subjectAltName: "DNS:example.com",
    ca: false,
    checkHost: (hostname: string) => (hostname === "example.com" ? "DNS:example.com" : undefined),
    ...rest,
  };
}

function rawResult(overrides: Partial<RawSslResult> = {}): RawSslResult {
  return {
    certificate: rawCert(),
    tlsVersion: "TLSv1.3",
    cipherName: "TLS_AES_256_GCM_SHA384",
    ...overrides,
  };
}

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 86_400_000);
}

describe("checkSsl", () => {
  const db = createTestDb();
  const repo = createSQLiteRepository(db);
  let domainId = 0;

  beforeEach(() => {
    db.delete(sslCertificates).run();
    db.delete(sslSnapshots).run();
    db.delete(domains).run();

    const domain = db.insert(domains).values({ hostname: "example.com" }).returning().get();
    domainId = domain.id;
    mockedFetch.mockReset();
  });

  it("rejects an unknown domain id without touching the TLS client", async () => {
    const result = await checkSsl(999999, { repo });
    expect(result).toEqual({ ok: false, error: "Domain not found." });
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it("creates a first successful snapshot without change events", async () => {
    mockedFetch.mockResolvedValue(rawResult());
    const result = await checkSsl(domainId, { repo });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changes).toEqual([]);

    const latest = await repo.getLatestSslSnapshot(domainId);
    expect(latest?.status).toBe("ok");
    expect(latest?.tlsVersion).toBe("TLSv1.3");
    expect(latest?.certificate?.fingerprint256).toBe("AA:BB:CC:DD");
  });

  it("reports no changes on a second check with the same fingerprint", async () => {
    mockedFetch.mockResolvedValue(rawResult());
    await checkSsl(domainId, { repo });

    const second = await checkSsl(domainId, { repo });
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.changes).toEqual([]);
    }
  });

  it("reports CERT_REPLACED when the certificate changes", async () => {
    mockedFetch.mockResolvedValue(rawResult());
    await checkSsl(domainId, { repo });

    mockedFetch.mockResolvedValue(
      rawResult({ certificate: rawCert({ fingerprint256: "EE:FF:00:11" }) }),
    );
    const second = await checkSsl(domainId, { repo });

    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.changes).toEqual([
        {
          type: "CERT_REPLACED",
          previousFingerprint: "AA:BB:CC:DD",
          currentFingerprint: "EE:FF:00:11",
        },
      ]);
    }
  });

  it("stores an expired certificate with status expired", async () => {
    mockedFetch.mockResolvedValue(
      rawResult({ certificate: rawCert({ validToDate: daysFromNow(-5) }) }),
    );
    const result = await checkSsl(domainId, { repo });

    expect(result.ok).toBe(true);
    const latest = await repo.getLatestSslSnapshot(domainId);
    expect(latest?.status).toBe("expired");
  });

  it("stores a soon-to-expire certificate with status expires_soon", async () => {
    mockedFetch.mockResolvedValue(
      rawResult({ certificate: rawCert({ validToDate: daysFromNow(10) }) }),
    );
    const result = await checkSsl(domainId, { repo });

    expect(result.ok).toBe(true);
    const latest = await repo.getLatestSslSnapshot(domainId);
    expect(latest?.status).toBe("expires_soon");
  });

  it("stores a hostname mismatch snapshot without blocking", async () => {
    mockedFetch.mockResolvedValue(
      rawResult({
        certificate: rawCert({ checkHost: () => undefined }),
      }),
    );
    const result = await checkSsl(domainId, { repo });

    // Mismatch must NOT fail the check or block the write.
    expect(result.ok).toBe(true);
    const latest = await repo.getLatestSslSnapshot(domainId);
    expect(latest?.status).toBe("mismatch");
    expect(latest?.certificate?.hostnameMatched).toBe(false);
  });

  it("writes an error snapshot on TLS failure and preserves the previous certificate", async () => {
    mockedFetch.mockResolvedValue(rawResult());
    await checkSsl(domainId, { repo });

    mockedFetch.mockRejectedValue(new SslError("No TLS service on port 443.", "no-tls-service"));
    const failed = await checkSsl(domainId, { repo });

    expect(failed).toEqual({
      ok: false,
      error: "SSL monitoring unavailable.",
      errorCode: "ssl_no_tls_service",
    });

    // History now has [error snapshot, previous success] — certificate intact.
    const history = await repo.getSslHistory(domainId, 10);
    expect(history).toHaveLength(2);
    expect(history[0].status).toBe("error");
    expect(history[0].error).toBe("ssl_no_tls_service");
    expect(history[0].certificate).toBeUndefined();
    expect(history[1].status).toBe("ok");
    expect(history[1].certificate?.fingerprint256).toBe("AA:BB:CC:DD");
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

    const first = checkSsl(domainId, { repo });
    const second = await checkSsl(domainId, { repo });
    expect(second).toEqual({ ok: false, error: "An SSL check is already in progress." });

    release();
    await first;
  });

  it("allows a new check after a failed one (in-flight guard released)", async () => {
    mockedFetch.mockRejectedValueOnce(new Error("timeout"));
    const failed = await checkSsl(domainId, { repo });
    expect(failed.ok).toBe(false);

    mockedFetch.mockResolvedValue(rawResult());
    const retried = await checkSsl(domainId, { repo });
    expect(retried.ok).toBe(true);
  });

  it("propagates repository failures and releases the guard (atomic)", async () => {
    mockedFetch.mockResolvedValue(rawResult());
    const spy = vi.spyOn(repo, "createSslSnapshot").mockRejectedValueOnce(new Error("db down"));

    await expect(checkSsl(domainId, { repo })).rejects.toThrow("db down");
    spy.mockRestore();

    // Guard released: a subsequent check succeeds.
    const retried = await checkSsl(domainId, { repo });
    expect(retried.ok).toBe(true);
  });

  it("rolls back the whole snapshot when the certificate insert fails (DB atomicity)", async () => {
    mockedFetch.mockResolvedValue(rawResult());

    // Force certificate inserts to fail inside the transaction.
    db.run(`
      CREATE TRIGGER fail_cert_insert
      BEFORE INSERT ON ssl_certificates
      BEGIN SELECT RAISE(ABORT, 'forced failure'); END;
    `);

    await expect(checkSsl(domainId, { repo })).rejects.toThrow("forced failure");

    db.run("DROP TRIGGER fail_cert_insert");

    // The snapshot insert was rolled back with the certificate insert.
    expect(db.select().from(sslSnapshots).all()).toHaveLength(0);
    expect(db.select().from(sslCertificates).all()).toHaveLength(0);
  });
});

describe("checkSsl notification events (V0.6)", () => {
  const db = createTestDb();
  const repo = createSQLiteRepository(db);
  let domainId = 0;

  beforeEach(() => {
    db.delete(notificationEvents).run();
    db.delete(sslCertificates).run();
    db.delete(sslSnapshots).run();
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
    await checkSsl(domainId, { repo });
    expect(eventRows()).toHaveLength(0);
  });

  it("produces one event when the certificate is replaced", async () => {
    mockedFetch.mockResolvedValue(rawResult());
    await checkSsl(domainId, { repo });

    mockedFetch.mockResolvedValue(
      rawResult({ certificate: rawCert({ fingerprint256: "EE:FF:00:11" }) }),
    );
    await checkSsl(domainId, { repo });

    const events = eventRows();
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe("ssl_cert_replaced");
    expect(events[0].dedupKey).toContain("AA:BB:CC:DD");
    expect(events[0].dedupKey).toContain("EE:FF:00:11");
  });

  it("produces one event when the SSL status changes", async () => {
    mockedFetch.mockResolvedValue(rawResult());
    await checkSsl(domainId, { repo });

    mockedFetch.mockResolvedValue(
      rawResult({ certificate: rawCert({ validToDate: daysFromNow(10) }) }),
    );
    await checkSsl(domainId, { repo });

    const events = eventRows();
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe("ssl_status_changed");
    expect(events[0].dedupKey).toBe(`ssl:${domainId}:ssl_status_changed:ok:expires_soon`);
  });

  it("produces two events when cert replaced AND status changes together", async () => {
    mockedFetch.mockResolvedValue(rawResult());
    await checkSsl(domainId, { repo });

    mockedFetch.mockResolvedValue(
      rawResult({
        certificate: rawCert({ fingerprint256: "EE:FF:00:11", validToDate: daysFromNow(-5) }),
      }),
    );
    await checkSsl(domainId, { repo });

    const events = eventRows();
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.eventType).sort()).toEqual([
      "ssl_cert_replaced",
      "ssl_status_changed",
    ]);
  });

  it("produces zero events when nothing changed", async () => {
    mockedFetch.mockResolvedValue(rawResult());
    await checkSsl(domainId, { repo });
    await checkSsl(domainId, { repo });
    expect(eventRows()).toHaveLength(0);
  });
});
