/**
 * Manual RDAP integration smoke test.
 *
 * This test hits the REAL IANA bootstrap and REAL RDAP registries, and
 * writes to the REAL SQLite database. It is intentionally NOT part of the
 * default `pnpm test` run (vitest only picks up src/**\/*.test.ts) so CI
 * never depends on third-party RDAP services.
 *
 * Run manually with:
 *   pnpm vitest run scripts/rdap-smoke.test.ts
 *
 * It exercises the actual `queryRdap` service code path (bootstrap lookup →
 * HTTP request → parse) and persists the result through the same SQL that
 * `updateDomainRdap` issues.
 */
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { queryRdap } from "../src/lib/rdap/service";

const DB_PATH = "data/domain-monitor.db";

describe("RDAP smoke test (real network + real DB)", () => {
  it("queries example.com through the real bootstrap and stores the result", async () => {
    const data = await queryRdap("example.com", { timeoutMs: 15_000 });

    expect(data.domainName.toLowerCase()).toBe("example.com");
    expect(data.expirationDate).toBeTruthy();
    expect(data.registrationDate).toBeTruthy();

    // Persist through the same SQL updateDomainRdap generates.
    // Note: the Drizzle schema stores timestamps as unix SECONDS, so the
    // raw insert below must use seconds too (not Date.now() ms) — otherwise
    // the row renders as a year-58580 date in the UI.
    const nowSec = Math.floor(Date.now() / 1000);
    const db = new Database(DB_PATH);
    const info = db
      .prepare(
        "INSERT INTO domains (hostname, status, created_at, updated_at) VALUES (?, 'active', ?, ?)",
      )
      .run("smoke.example.com", nowSec, nowSec);
    const id = Number(info.lastInsertRowid);

    db.prepare(
      `UPDATE domains SET
         registrar = ?, registration_date = ?, expiration_date = ?,
         updated_date = ?, rdap_updated_at = ?, nameservers = ?, rdap_status = ?
       WHERE id = ?`,
    ).run(
      data.registrar ?? null,
      data.registrationDate ?? null,
      data.expirationDate ?? null,
      data.updatedDate ?? null,
      nowSec,
      JSON.stringify(data.nameservers),
      JSON.stringify(data.status),
      id,
    );

    const row = db.prepare("SELECT * FROM domains WHERE id = ?").get(id) as Record<
      string,
      unknown
    >;
    expect(row.registrar).toBeTruthy();
    expect(row.expiration_date).toBe(data.expirationDate);
    expect(JSON.parse(String(row.nameservers))).toEqual(data.nameservers);

    // Clean up the smoke row.
    db.prepare("DELETE FROM domains WHERE id = ?").run(id);
    db.close();

    // Keep the human-readable result visible in the test output.
    console.log("\n[smoke] example.com RDAP data:", JSON.stringify(data, null, 2));
  }, 30_000);
});
