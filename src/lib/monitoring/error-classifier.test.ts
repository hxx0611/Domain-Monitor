/**
 * Monitoring error classifier unit tests (V0.7.3).
 *
 * Verifies:
 * - every transport error code maps to the stable prefixed monitoring code
 * - unknown / non-client errors collapse to the module `unknown` code
 * - the classifier NEVER surfaces raw messages — the blocked-redirect
 *   HttpError message contains a resolved address, and only the code may
 *   leave this layer (the message stays in the server log).
 */

import { describe, expect, it } from "vitest";

import { DnsError } from "@/lib/dns/client";
import { SslError } from "@/lib/ssl/client";
import { HttpError } from "@/lib/http/client";
import { classifyDnsError, classifySslError, classifyHttpError } from "./error-classifier";

describe("classifyDnsError", () => {
  it("maps every transport code to the prefixed monitoring code", () => {
    expect(classifyDnsError(new DnsError("x", "timeout"))).toBe("dns_timeout");
    expect(classifyDnsError(new DnsError("x", "network"))).toBe("dns_network");
    expect(classifyDnsError(new DnsError("x", "invalid-response"))).toBe("dns_invalid_response");
    expect(classifyDnsError(new DnsError("x", "resolver-error"))).toBe("dns_resolver_error");
  });

  it("collapses unknown / non-client errors to dns_unknown", () => {
    expect(classifyDnsError(new Error("boom"))).toBe("dns_unknown");
    expect(classifyDnsError("string error")).toBe("dns_unknown");
    expect(classifyDnsError(undefined)).toBe("dns_unknown");
    expect(classifyDnsError(new SslError("x", "network"))).toBe("dns_unknown");
  });
});

describe("classifySslError", () => {
  it("maps every transport code to the prefixed monitoring code", () => {
    expect(classifySslError(new SslError("x", "timeout"))).toBe("ssl_timeout");
    expect(classifySslError(new SslError("x", "network"))).toBe("ssl_network");
    expect(classifySslError(new SslError("x", "dns-failed"))).toBe("ssl_dns_failed");
    expect(classifySslError(new SslError("x", "handshake"))).toBe("ssl_handshake");
    expect(classifySslError(new SslError("x", "no-tls-service"))).toBe("ssl_no_tls_service");
    expect(classifySslError(new SslError("x", "invalid-cert"))).toBe("ssl_invalid_cert");
  });

  it("collapses unknown / non-client errors to ssl_unknown", () => {
    expect(classifySslError(new Error("boom"))).toBe("ssl_unknown");
    expect(classifySslError(null)).toBe("ssl_unknown");
    expect(classifySslError(new DnsError("x", "network"))).toBe("ssl_unknown");
  });
});

describe("classifyHttpError", () => {
  it("maps every transport code to the prefixed monitoring code", () => {
    expect(classifyHttpError(new HttpError("x", "timeout"))).toBe("http_timeout");
    expect(classifyHttpError(new HttpError("x", "network"))).toBe("http_network");
    expect(classifyHttpError(new HttpError("x", "dns"))).toBe("http_dns_failed");
    expect(classifyHttpError(new HttpError("x", "blocked-redirect"))).toBe("http_blocked_redirect");
    expect(classifyHttpError(new HttpError("x", "too-many-redirects"))).toBe(
      "http_too_many_redirects",
    );
  });

  it("collapses invalid-url (impossible for monitoring) to http_unknown", () => {
    expect(classifyHttpError(new HttpError("x", "invalid-url"))).toBe("http_unknown");
  });

  it("collapses unknown / non-client errors to http_unknown", () => {
    expect(classifyHttpError(new Error("boom"))).toBe("http_unknown");
    expect(classifyHttpError(42)).toBe("http_unknown");
  });

  it("NEVER leaks the blocked-address message — only the code escapes", () => {
    // The raw message contains a resolved internal address. Only the code
    // may cross this layer; the message must stay in the server log.
    const raw = new HttpError(
      "Blocked address 10.0.0.1 resolved for internal.example.",
      "blocked-redirect",
    );
    const code = classifyHttpError(raw);
    expect(code).toBe("http_blocked_redirect");
    expect(code).not.toContain("10.0.0.1");
    expect(code).not.toContain("internal.example");
    expect(code).not.toContain("Blocked");
  });

  it("never returns the raw message as a code for any input", () => {
    const raw = new HttpError("Blocked address 192.168.1.5 resolved for host.", "blocked-redirect");
    const code = classifyHttpError(raw);
    expect(code).toMatch(/^http_[a-z_]+$/);
    expect(code).not.toMatch(/[\d.]+/);
  });
});
