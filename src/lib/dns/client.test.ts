import { describe, expect, it, vi } from "vitest";
import { DnsError, parseDoHResponse, queryDnsRecords } from "./client";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/dns-json" },
  });
}

type MockFetch = typeof fetch & { mock: ReturnType<typeof vi.fn>["mock"] };

function fetchMock(handler: (url: string) => Response | Promise<Response>): MockFetch {
  return vi.fn(handler) as unknown as MockFetch;
}

describe("queryDnsRecords", () => {
  it("queries the DoH endpoint with the correct type number and Accept header", async () => {
    const fetchFn = fetchMock(() => jsonResponse({ Status: 0, Answer: [] }));
    await queryDnsRecords("example.com", "MX", { fetchFn });

    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("name=example.com");
    expect(url).toContain("type=15"); // MX
    expect((init.headers as Record<string, string>).Accept).toBe("application/dns-json");
  });

  it("uses the configured endpoint instead of the default", async () => {
    const fetchFn = fetchMock(() => jsonResponse({ Status: 0, Answer: [] }));
    await queryDnsRecords("example.com", "A", { fetchFn, endpoint: "https://dns.google/resolve" });
    expect((fetchFn.mock.calls[0] as [string])[0]).toContain("https://dns.google/resolve");
  });

  it("parses A answers into canonical records", async () => {
    const fetchFn = fetchMock(() =>
      jsonResponse({
        Status: 0,
        Answer: [
          { name: "example.com", type: 1, TTL: 300, data: "1.2.3.4" },
          { name: "example.com", type: 1, TTL: 300, data: "5.6.7.8" },
        ],
      }),
    );
    const records = await queryDnsRecords("example.com", "A", { fetchFn });
    expect(records).toEqual([
      { type: "A", name: "example.com", value: "1.2.3.4", ttl: 300 },
      { type: "A", name: "example.com", value: "5.6.7.8", ttl: 300 },
    ]);
  });

  it("parses MX answers with priority", async () => {
    const fetchFn = fetchMock(() =>
      jsonResponse({
        Status: 0,
        Answer: [{ name: "example.com", type: 15, TTL: 70, data: "10 mail.example.com." }],
      }),
    );
    const records = await queryDnsRecords("example.com", "MX", { fetchFn });
    expect(records).toEqual([
      { type: "MX", name: "example.com", value: "mail.example.com", priority: 10, ttl: 70 },
    ]);
  });

  it("ignores answers of other types in the response", async () => {
    const fetchFn = fetchMock(() =>
      jsonResponse({
        Status: 0,
        Answer: [
          { name: "example.com", type: 5, TTL: 60, data: "target.example.net." },
          { name: "example.com", type: 1, TTL: 300, data: "1.2.3.4" },
        ],
      }),
    );
    const records = await queryDnsRecords("example.com", "A", { fetchFn });
    expect(records).toHaveLength(1);
    expect(records[0].value).toBe("1.2.3.4");
  });

  it("returns an empty array for NXDOMAIN (status 3)", async () => {
    const fetchFn = fetchMock(() => jsonResponse({ Status: 3, Answer: [] }));
    const records = await queryDnsRecords("doesnotexist.example.com", "A", { fetchFn });
    expect(records).toEqual([]);
  });

  it("throws a resolver error on SERVFAIL (status 2)", async () => {
    const fetchFn = fetchMock(() => jsonResponse({ Status: 2, Answer: [] }));
    await expect(queryDnsRecords("example.com", "A", { fetchFn })).rejects.toMatchObject({
      name: "DnsError",
      code: "resolver-error",
    });
  });

  it("throws a network error when fetch rejects", async () => {
    const fetchFn = fetchMock(() => Promise.reject(new Error("ECONNREFUSED")));
    await expect(queryDnsRecords("example.com", "A", { fetchFn })).rejects.toMatchObject({
      name: "DnsError",
      code: "network",
    });
  });

  it("throws a timeout error on abort", async () => {
    const fetchFn = fetchMock(() => Promise.reject(new DOMException("timeout", "TimeoutError")));
    await expect(queryDnsRecords("example.com", "A", { fetchFn })).rejects.toMatchObject({
      name: "DnsError",
      code: "timeout",
    });
  });

  it("throws an invalid-response error on non-JSON bodies", async () => {
    const fetchFn = fetchMock(() => new Response("<html>", { status: 200 }));
    await expect(queryDnsRecords("example.com", "A", { fetchFn })).rejects.toMatchObject({
      name: "DnsError",
      code: "invalid-response",
    });
  });

  it("throws a network error on HTTP 500", async () => {
    const fetchFn = fetchMock(() => new Response("oops", { status: 500 }));
    await expect(queryDnsRecords("example.com", "A", { fetchFn })).rejects.toMatchObject({
      name: "DnsError",
      code: "network",
    });
  });
});

describe("parseDoHResponse", () => {
  it("accepts only records of the requested type", () => {
    const records = parseDoHResponse(
      {
        Status: 0,
        Answer: [
          { name: "example.com.", type: 2, TTL: 100, data: "ns1.example.com." },
          { name: "example.com.", type: 2, TTL: 100, data: "ns2.example.com." },
        ],
      },
      "example.com",
      "NS",
    );
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ type: "NS", value: "ns1.example.com" });
  });

  it("normalizes the owner name from the query hostname", () => {
    const records = parseDoHResponse(
      { Status: 0, Answer: [{ name: "EXAMPLE.COM.", type: 1, TTL: 60, data: "1.2.3.4" }] },
      "example.com",
      "A",
    );
    expect(records[0].name).toBe("example.com");
  });

  it("skips malformed answers instead of failing the query", () => {
    const records = parseDoHResponse(
      {
        Status: 0,
        Answer: [
          { name: "example.com", type: 1, TTL: 60, data: "not-an-ip" },
          { name: "example.com", type: 1, TTL: 60, data: "1.2.3.4" },
        ],
      },
      "example.com",
      "A",
    );
    expect(records).toHaveLength(1);
    expect(records[0].value).toBe("1.2.3.4");
  });

  it("treats a missing Answer array as an empty result", () => {
    expect(parseDoHResponse({ Status: 0 }, "example.com", "A")).toEqual([]);
  });

  it("throws on a non-object response", () => {
    expect(() => parseDoHResponse("nope", "example.com", "A")).toThrow(DnsError);
  });
});
