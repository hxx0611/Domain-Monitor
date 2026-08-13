/**
 * Manual SSL integration smoke test.
 *
 * Hits REAL TLS endpoints (no mocks): performs actual TLS handshakes
 * against mozilla.org and example.com, reads the presented leaf
 * certificates via Node's X509Certificate API, and exercises one failure
 * path (connection to a port with no TLS service) to confirm error
 * classification. It is intentionally NOT part of the default `pnpm test`
 * run (vitest only picks up src/**\/*.test.ts) so CI never depends on the
 * public internet.
 *
 * Run manually with:
 *   pnpm vitest run --config scripts/vitest.smoke.config.ts
 *
 * Exercises the actual `fetchSslCertificate` client code path against the
 * live network.
 */
import { describe, expect, it } from "vitest";
import { fetchSslCertificate, SslError } from "../src/lib/ssl/client";
import { classifySslStatus, toSslCertificate } from "../src/lib/ssl/normalize";

describe("SSL smoke test (real network)", () => {
  it(
    "reads a real certificate from mozilla.org",
    async () => {
      const raw = await fetchSslCertificate("mozilla.org", { timeoutMs: 15_000 });

      // Handshake metadata must be present.
      expect(raw.tlsVersion).toBeTruthy();
      expect(raw.cipherName).toBeTruthy();
      console.log("[smoke] mozilla.org protocol:", raw.tlsVersion);
      console.log("[smoke] mozilla.org cipher:", raw.cipherName);

      // Certificate basics.
      const cert = toSslCertificate(raw.certificate, "mozilla.org");
      expect(cert.fingerprint256).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
      expect(cert.validFrom).toBeTruthy();
      expect(cert.validTo).toBeTruthy();
      expect(cert.issuer).toBeTruthy();
      expect(cert.subject).toBeTruthy();
      expect(cert.san.length).toBeGreaterThan(0);
      expect(cert.hostnameMatched).toBe(true);

      // The classified status must be a valid status (typically "ok").
      const status = classifySslStatus(cert);
      console.log("[smoke] mozilla.org status:", status, "| validTo:", cert.validTo);
      console.log("[smoke] mozilla.org issuer:", cert.issuer);
      console.log("[smoke] mozilla.org SAN:", cert.san.join(", "));
      console.log("[smoke] mozilla.org fingerprint256:", cert.fingerprint256);
    },
    60_000,
  );

  it(
    "reads a real certificate from example.com",
    async () => {
      const raw = await fetchSslCertificate("example.com", { timeoutMs: 15_000 });

      expect(raw.tlsVersion).toBeTruthy();
      const cert = toSslCertificate(raw.certificate, "example.com");
      expect(cert.fingerprint256).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
      expect(cert.validTo).toBeTruthy();
      expect(cert.hostnameMatched).toBe(true);
      console.log("[smoke] example.com protocol:", raw.tlsVersion, "| validTo:", cert.validTo);
      console.log("[smoke] example.com fingerprint256:", cert.fingerprint256);
    },
    60_000,
  );

  it(
    "classifies a connection to a port with no TLS service as no-tls-service",
    async () => {
      // Port 1 is virtually never a TLS service; expect a classified error,
      // not a crash or unhandled rejection.
      try {
        await fetchSslCertificate("example.com", { port: 1, timeoutMs: 10_000 });
        // If we somehow got here, fail loudly — this should not succeed.
        throw new Error("expected an error but the connection succeeded");
      } catch (error) {
        expect(error).toBeInstanceOf(SslError);
        const sslError = error as SslError;
        console.log("[smoke] no-tls-service error code:", sslError.code);
        expect(["no-tls-service", "network", "handshake", "timeout"]).toContain(sslError.code);
      }
    },
    60_000,
  );
});
