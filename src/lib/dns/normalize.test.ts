import { describe, expect, it } from "vitest";
import {
  canonicalizeHostname,
  canonicalizeRecord,
  parseCaa,
  parseMx,
  sortRecords,
} from "./normalize";
import type { DnsRecord } from "./types";

describe("canonicalizeHostname", () => {
  it("lowercases hostnames", () => {
    expect(canonicalizeHostname("EXAMPLE.COM")).toBe("example.com");
  });

  it("removes the trailing dot", () => {
    expect(canonicalizeHostname("example.com.")).toBe("example.com");
  });

  it("combines lowercasing and trailing-dot removal", () => {
    expect(canonicalizeHostname("NS1.Example.COM.")).toBe("ns1.example.com");
  });

  it("preserves the root name '.'", () => {
    expect(canonicalizeHostname(".")).toBe(".");
  });

  it("trims surrounding whitespace", () => {
    expect(canonicalizeHostname("  example.com  ")).toBe("example.com");
  });
});

describe("canonicalizeRecord — A", () => {
  it("accepts a canonical IPv4 address", () => {
    expect(canonicalizeRecord("A", "1.2.3.4")).toEqual({ ok: true, value: "1.2.3.4" });
  });

  it("rejects a non-IP value", () => {
    expect(canonicalizeRecord("A", "not-an-ip")).toEqual({ ok: false });
  });

  it("rejects an IPv6 address in an A record", () => {
    expect(canonicalizeRecord("A", "2606:4700:10::6814:179a")).toEqual({ ok: false });
  });
});

describe("canonicalizeRecord — AAAA", () => {
  it("accepts a canonical IPv6 address", () => {
    expect(canonicalizeRecord("AAAA", "2606:4700:10::6814:179a")).toEqual({
      ok: true,
      value: "2606:4700:10::6814:179a",
    });
  });

  it("rejects a non-IP value", () => {
    expect(canonicalizeRecord("AAAA", "example.com")).toEqual({ ok: false });
  });

  it("rejects an IPv4 address in an AAAA record", () => {
    expect(canonicalizeRecord("AAAA", "1.2.3.4")).toEqual({ ok: false });
  });
});

describe("canonicalizeRecord — CNAME / NS", () => {
  it("removes the trailing dot from a CNAME target", () => {
    expect(canonicalizeRecord("CNAME", "github.com.")).toEqual({ ok: true, value: "github.com" });
  });

  it("lowercases a CNAME target", () => {
    expect(canonicalizeRecord("CNAME", "GitHub.COM.")).toEqual({ ok: true, value: "github.com" });
  });

  it("removes the trailing dot from an NS target", () => {
    expect(canonicalizeRecord("NS", "hera.ns.cloudflare.com.")).toEqual({
      ok: true,
      value: "hera.ns.cloudflare.com",
    });
  });

  it("rejects the root name as a CNAME target", () => {
    expect(canonicalizeRecord("CNAME", ".")).toEqual({ ok: false });
  });
});

describe("canonicalizeRecord — MX", () => {
  it("parses priority and exchange separately", () => {
    expect(canonicalizeRecord("MX", "10 mail.example.com.")).toEqual({
      ok: true,
      value: "mail.example.com",
      priority: 10,
    });
  });

  it("lowercases the exchange and removes its trailing dot", () => {
    expect(canonicalizeRecord("MX", "20 Mail2.Example.COM.")).toEqual({
      ok: true,
      value: "mail2.example.com",
      priority: 20,
    });
  });

  it("handles a null MX (RFC 7505) whose exchange is the root", () => {
    expect(canonicalizeRecord("MX", "0 .")).toEqual({ ok: true, value: ".", priority: 0 });
  });

  it("rejects malformed MX data without a priority", () => {
    expect(canonicalizeRecord("MX", "mail.example.com")).toEqual({ ok: false });
  });
});

describe("canonicalizeRecord — TXT", () => {
  it("keeps the string semantics verbatim", () => {
    expect(canonicalizeRecord("TXT", "v=spf1 -all")).toEqual({ ok: true, value: "v=spf1 -all" });
  });

  it("does not strip presentation-format quotes", () => {
    expect(canonicalizeRecord("TXT", '"v=spf1 -all"')).toEqual({
      ok: true,
      value: '"v=spf1 -all"',
    });
  });

  it("preserves interior whitespace and special characters", () => {
    expect(canonicalizeRecord("TXT", "some text with spaces")).toEqual({
      ok: true,
      value: "some text with spaces",
    });
  });
});

describe("canonicalizeRecord — CAA", () => {
  it("parses flags, tag and value", () => {
    expect(canonicalizeRecord("CAA", '0 issue "pki.goog"')).toEqual({
      ok: true,
      value: "0 issue pki.goog",
    });
  });

  it("lowercases the tag", () => {
    expect(canonicalizeRecord("CAA", '0 ISSUE "pki.goog"')).toEqual({
      ok: true,
      value: "0 issue pki.goog",
    });
  });

  it("rejects out-of-range flags", () => {
    expect(canonicalizeRecord("CAA", "256 issue pki.goog")).toEqual({ ok: false });
  });

  it("rejects a missing tag", () => {
    expect(canonicalizeRecord("CAA", "0")).toEqual({ ok: false });
  });
});

describe("parseMx", () => {
  it("parses priority and exchange", () => {
    expect(parseMx("10 mail.example.com")).toEqual({
      priority: 10,
      exchange: "mail.example.com",
    });
  });

  it("rejects negative priorities", () => {
    expect(parseMx("-1 mail.example.com")).toBeUndefined();
  });
});

describe("parseCaa", () => {
  it("strips wrapping quotes from the value", () => {
    expect(parseCaa('0 issue "ca.example.net; policy=ev"')).toBe(
      "0 issue ca.example.net; policy=ev",
    );
  });

  it("keeps a value without quotes as-is", () => {
    expect(parseCaa("0 iodef mailto:security@example.com")).toBe(
      "0 iodef mailto:security@example.com",
    );
  });
});

describe("sortRecords", () => {
  it("sorts records of the same type by value", () => {
    const records: DnsRecord[] = [
      { type: "A", name: "example.com", value: "5.6.7.8" },
      { type: "A", name: "example.com", value: "1.2.3.4" },
    ];
    expect(sortRecords(records).map((r) => r.value)).toEqual(["1.2.3.4", "5.6.7.8"]);
  });

  it("sorts MX records by priority first", () => {
    const records: DnsRecord[] = [
      { type: "MX", name: "example.com", value: "mail2.example.com", priority: 20 },
      { type: "MX", name: "example.com", value: "mail.example.com", priority: 10 },
    ];
    expect(sortRecords(records).map((r) => r.priority)).toEqual([10, 20]);
  });

  it("is stable for identical input", () => {
    const records: DnsRecord[] = [
      { type: "A", name: "example.com", value: "1.2.3.4", ttl: 300 },
      { type: "A", name: "example.com", value: "1.2.3.4", ttl: 600 },
    ];
    const once = sortRecords(records);
    const twice = sortRecords(records);
    expect(once).toEqual(twice);
  });
});
