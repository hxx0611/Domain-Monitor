/**
 * Phase 10A + 10D regression tests — RDAP registered-domain fallback and
 * ownership semantics.
 *
 * `getRdapLookupCandidates` (pure candidate generation) and
 * `queryRdapWithFallback` (fallback semantics + ownership) are tested
 * against a mocked bootstrap map + fake fetch — no real network access.
 *
 * Phase 10D: every successful resolution must report `ownership` and
 * `matchedHostname`. `"exact"` means the RDAP object belongs to the queried
 * hostname; `"parent"` means it belongs to a parent label (e.g. `eu.cc` for
 * `opusai.eu.cc`) and its data must never be stored on the child's fields.
 * Ownership is decided from the object's canonical LDH identity, never
 * merely from "a fallback succeeded".
 */

import { describe, expect, it, vi } from "vitest";
import { buildSuffixMap } from "./bootstrap";
import { queryRdapWithFallback, getRdapLookupCandidates } from "./service";

const BOOTSTRAP_MAP = buildSuffixMap({
  services: [
    ["com", ["https://rdap.verisign.com/com/v1/"]],
    ["cc", ["https://rdap.cc/"]],
    ["co.uk", ["https://rdap.nominet.uk/"]],
    ["uk", ["https://rdap.nominet.uk/"]],
  ],
});

function successResponse(ldhName: string, expiration?: string): Response {
  const events: Array<{ eventAction: string; eventDate: string }> = [
    { eventAction: "registration", eventDate: "2020-01-01T00:00:00Z" },
  ];
  if (expiration) {
    events.push({ eventAction: "expiration", eventDate: expiration });
  }
  return new Response(
    JSON.stringify({
      ldhName,
      events,
      status: ["active"],
      nameservers: [{ ldhName: "a.iana-servers.net" }],
    }),
    { status: 200, headers: { "content-type": "application/rdap+json" } },
  );
}

function notFound(): Response {
  return new Response("{}", { status: 404 });
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

/** Fake fetch that routes by the `/domain/{hostname}` path segment. */
function fakeFetch(routes: Record<string, Response>) {
  const mock = vi.fn(async (input: RequestInfo | URL) => {
    const url = urlOf(input);
    const hostname = decodeURIComponent((url.split("/domain/")[1] ?? "").replace(/\/+$/, ""));
    const route = routes[hostname];
    if (!route) {
      return notFound();
    }
    return route;
  });
  // `typeof fetch` for options.fetchFn, `vi.fn` members for mock asserts.
  return mock as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

function queriedHostnames(fetchFn: ReturnType<typeof fakeFetch>): string[] {
  return fetchFn.mock.calls.map(([input]) =>
    decodeURIComponent((urlOf(input).split("/domain/")[1] ?? "").replace(/\/+$/, "")),
  );
}

describe("getRdapLookupCandidates", () => {
  it("keeps the full hostname first, then drops left-most labels", () => {
    expect(getRdapLookupCandidates("chatgpt.com")).toEqual(["chatgpt.com"]);
    expect(getRdapLookupCandidates("opusai.eu.cc")).toEqual(["opusai.eu.cc", "eu.cc"]);
    expect(getRdapLookupCandidates("foo.example.com")).toEqual(["foo.example.com", "example.com"]);
    expect(getRdapLookupCandidates("foo.example.co.uk")).toEqual([
      "foo.example.co.uk",
      "example.co.uk",
      "co.uk",
    ]);
  });

  it("normalizes case", () => {
    expect(getRdapLookupCandidates("OPUSAI.EU.CC")).toEqual(["opusai.eu.cc", "eu.cc"]);
  });

  it("never emits a bare TLD (single label) as a candidate", () => {
    const candidates = getRdapLookupCandidates("opusai.eu.cc");
    expect(candidates).not.toContain("cc");
    expect(candidates[candidates.length - 1]!.split(".").length).toBeGreaterThanOrEqual(2);
  });
});

describe("queryRdapWithFallback — registered-domain fallback", () => {
  it("1. EXACT: chatgpt.com resolves directly with its own expirationDate", async () => {
    const fetchFn = fakeFetch({
      "chatgpt.com": successResponse("chatgpt.com", "2026-11-30T00:00:00Z"),
    });
    const { data, matchedHostname, ownership } = await queryRdapWithFallback("chatgpt.com", {
      bootstrapMap: BOOTSTRAP_MAP,
      fetchFn,
    });
    expect(data.domainName).toBe("chatgpt.com");
    expect(data.expirationDate).toBe("2026-11-30T00:00:00.000Z");
    expect(ownership).toBe("exact");
    expect(matchedHostname).toBe("chatgpt.com");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("2. PARENT: opusai.eu.cc → not-found → eu.cc success → eu.cc data, ownership=parent", async () => {
    const fetchFn = fakeFetch({
      "opusai.eu.cc": notFound(),
      "eu.cc": successResponse("eu.cc", "2031-03-26T00:00:00Z"),
    });
    const { data, matchedHostname, ownership } = await queryRdapWithFallback("opusai.eu.cc", {
      bootstrapMap: BOOTSTRAP_MAP,
      fetchFn,
    });
    expect(data.domainName).toBe("eu.cc");
    expect(data.expirationDate).toBe("2031-03-26T00:00:00.000Z");
    expect(ownership).toBe("parent");
    expect(matchedHostname).toBe("eu.cc");
    expect(fetchFn).toHaveBeenCalledTimes(2);
    // 11. never falls back to the bare TLD `cc`
    expect(queriedHostnames(fetchFn)).toEqual(["opusai.eu.cc", "eu.cc"]);
  });

  it("3. PARENT: foo.example.com → not-found → example.com success", async () => {
    const fetchFn = fakeFetch({
      "foo.example.com": notFound(),
      "example.com": successResponse("example.com", "2027-08-13T04:00:00Z"),
    });
    const { data, matchedHostname, ownership } = await queryRdapWithFallback("foo.example.com", {
      bootstrapMap: BOOTSTRAP_MAP,
      fetchFn,
    });
    expect(data.expirationDate).toBe("2027-08-13T04:00:00.000Z");
    expect(ownership).toBe("parent");
    expect(matchedHostname).toBe("example.com");
    expect(queriedHostnames(fetchFn)).toEqual(["foo.example.com", "example.com"]);
  });

  it("4. PARENT: foo.example.co.uk → not-found → example.co.uk success", async () => {
    const fetchFn = fakeFetch({
      "foo.example.co.uk": notFound(),
      "example.co.uk": successResponse("example.co.uk", "2028-05-10T00:00:00Z"),
    });
    const { data, matchedHostname, ownership } = await queryRdapWithFallback("foo.example.co.uk", {
      bootstrapMap: BOOTSTRAP_MAP,
      fetchFn,
    });
    expect(data.expirationDate).toBe("2028-05-10T00:00:00.000Z");
    expect(ownership).toBe("parent");
    expect(matchedHostname).toBe("example.co.uk");
    expect(queriedHostnames(fetchFn)).toEqual(["foo.example.co.uk", "example.co.uk"]);
  });

  it("5. EXACT: full hostname succeeds with expirationDate → parent is NOT queried", async () => {
    const fetchFn = fakeFetch({
      "chatgpt.com": successResponse("chatgpt.com", "2026-11-30T00:00:00Z"),
    });
    const { ownership } = await queryRdapWithFallback("chatgpt.com", {
      bootstrapMap: BOOTSTRAP_MAP,
      fetchFn,
    });
    expect(ownership).toBe("exact");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("6. PARENT: full hostname succeeds but without expirationDate → parent is queried", async () => {
    const fetchFn = fakeFetch({
      "foo.example.com": successResponse("foo.example.com"),
      "example.com": successResponse("example.com", "2027-08-13T04:00:00Z"),
    });
    const { data, matchedHostname, ownership } = await queryRdapWithFallback("foo.example.com", {
      bootstrapMap: BOOTSTRAP_MAP,
      fetchFn,
    });
    expect(data.expirationDate).toBe("2027-08-13T04:00:00.000Z");
    expect(ownership).toBe("parent");
    expect(matchedHostname).toBe("example.com");
    expect(queriedHostnames(fetchFn)).toEqual(["foo.example.com", "example.com"]);
  });

  it("8. canonical-name mismatch → ownership=parent even on the first candidate", async () => {
    // The first candidate succeeds with an expirationDate, but the object's
    // own LDH name is the parent — ownership must be `parent`, not `exact`,
    // and the parent object must not be mistaken for the queried hostname.
    const fetchFn = fakeFetch({
      "opusai.eu.cc": successResponse("eu.cc", "2031-03-26T00:00:00Z"),
    });
    const { data, matchedHostname, ownership } = await queryRdapWithFallback("opusai.eu.cc", {
      bootstrapMap: BOOTSTRAP_MAP,
      fetchFn,
    });
    expect(data.domainName).toBe("eu.cc");
    expect(ownership).toBe("parent");
    expect(matchedHostname).toBe("eu.cc");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("9. canonical-name mismatch with uppercase LDH name → still recognized", async () => {
    const fetchFn = fakeFetch({
      "opusai.eu.cc": successResponse("EU.CC", "2031-03-26T00:00:00Z"),
    });
    const { ownership, matchedHostname } = await queryRdapWithFallback("opusai.eu.cc", {
      bootstrapMap: BOOTSTRAP_MAP,
      fetchFn,
    });
    expect(ownership).toBe("parent");
    expect(matchedHostname).toBe("eu.cc");
  });

  it("10. network error → NO parent fallback", async () => {
    const fetchFn = fakeFetch({});
    fetchFn.mockImplementation(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(
      queryRdapWithFallback("foo.example.com", { bootstrapMap: BOOTSTRAP_MAP, fetchFn }),
    ).rejects.toMatchObject({ code: "network" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("11. timeout → NO parent fallback", async () => {
    const fetchFn = fakeFetch({});
    fetchFn.mockImplementation(async () => {
      const error = new Error("timed out");
      error.name = "TimeoutError";
      throw error;
    });
    await expect(
      queryRdapWithFallback("foo.example.com", { bootstrapMap: BOOTSTRAP_MAP, fetchFn }),
    ).rejects.toMatchObject({ code: "timeout" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("12. rate-limited (429) → NO parent fallback", async () => {
    const fetchFn = fakeFetch({ "foo.example.com": new Response("{}", { status: 429 }) });
    await expect(
      queryRdapWithFallback("foo.example.com", { bootstrapMap: BOOTSTRAP_MAP, fetchFn }),
    ).rejects.toMatchObject({ code: "rate-limited" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("13. server-error (500) → NO parent fallback", async () => {
    const fetchFn = fakeFetch({ "foo.example.com": new Response("{}", { status: 500 }) });
    await expect(
      queryRdapWithFallback("foo.example.com", { bootstrapMap: BOOTSTRAP_MAP, fetchFn }),
    ).rejects.toMatchObject({ code: "server-error" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("invalid-response (200 but no domain name) → NO parent fallback", async () => {
    const fetchFn = fakeFetch({ "foo.example.com": new Response("{}", { status: 200 }) });
    await expect(
      queryRdapWithFallback("foo.example.com", { bootstrapMap: BOOTSTRAP_MAP, fetchFn }),
    ).rejects.toMatchObject({ code: "invalid-response" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("all candidates not-found → last not-found error is thrown (NO_OBJECT)", async () => {
    const fetchFn = fakeFetch({
      "opusai.eu.cc": notFound(),
      "eu.cc": notFound(),
    });
    await expect(
      queryRdapWithFallback("opusai.eu.cc", { bootstrapMap: BOOTSTRAP_MAP, fetchFn }),
    ).rejects.toMatchObject({ code: "not-found" });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
