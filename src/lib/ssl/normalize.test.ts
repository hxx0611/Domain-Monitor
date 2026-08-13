import { describe, expect, it } from "vitest";
import {
  classifySslStatus,
  daysRemaining,
  EXPIRY_WARNING_DAYS,
  normalizeFingerprint,
  parseCertDate,
  parseSan,
  toSslCertificate,
  type RawCertificateLike,
} from "./normalize";
import type { SslCertificate } from "./types";

/** Build a duck-typed raw certificate for tests (no real X509 needed). */
function rawCert(overrides: Partial<RawCertificateLike> = {}): RawCertificateLike {
  return {
    fingerprint256: "AA:BB:CC:DD",
    subject: "CN=example.com",
    issuer: "CN=Test CA",
    validFrom: "Jan 1 00:00:00 2026 GMT",
    validTo: "Dec 31 23:59:59 2026 GMT",
    serialNumber: "01",
    subjectAltName: "DNS:example.com, DNS:www.example.com",
    ca: false,
    checkHost: (hostname: string) => (hostname === "example.com" ? "DNS:example.com" : undefined),
    ...overrides,
  };
}

/** Fixed "now" for deterministic validity classification. */
const NOW = new Date("2026-06-15T00:00:00.000Z");

describe("toSslCertificate", () => {
  it("extracts fields and parses dates to ISO 8601", () => {
    const cert = toSslCertificate(rawCert(), "example.com");
    expect(cert.subject).toBe("CN=example.com");
    expect(cert.issuer).toBe("CN=Test CA");
    expect(cert.validFrom).toBe("2026-01-01T00:00:00.000Z");
    expect(cert.validTo).toBe("2026-12-31T23:59:59.000Z");
    expect(cert.serialNumber).toBe("01");
  });

  it("parses and sorts SAN entries", () => {
    const cert = toSslCertificate(rawCert(), "example.com");
    expect(cert.san).toEqual(["DNS:example.com", "DNS:www.example.com"]);
  });

  it("sets hostnameMatched from checkHost", () => {
    expect(toSslCertificate(rawCert(), "example.com").hostnameMatched).toBe(true);
    expect(toSslCertificate(rawCert(), "evil.com").hostnameMatched).toBe(false);
  });

  it("marks self-signed certificates", () => {
    expect(toSslCertificate(rawCert({ ca: true }), "example.com").isSelfSigned).toBe(true);
    expect(toSslCertificate(rawCert({ ca: false }), "example.com").isSelfSigned).toBe(false);
  });

  it("treats empty optional fields as undefined", () => {
    const cert = toSslCertificate(
      rawCert({ subjectAltName: undefined, validTo: undefined, serialNumber: undefined }),
      "example.com",
    );
    expect(cert.san).toEqual([]);
    expect(cert.validTo).toBeUndefined();
    expect(cert.serialNumber).toBeUndefined();
  });

  it("normalizes the fingerprint on the way in", () => {
    const cert = toSslCertificate(
      rawCert({
        fingerprint256: "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
      }),
      "example.com",
    );
    expect(cert.fingerprint256).toBe(
      "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99",
    );
  });
});

describe("classifySslStatus", () => {
  function certWithValidity(validTo: string, hostnameMatched = true): SslCertificate {
    return {
      fingerprint256: "AA:BB",
      validTo,
      san: [],
      isSelfSigned: false,
      hostnameMatched,
    };
  }

  it("classifies a valid certificate as ok", () => {
    expect(classifySslStatus(certWithValidity("2026-12-31T00:00:00.000Z"), NOW)).toBe("ok");
  });

  it("classifies an expired certificate as expired", () => {
    expect(classifySslStatus(certWithValidity("2026-01-01T00:00:00.000Z"), NOW)).toBe("expired");
  });

  it("classifies a certificate expiring within the warning window as expires_soon", () => {
    // NOW = Jun 15, validTo = Jul 1 → 16 days remaining ≤ 30
    expect(classifySslStatus(certWithValidity("2026-07-01T00:00:00.000Z"), NOW)).toBe(
      "expires_soon",
    );
  });

  it("classifies a certificate expiring exactly at the boundary as expires_soon", () => {
    // validTo = NOW + 30 days → 30 ≤ 30
    const in30 = new Date(NOW.getTime() + EXPIRY_WARNING_DAYS * 86_400_000);
    expect(classifySslStatus(certWithValidity(in30.toISOString()), NOW)).toBe("expires_soon");
  });

  it("treats a certificate expiring today as expires_soon (not expired)", () => {
    expect(classifySslStatus(certWithValidity(NOW.toISOString()), NOW)).toBe("expires_soon");
  });

  it("gives mismatch priority over validity", () => {
    expect(classifySslStatus(certWithValidity("2026-12-31T00:00:00.000Z", false), NOW)).toBe(
      "mismatch",
    );
    // Even an expired certificate reads as mismatch when the SAN doesn't match.
    expect(classifySslStatus(certWithValidity("2020-01-01T00:00:00.000Z", false), NOW)).toBe(
      "mismatch",
    );
  });

  it("treats a certificate without validTo as ok when matched", () => {
    expect(classifySslStatus(certWithValidity(""), NOW)).toBe("ok");
  });

  it("supports a custom warning window", () => {
    const cert = certWithValidity("2026-07-10T00:00:00.000Z"); // 25 days from NOW
    expect(classifySslStatus(cert, NOW, 30)).toBe("expires_soon");
    expect(classifySslStatus(cert, NOW, 20)).toBe("ok");
  });
});

describe("daysRemaining", () => {
  const expiry = new Date("2026-07-01T00:00:00.000Z");

  it("computes whole days remaining", () => {
    expect(daysRemaining(expiry, new Date("2026-06-15T00:00:00.000Z"))).toBe(16);
  });

  it("returns 0 for a certificate expiring today", () => {
    expect(daysRemaining(expiry, new Date("2026-07-01T00:00:00.000Z"))).toBe(0);
  });

  it("returns negative for an expired certificate", () => {
    expect(daysRemaining(expiry, new Date("2026-07-02T00:00:00.000Z"))).toBe(-1);
  });

  it("returns 1 for a certificate expiring tomorrow", () => {
    expect(daysRemaining(expiry, new Date("2026-06-30T00:00:00.000Z"))).toBe(1);
  });
});

describe("parseSan", () => {
  it("parses multiple entries and sorts them", () => {
    expect(parseSan("DNS:www.example.com, DNS:example.com")).toEqual([
      "DNS:example.com",
      "DNS:www.example.com",
    ]);
  });

  it("handles IP Address entries", () => {
    expect(parseSan("DNS:example.com, IP Address:1.2.3.4")).toEqual([
      "DNS:example.com",
      "IP Address:1.2.3.4",
    ]);
  });

  it("deduplicates repeated entries", () => {
    expect(parseSan("DNS:example.com, DNS:example.com")).toEqual(["DNS:example.com"]);
  });

  it("returns an empty array for missing input", () => {
    expect(parseSan(undefined)).toEqual([]);
    expect(parseSan("")).toEqual([]);
  });

  it("handles wildcard certificates", () => {
    expect(parseSan("DNS:*.example.com")).toEqual(["DNS:*.example.com"]);
  });
});

describe("parseCertDate", () => {
  it("parses Node's GMT date format", () => {
    expect(parseCertDate("Oct 21 16:55:01 2026 GMT")).toBe("2026-10-21T16:55:01.000Z");
  });

  it("parses ISO 8601 input", () => {
    expect(parseCertDate("2026-12-31T23:59:59.000Z")).toBe("2026-12-31T23:59:59.000Z");
  });

  it("returns undefined for empty or unparseable input", () => {
    expect(parseCertDate(undefined)).toBeUndefined();
    expect(parseCertDate("")).toBeUndefined();
    expect(parseCertDate("not a date")).toBeUndefined();
  });
});

describe("normalizeFingerprint", () => {
  const canonical =
    "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99";

  it("keeps canonical uppercase form unchanged", () => {
    expect(normalizeFingerprint(canonical)).toBe(canonical);
  });

  it("uppercases lowercase fingerprints", () => {
    expect(normalizeFingerprint(canonical.toLowerCase())).toBe(canonical);
  });

  it("re-inserts colons in separator-less fingerprints", () => {
    expect(normalizeFingerprint(canonical.replace(/:/g, ""))).toBe(canonical);
  });

  it("handles space-separated fingerprints", () => {
    expect(normalizeFingerprint(canonical.replace(/:/g, " "))).toBe(canonical);
  });

  it("returns non-hex input unchanged", () => {
    expect(normalizeFingerprint("not-a-fingerprint")).toBe("not-a-fingerprint");
  });
});
