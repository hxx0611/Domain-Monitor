import { describe, expect, it } from "vitest";
import { buildSuffixMap, findRdapEndpoint } from "./bootstrap";

const IANA_STYLE_BOOTSTRAP = {
  services: [
    ["com", ["https://rdap.verisign.com/com/v1/"]],
    ["net", ["https://rdap.verisign.com/net/v1/"]],
    [["charity", "foundation", "ngo", "org"], ["https://rdap.publicinterestregistry.org/rdap/"]],
  ],
};

describe("buildSuffixMap", () => {
  it("maps single-label suffixes to endpoints", () => {
    const map = buildSuffixMap(IANA_STYLE_BOOTSTRAP);
    expect(map.get("com")).toBe("https://rdap.verisign.com/com/v1/");
    expect(map.get("net")).toBe("https://rdap.verisign.com/net/v1/");
  });

  it("maps each TLD in an array entry to the shared endpoint", () => {
    const map = buildSuffixMap(IANA_STYLE_BOOTSTRAP);
    const endpoint = "https://rdap.publicinterestregistry.org/rdap/";
    expect(map.get("charity")).toBe(endpoint);
    expect(map.get("foundation")).toBe(endpoint);
    expect(map.get("ngo")).toBe(endpoint);
    expect(map.get("org")).toBe(endpoint);
  });

  it("normalizes suffix keys to lowercase", () => {
    const map = buildSuffixMap({
      services: [
        ["COM", ["https://rdap.example/"]],
        [["NGO", "ORG"], ["https://rdap.example2/"]],
      ],
    });
    expect(map.get("com")).toBe("https://rdap.example/");
    expect(map.get("ngo")).toBe("https://rdap.example2/");
    expect(map.get("org")).toBe("https://rdap.example2/");
  });

  it("ignores malformed entries and non-object input", () => {
    expect(buildSuffixMap(null).size).toBe(0);
    expect(buildSuffixMap([]).size).toBe(0);
    expect(buildSuffixMap("nope").size).toBe(0);

    const map = buildSuffixMap({
      services: [
        "not-an-array",
        [["com"]], // no endpoint array
        ["com", []], // empty endpoint array
        ["com", [42]], // non-string endpoint
        ["com", ["https://rdap.example/"]], // valid
      ],
    });
    expect(map.size).toBe(1);
    expect(map.get("com")).toBe("https://rdap.example/");
  });
});

describe("findRdapEndpoint", () => {
  const map = buildSuffixMap(IANA_STYLE_BOOTSTRAP);

  it("finds the endpoint for a plain hostname (TLD extraction)", () => {
    expect(findRdapEndpoint(map, "example.com")).toBe("https://rdap.verisign.com/com/v1/");
  });

  it("finds the endpoint for an array-entry TLD (org)", () => {
    expect(findRdapEndpoint(map, "example.org")).toBe(
      "https://rdap.publicinterestregistry.org/rdap/",
    );
  });

  it("prefers the longest matching suffix (example.foundation → foundation)", () => {
    expect(findRdapEndpoint(map, "example.foundation")).toBe(
      "https://rdap.publicinterestregistry.org/rdap/",
    );
  });

  it("resolves subdomains to their registrable suffix endpoint", () => {
    expect(findRdapEndpoint(map, "www.example.org")).toBe(
      "https://rdap.publicinterestregistry.org/rdap/",
    );
  });

  it("is case-insensitive", () => {
    expect(findRdapEndpoint(map, "EXAMPLE.COM")).toBe("https://rdap.verisign.com/com/v1/");
  });

  it("returns undefined for suffixes with no bootstrap entry", () => {
    expect(findRdapEndpoint(map, "example.invalid")).toBeUndefined();
    expect(findRdapEndpoint(map, "example.unknown")).toBeUndefined();
  });

  it("returns undefined for empty or single-label input", () => {
    expect(findRdapEndpoint(map, "")).toBeUndefined();
    expect(findRdapEndpoint(map, "com")).toBeUndefined();
  });
});
