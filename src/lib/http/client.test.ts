import { describe, expect, it, vi } from "vitest";
import {
  assertSafeHost,
  fetchHttpStatus,
  HttpError,
  isBlockedIp,
  isBlockedIpv4,
  isBlockedIpv6,
  resolveRedirectTarget,
} from "./client";

// ---------------------------------------------------------------------------
// SSRF guards — pure IP checks
// ---------------------------------------------------------------------------

describe("isBlockedIpv4", () => {
  it("blocks loopback", () => {
    expect(isBlockedIpv4("127.0.0.1")).toBe(true);
    expect(isBlockedIpv4("127.255.255.255")).toBe(true);
  });

  it("blocks private ranges", () => {
    expect(isBlockedIpv4("10.0.0.1")).toBe(true);
    expect(isBlockedIpv4("172.16.0.1")).toBe(true);
    expect(isBlockedIpv4("172.31.255.255")).toBe(true);
    expect(isBlockedIpv4("192.168.1.1")).toBe(true);
  });

  it("does not block public addresses adjacent to private ranges", () => {
    expect(isBlockedIpv4("172.15.0.1")).toBe(false);
    expect(isBlockedIpv4("172.32.0.1")).toBe(false);
    expect(isBlockedIpv4("192.169.0.1")).toBe(false);
    expect(isBlockedIpv4("11.0.0.1")).toBe(false);
  });

  it("blocks link-local, CGNAT and benchmark ranges", () => {
    expect(isBlockedIpv4("169.254.169.254")).toBe(true); // cloud metadata!
    expect(isBlockedIpv4("100.64.0.1")).toBe(true);
    expect(isBlockedIpv4("100.127.255.255")).toBe(true);
    expect(isBlockedIpv4("198.18.0.1")).toBe(true);
    expect(isBlockedIpv4("198.19.255.255")).toBe(true);
  });

  it("blocks multicast, reserved and broadcast", () => {
    expect(isBlockedIpv4("224.0.0.1")).toBe(true);
    expect(isBlockedIpv4("240.0.0.1")).toBe(true);
    expect(isBlockedIpv4("255.255.255.255")).toBe(true);
  });

  it("blocks invalid input defensively", () => {
    expect(isBlockedIpv4("not-an-ip")).toBe(true);
    expect(isBlockedIpv4("999.1.1.1")).toBe(true);
  });
});

describe("isBlockedIpv6", () => {
  it("blocks loopback and unspecified", () => {
    expect(isBlockedIpv6("::1")).toBe(true);
    expect(isBlockedIpv6("::")).toBe(true);
  });

  it("blocks ULA and link-local", () => {
    expect(isBlockedIpv6("fc00::1")).toBe(true);
    expect(isBlockedIpv6("fd12:3456::1")).toBe(true);
    expect(isBlockedIpv6("fe80::1")).toBe(true);
    expect(isBlockedIpv6("febf::1")).toBe(true);
  });

  it("does not block global unicast", () => {
    expect(isBlockedIpv6("2606:4700:10::6814:179a")).toBe(false);
    expect(isBlockedIpv6("2001:4860:4860::8888")).toBe(false);
  });

  it("blocks IPv4-mapped addresses by re-checking the embedded IPv4", () => {
    expect(isBlockedIpv6("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedIpv6("::ffff:10.0.0.1")).toBe(true);
    expect(isBlockedIpv6("::ffff:8.8.8.8")).toBe(false);
  });

  it("blocks NAT64 and documentation ranges", () => {
    expect(isBlockedIpv6("64:ff9b::1")).toBe(true);
    expect(isBlockedIpv6("2001:db8::1")).toBe(true);
  });
});

describe("isBlockedIp", () => {
  it("dispatches v4/v6 and blocks non-IP input", () => {
    expect(isBlockedIp("192.168.1.1")).toBe(true);
    expect(isBlockedIp("8.8.8.8")).toBe(false);
    expect(isBlockedIp("::1")).toBe(true);
    expect(isBlockedIp("2606:4700::1")).toBe(false);
    expect(isBlockedIp("garbage")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SSRF guards — host resolution
// ---------------------------------------------------------------------------

describe("assertSafeHost", () => {
  it("passes when all resolved addresses are public", async () => {
    const lookup = vi.fn().mockResolvedValue(["93.184.216.34", "2606:2800:220:1::1"]);
    await expect(assertSafeHost("example.com", lookup)).resolves.toBeUndefined();
    expect(lookup).toHaveBeenCalledWith("example.com");
  });

  it("blocks a public-looking hostname that resolves to an internal IP", async () => {
    // The core DNS-rebinding defense: the URL says example.com, but the
    // resolver returns 127.0.0.1 — must be blocked.
    const lookup = vi.fn().mockResolvedValue(["127.0.0.1"]);
    await expect(assertSafeHost("example.com", lookup)).rejects.toMatchObject({
      name: "HttpError",
      code: "blocked-redirect",
    });
  });

  it("blocks when ANY resolved address is internal (partial rebinding)", async () => {
    const lookup = vi.fn().mockResolvedValue(["93.184.216.34", "10.0.0.5"]);
    await expect(assertSafeHost("example.com", lookup)).rejects.toMatchObject({
      code: "blocked-redirect",
    });
  });

  it("blocks cloud metadata addresses", async () => {
    const lookup = vi.fn().mockResolvedValue(["169.254.169.254"]);
    await expect(assertSafeHost("metadata.internal", lookup)).rejects.toMatchObject({
      code: "blocked-redirect",
    });
  });

  it("classifies resolution failure as dns", async () => {
    const lookup = vi.fn().mockRejectedValue(new Error("ENOTFOUND"));
    await expect(assertSafeHost("nope.invalid", lookup)).rejects.toMatchObject({
      code: "dns",
    });
  });

  it("classifies empty resolution as dns", async () => {
    const lookup = vi.fn().mockResolvedValue([]);
    await expect(assertSafeHost("empty.example", lookup)).rejects.toMatchObject({
      code: "dns",
    });
  });
});

// ---------------------------------------------------------------------------
// Redirect target validation
// ---------------------------------------------------------------------------

describe("resolveRedirectTarget", () => {
  it("returns null when there is no Location header", () => {
    expect(resolveRedirectTarget(null, "https://example.com/", "example.com")).toBeNull();
  });

  it("resolves a same-host absolute Location", () => {
    expect(
      resolveRedirectTarget("https://example.com/new", "https://example.com/", "example.com"),
    ).toBe("https://example.com/new");
  });

  it("resolves a relative Location against the current URL", () => {
    expect(resolveRedirectTarget("/new", "https://example.com/", "example.com")).toBe(
      "https://example.com/new",
    );
  });

  it("blocks a cross-host redirect", () => {
    expect(() =>
      resolveRedirectTarget("https://evil.com/", "https://example.com/", "example.com"),
    ).toThrowError(/different host/);
  });

  it("blocks a subdomain redirect (host must match exactly)", () => {
    expect(() =>
      resolveRedirectTarget("https://www.example.com/", "https://example.com/", "example.com"),
    ).toThrow(HttpError);
  });

  it("blocks non-http(s) schemes", () => {
    expect(() =>
      resolveRedirectTarget("file:///etc/passwd", "https://example.com/", "example.com"),
    ).toThrowError(/scheme/);
    expect(() =>
      resolveRedirectTarget("ftp://example.com/", "https://example.com/", "example.com"),
    ).toThrowError(/scheme/);
  });

  it("blocks unparseable Locations", () => {
    expect(() =>
      resolveRedirectTarget("http://[::1", "https://example.com/", "example.com"),
    ).toThrow(HttpError);
  });

  it("is case-insensitive on the host comparison", () => {
    expect(
      resolveRedirectTarget("https://EXAMPLE.com/x", "https://example.com/", "example.com"),
    ).toBe("https://example.com/x");
  });
});

// ---------------------------------------------------------------------------
// fetchHttpStatus — happy path & status passthrough
// ---------------------------------------------------------------------------

function okResponse(status = 200, headers?: Record<string, string>): Response {
  return new Response("ok", { status, headers });
}

function fakeFetch(sequence: Array<Response | Error>): MockFetch {
  const fn = vi.fn();
  sequence.forEach((item) => {
    fn.mockImplementationOnce(() =>
      item instanceof Error ? Promise.reject(item) : Promise.resolve(item),
    );
  });
  return fn as unknown as MockFetch;
}

type MockFetch = typeof fetch & {
  mock: ReturnType<typeof vi.fn>["mock"];
};

function publicLookup(): (hostname: string) => Promise<string[]> {
  return vi.fn().mockResolvedValue(["93.184.216.34"]);
}

describe("fetchHttpStatus", () => {
  it("returns status, timing and metadata for a 2xx response", async () => {
    const fetchFn = fakeFetch([okResponse(200, { "content-type": "text/html" })]);
    const result = await fetchHttpStatus("example.com", { fetchFn, lookup: publicLookup() });

    expect(result.status).toBe(200);
    expect(result.redirected).toBe(false);
    expect(result.redirectCount).toBe(0);
    expect(result.finalUrl).toBe("https://example.com/");
    expect(result.responseTimeMs).toBeGreaterThanOrEqual(0);
    // Initial request must be https and use manual redirects.
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://example.com/");
    expect((init as RequestInit & { redirect: string }).redirect).toBe("manual");
  });

  it("passes 4xx and 5xx statuses through unchanged", async () => {
    const fetch404 = await fetchHttpStatus("example.com", {
      fetchFn: fakeFetch([okResponse(404)]),
      lookup: publicLookup(),
    });
    expect(fetch404.status).toBe(404);

    const fetch503 = await fetchHttpStatus("example.com", {
      fetchFn: fakeFetch([okResponse(503)]),
      lookup: publicLookup(),
    });
    expect(fetch503.status).toBe(503);
  });

  it("follows a same-host redirect and reports the final result", async () => {
    const fetchFn = fakeFetch([
      okResponse(302, { location: "https://example.com/redirected" }),
      okResponse(200),
    ]);
    const result = await fetchHttpStatus("example.com", { fetchFn, lookup: publicLookup() });

    expect(result.status).toBe(200);
    expect(result.redirected).toBe(true);
    expect(result.redirectCount).toBe(1);
    expect(result.finalUrl).toBe("https://example.com/redirected");
    expect(fetchFn.mock.calls).toHaveLength(2);
  });

  it("enforces the max redirect limit", async () => {
    const fetchFn = fakeFetch([
      okResponse(302, { location: "https://example.com/1" }),
      okResponse(302, { location: "https://example.com/2" }),
      okResponse(302, { location: "https://example.com/3" }),
      okResponse(302, { location: "https://example.com/4" }),
      okResponse(302, { location: "https://example.com/5" }),
      okResponse(302, { location: "https://example.com/6" }),
      okResponse(200),
    ]);
    await expect(
      fetchHttpStatus("example.com", { fetchFn, lookup: publicLookup(), maxRedirects: 5 }),
    ).rejects.toMatchObject({ code: "too-many-redirects" });
  });

  // -------------------------------------------------------------------------
  // SSRF at the client level — the critical tests
  // -------------------------------------------------------------------------

  it("blocks the INITIAL request when the host resolves to an internal IP", async () => {
    const lookup = vi.fn().mockResolvedValue(["192.168.1.10"]);
    await expect(
      fetchHttpStatus("example.com", { fetchFn: fakeFetch([okResponse(200)]), lookup }),
    ).rejects.toMatchObject({ code: "blocked-redirect" });
  });

  it("blocks a redirect whose target resolves to an internal IP", async () => {
    // First hop: example.com is public. Redirect Location looks public
    // (internal.example.com) but resolves to 10.0.0.1 → must be blocked.
    const lookup = vi
      .fn()
      .mockResolvedValueOnce(["93.184.216.34"]) // initial host
      .mockResolvedValueOnce(["10.0.0.1"]); // redirect target (rebound!)
    const fetchFn = fakeFetch([
      okResponse(302, { location: "https://example.com/admin" }),
      okResponse(200),
    ]);
    await expect(fetchHttpStatus("example.com", { fetchFn, lookup })).rejects.toMatchObject({
      code: "blocked-redirect",
    });
    // The second fetch must never be issued.
    expect(fetchFn.mock.calls).toHaveLength(1);
  });

  it("blocks a cross-host redirect before issuing the next request", async () => {
    const lookup = publicLookup();
    const fetchFn = fakeFetch([
      okResponse(302, { location: "https://evil.com/" }),
      okResponse(200),
    ]);
    await expect(fetchHttpStatus("example.com", { fetchFn, lookup })).rejects.toMatchObject({
      code: "blocked-redirect",
    });
    expect(fetchFn.mock.calls).toHaveLength(1);
  });

  it("re-validates EVERY redirect hop (not just the first)", async () => {
    const lookup = vi
      .fn()
      .mockResolvedValueOnce(["93.184.216.34"])
      .mockResolvedValueOnce(["93.184.216.34"])
      .mockResolvedValueOnce(["127.0.0.1"]); // third hop rebounds
    const fetchFn = fakeFetch([
      okResponse(302, { location: "https://example.com/a" }),
      okResponse(302, { location: "https://example.com/b" }),
      okResponse(200),
    ]);
    await expect(fetchHttpStatus("example.com", { fetchFn, lookup })).rejects.toMatchObject({
      code: "blocked-redirect",
    });
    expect(fetchFn.mock.calls).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // Error classification
  // -------------------------------------------------------------------------

  it("classifies a timeout", async () => {
    const fetchFn = fakeFetch([new DOMException("timeout", "TimeoutError")]);
    await expect(
      fetchHttpStatus("example.com", { fetchFn, lookup: publicLookup() }),
    ).rejects.toMatchObject({ code: "timeout" });
  });

  it("classifies DNS resolution failure from the fetch layer", async () => {
    const cause = Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
    const fetchFn = fakeFetch([cause]);
    await expect(
      fetchHttpStatus("example.com", { fetchFn, lookup: publicLookup() }),
    ).rejects.toMatchObject({ code: "dns" });
  });

  it("classifies connection failures as network", async () => {
    const cause = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    const fetchFn = fakeFetch([cause]);
    await expect(
      fetchHttpStatus("example.com", { fetchFn, lookup: publicLookup() }),
    ).rejects.toMatchObject({ code: "network" });
  });

  it("classifies unknown fetch failures as network", async () => {
    const fetchFn = fakeFetch([new Error("boom")]);
    await expect(
      fetchHttpStatus("example.com", { fetchFn, lookup: publicLookup() }),
    ).rejects.toMatchObject({ code: "network" });
  });
});
