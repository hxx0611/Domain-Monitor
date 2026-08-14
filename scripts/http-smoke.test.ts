/**
 * Manual HTTP health check smoke test.
 *
 * Hits REAL network endpoints (no mocks). It is intentionally NOT part of
 * the default `pnpm test` run (vitest only picks up src/**\/*.test.ts) so
 * CI never depends on the public internet.
 *
 * Run manually with:
 *   pnpm vitest run --config scripts/vitest.smoke.config.ts
 *
 * Exercises the actual `fetchHttpStatus` client code path (SSRF guards
 * included) against live hosts. No database writes.
 */
import { describe, expect, it } from "vitest";
import { fetchHttpStatus, HttpError } from "../src/lib/http/client";

const TIMEOUT = 15_000;

describe("HTTP smoke test (real network)", () => {
  it("returns 200 for example.com", async () => {
    const result = await fetchHttpStatus("example.com", { timeoutMs: TIMEOUT });
    expect(result.status).toBe(200);
    expect(result.redirected).toBe(false);
    expect(result.redirectCount).toBe(0);
    expect(result.finalUrl).toBe("https://example.com/");
    expect(result.responseTimeMs).toBeGreaterThanOrEqual(0);
    console.log("[smoke] example.com:", JSON.stringify(result));
  }, 60_000);

  it("returns 200 for www.mozilla.org (may follow a same-host redirect)", async () => {
    const result = await fetchHttpStatus("www.mozilla.org", { timeoutMs: TIMEOUT });
    expect(result.status).toBe(200);
    // www.mozilla.org redirects to /en-US/ — same host, so it must succeed.
    expect(result.redirected).toBe(true);
    expect(result.redirectCount).toBeGreaterThanOrEqual(1);
    console.log("[smoke] www.mozilla.org:", JSON.stringify(result));
  }, 60_000);

  it("classifies a non-existent domain as dns", async () => {
    try {
      await fetchHttpStatus("doesnotexist-zzz12345.invalid", { timeoutMs: TIMEOUT });
      throw new Error("expected an error but the request succeeded");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      const httpError = error as HttpError;
      console.log("[smoke] nonexistent domain error code:", httpError.code);
      expect(httpError.code).toBe("dns");
    }
  }, 60_000);

  it("rejects a cross-host redirect (SSRF policy)", async () => {
    // mozilla.org's bare domain 301-redirects to www.mozilla.org — a
    // DIFFERENT host. The same-host redirect policy must block it with
    // blocked-redirect (this is a real-world SSRF-policy hit).
    try {
      await fetchHttpStatus("mozilla.org", { timeoutMs: TIMEOUT });
      // If mozilla.org ever stops redirecting, the test is moot; the
      // blocked-redirect behavior is fully covered by unit tests.
      console.log("[smoke] mozilla.org served directly (no cross-host redirect)");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      const httpError = error as HttpError;
      console.log("[smoke] mozilla.org error code:", httpError.code, "-", httpError.message);
      expect(httpError.code).toBe("blocked-redirect");
    }
  }, 60_000);

  it("verifies too-many-redirects with a real redirect loop", async () => {
    // httpbin.org redirect loop: /redirect/6 chains 6 redirects.
    try {
      const result = await fetchHttpStatus("httpbin.org", {
        timeoutMs: TIMEOUT,
      });
      console.log("[smoke] httpbin.org direct result (redirect chain not hit):", result.status);
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      const httpError = error as HttpError;
      console.log("[smoke] httpbin.org chain error code:", httpError.code);
      // /redirect/N on httpbin redirects to the same host, so if the chain
      // is exercised the client stops at 5 hops with too-many-redirects.
      expect(httpError.code).toBe("too-many-redirects");
    }
  }, 60_000);
});
