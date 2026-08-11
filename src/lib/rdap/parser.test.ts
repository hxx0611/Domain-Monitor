import { describe, expect, it } from "vitest";
import { parseRdapDomainResponse, normalizeDate } from "./parser";
import { RdapError } from "./client";

const VALID_RESPONSE = {
  ldhName: "example.com",
  status: ["client transfer prohibited", "client update prohibited"],
  events: [
    { eventAction: "registration", eventDate: "1997-08-14T04:00:00Z" },
    { eventAction: "expiration", eventDate: "2027-08-13T04:00:00Z" },
    { eventAction: "last changed", eventDate: "2024-01-01T12:00:00Z" },
  ],
  nameservers: [{ ldhName: "a.iana-servers.net" }, { ldhName: "b.iana-servers.net" }],
  entities: [
    {
      roles: ["registrar"],
      vcardArray: [
        "vcard",
        [
          ["version", {}, "text", "4.0"],
          ["fn", {}, "text", "Example Registrar LLC"],
        ],
      ],
    },
  ],
};

describe("parseRdapDomainResponse", () => {
  it("parses a complete RDAP response into the normalized structure", () => {
    const data = parseRdapDomainResponse(VALID_RESPONSE);

    expect(data.domainName).toBe("example.com");
    expect(data.registrar).toBe("Example Registrar LLC");
    expect(data.registrationDate).toBe("1997-08-14T04:00:00.000Z");
    expect(data.expirationDate).toBe("2027-08-13T04:00:00.000Z");
    expect(data.updatedDate).toBe("2024-01-01T12:00:00.000Z");
    expect(data.status).toEqual(["client transfer prohibited", "client update prohibited"]);
    expect(data.nameservers).toEqual(["a.iana-servers.net", "b.iana-servers.net"]);
  });

  it("falls back to domainName when ldhName is absent", () => {
    const data = parseRdapDomainResponse({
      ...VALID_RESPONSE,
      ldhName: undefined,
      domainName: "example.org",
    });
    expect(data.domainName).toBe("example.org");
  });

  it("handles missing optional sections gracefully", () => {
    const data = parseRdapDomainResponse({ ldhName: "example.com" });

    expect(data.registrar).toBeUndefined();
    expect(data.registrationDate).toBeUndefined();
    expect(data.expirationDate).toBeUndefined();
    expect(data.updatedDate).toBeUndefined();
    expect(data.status).toEqual([]);
    expect(data.nameservers).toEqual([]);
  });

  it("skips nameservers without an ldhName", () => {
    const data = parseRdapDomainResponse({
      ldhName: "example.com",
      nameservers: [{ ldhName: "ns1.example.com" }, { other: "x" }, {}],
    });
    expect(data.nameservers).toEqual(["ns1.example.com"]);
  });

  it("extracts registrar from the vcard org property when fn is absent", () => {
    const data = parseRdapDomainResponse({
      ldhName: "example.com",
      entities: [
        {
          roles: ["registrar"],
          vcardArray: [
            "vcard",
            [
              ["version", {}, "text", "4.0"],
              ["org", {}, "text", "Example Org Ltd"],
            ],
          ],
        },
      ],
    });
    expect(data.registrar).toBe("Example Org Ltd");
  });

  it("ignores entities whose roles do not include registrar", () => {
    const data = parseRdapDomainResponse({
      ldhName: "example.com",
      entities: [
        { roles: ["administrative"], vcardArray: ["vcard", [["fn", {}, "text", "Admin"]]] },
      ],
    });
    expect(data.registrar).toBeUndefined();
  });

  it("returns undefined registrar for entities without a vcard name", () => {
    const data = parseRdapDomainResponse({
      ldhName: "example.com",
      entities: [{ roles: ["registrar"] }],
    });
    expect(data.registrar).toBeUndefined();
  });

  it("throws for non-object input", () => {
    for (const bad of [null, undefined, [], "example.com", 42]) {
      expect(() => parseRdapDomainResponse(bad)).toThrow(RdapError);
    }
  });

  it("throws when no domain name is present", () => {
    expect(() => parseRdapDomainResponse({ status: [] })).toThrow(RdapError);
  });
});

describe("normalizeDate", () => {
  it("normalizes full ISO 8601 timestamps to UTC", () => {
    expect(normalizeDate("1997-08-14T04:00:00Z")).toBe("1997-08-14T04:00:00.000Z");
  });

  it("normalizes date-only values to ISO 8601", () => {
    expect(normalizeDate("1997-08-14")).toBe("1997-08-14T00:00:00.000Z");
  });

  it("normalizes offsets to UTC", () => {
    expect(normalizeDate("2024-01-01T12:00:00+08:00")).toBe("2024-01-01T04:00:00.000Z");
  });

  it("returns undefined for empty, non-string or unparseable input", () => {
    expect(normalizeDate("")).toBeUndefined();
    expect(normalizeDate("not a date")).toBeUndefined();
    expect(normalizeDate(19970814)).toBeUndefined();
    expect(normalizeDate(undefined)).toBeUndefined();
  });
});
