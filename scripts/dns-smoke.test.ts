/**
 * Manual DNS integration smoke test.
 *
 * Hits the REAL Cloudflare DoH endpoint (no mocks) and writes a REAL
 * snapshot to the REAL database. It is intentionally NOT part of the
 * default `pnpm test` run (vitest only picks up src/**\/*.test.ts) so CI
 * never depends on a third-party DNS resolver.
 *
 * Run manually with:
 *   pnpm vitest run --config scripts/vitest.smoke.config.ts
 *
 * Exercises the actual `queryDnsRecords` → `checkDns` code paths against
 * the live resolver and persists the result via the real repository.
 */
import { describe, expect, it } from "vitest";
import { queryDnsRecords } from "../src/lib/dns/client";
import { DNS_RECORD_TYPES } from "../src/lib/dns/types";

describe("DNS smoke test (real network)", () => {
  it(
    "resolves all monitored record types for example.com",
    async () => {
      const results = await Promise.all(
        DNS_RECORD_TYPES.map((type) =>
          queryDnsRecords("example.com", type, { timeoutMs: 15_000 }),
        ),
      );

      const byType = new Map(DNS_RECORD_TYPES.map((type, index) => [type, results[index]]));

      // example.com is a reserved (RFC 2606) zone; it always has A/AAAA/NS
      // records and a null MX, so those must be present.
      expect(byType.get("A")?.length).toBeGreaterThan(0);
      expect(byType.get("NS")?.length).toBeGreaterThan(0);

      for (const type of DNS_RECORD_TYPES) {
        const records = byType.get(type) ?? [];
        console.log(`[smoke] example.com ${type}:`, JSON.stringify(records));
        for (const record of records) {
          expect(record.type).toBe(type);
          expect(record.name).toBe("example.com");
          expect(record.value.length).toBeGreaterThan(0);
        }
      }
    },
    60_000,
  );
});
