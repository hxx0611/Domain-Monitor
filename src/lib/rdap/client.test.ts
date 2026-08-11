import { describe, expect, it, vi } from "vitest";
import { fetchRdapDomain, RdapError } from "./client";

const BASE_URL = "https://rdap.example/v1/";
const HOSTNAME = "example.com";
const EXPECTED_URL = "https://rdap.example/v1/domain/example.com";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/rdap+json" },
  });
}

function mockFetch(resolver: (url: string, init?: RequestInit) => Response | Promise<Response>): {
  fetchFn: typeof fetch;
} {
  const fetchFn = vi.fn(resolver) as unknown as typeof fetch;
  return { fetchFn };
}

describe("fetchRdapDomain", () => {
  it("requests the RDAP domain URL and returns parsed JSON", async () => {
    const { fetchFn } = mockFetch((url, init) => {
      expect(url).toBe(EXPECTED_URL);
      expect(init?.headers).toMatchObject({ Accept: "application/rdap+json, application/json" });
      return jsonResponse({ ldhName: "example.com" });
    });

    const raw = await fetchRdapDomain(BASE_URL, HOSTNAME, { fetchFn });
    expect(raw).toEqual({ ldhName: "example.com" });
  });

  it("handles a base URL without a trailing slash", async () => {
    const { fetchFn } = mockFetch((url) => {
      expect(url).toBe(EXPECTED_URL);
      return jsonResponse({});
    });
    await fetchRdapDomain("https://rdap.example/v1", HOSTNAME, { fetchFn });
  });

  it("throws not-found on HTTP 404", async () => {
    const { fetchFn } = mockFetch(() => jsonResponse({}, 404));
    await expect(fetchRdapDomain(BASE_URL, HOSTNAME, { fetchFn })).rejects.toMatchObject({
      code: "not-found",
    });
  });

  it("throws rate-limited on HTTP 429", async () => {
    const { fetchFn } = mockFetch(() => jsonResponse({}, 429));
    await expect(fetchRdapDomain(BASE_URL, HOSTNAME, { fetchFn })).rejects.toMatchObject({
      code: "rate-limited",
    });
  });

  it("throws server-error on HTTP 5xx", async () => {
    for (const status of [500, 502, 503]) {
      const { fetchFn } = mockFetch(() => jsonResponse({}, status));
      await expect(fetchRdapDomain(BASE_URL, HOSTNAME, { fetchFn })).rejects.toMatchObject({
        code: "server-error",
      });
    }
  });

  it("throws timeout when the fetch is aborted", async () => {
    const { fetchFn } = mockFetch(() => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    });
    await expect(fetchRdapDomain(BASE_URL, HOSTNAME, { fetchFn })).rejects.toMatchObject({
      code: "timeout",
    });
  });

  it("throws network on other fetch failures", async () => {
    const { fetchFn } = mockFetch(() => {
      throw new TypeError("fetch failed");
    });
    await expect(fetchRdapDomain(BASE_URL, HOSTNAME, { fetchFn })).rejects.toMatchObject({
      code: "network",
    });
  });

  it("throws invalid-response when JSON parsing fails", async () => {
    const fetchFn = vi.fn(async () => new Response("<html>not json</html>", { status: 200 }));
    await expect(fetchRdapDomain(BASE_URL, HOSTNAME, { fetchFn })).rejects.toMatchObject({
      code: "invalid-response",
    });
  });

  it("propagates typed errors as RdapError instances", async () => {
    const { fetchFn } = mockFetch(() => jsonResponse({}, 404));
    try {
      await fetchRdapDomain(BASE_URL, HOSTNAME, { fetchFn });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(RdapError);
      expect((error as RdapError).code).toBe("not-found");
    }
  });
});
