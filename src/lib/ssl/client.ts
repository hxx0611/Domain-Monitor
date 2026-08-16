/**
 * SSL/TLS client.
 *
 * Connects to a host's 443 port with Node's native `tls` module and reads
 * the presented leaf certificate plus handshake metadata. This is a
 * monitoring read — `rejectUnauthorized` is deliberately disabled so that
 * expired, self-signed, or mismatched certificates can be inspected and
 * surfaced instead of failing the handshake. The certificate is never
 * trusted for any business decision; classification happens in
 * normalize.ts.
 *
 * The connection factory is injectable so tests can hand back a fake
 * socket without touching the network.
 */

import tls from "node:tls";
import type { RawCertificateLike } from "./normalize";

export type SslErrorCode =
  "timeout" | "network" | "handshake" | "no-tls-service" | "invalid-cert" | "dns-failed";

export class SslError extends Error {
  readonly code: SslErrorCode;

  constructor(message: string, code: SslErrorCode) {
    super(message);
    this.name = "SslError";
    this.code = code;
  }
}

/** Raw certificate + handshake metadata returned by the client. */
export interface RawSslResult {
  certificate: RawCertificateLike;
  tlsVersion?: string;
  cipherName?: string;
}

export interface SslClientOptions {
  /** Port to connect to (default 443). */
  port?: number;
  /** Hard timeout for the TLS handshake (default 8s). */
  timeoutMs?: number;
  /**
   * Injectable connection factory for tests. Mirrors `tls.connect`.
   * Defaults to Node's `tls.connect`.
   */
  connect?: typeof tls.connect;
}

/**
 * Connect to `hostname` over TLS and read the leaf certificate.
 *
 * Throws `SslError` on any failure:
 * - `timeout`        — the handshake did not complete in time
 * - `network`        — DNS resolution or transport failure
 * - `handshake`      — TLS handshake failed (protocol/version mismatch)
 * - `no-tls-service` — connection refused (nothing listening on 443)
 * - `invalid-cert`   — the peer certificate could not be parsed
 *
 * This layer does NOT decide the final SSL status (ok / expired /
 * mismatch / ...); it only returns raw data or a classified error.
 */
export function fetchSslCertificate(
  hostname: string,
  options: SslClientOptions = {},
): Promise<RawSslResult> {
  const { port = 443, timeoutMs = 8_000, connect = tls.connect } = options;

  return new Promise<RawSslResult>((resolve, reject) => {
    const socket = connect({
      host: hostname,
      port,
      servername: hostname,
      rejectUnauthorized: false,
      timeout: timeoutMs,
    });

    let settled = false;
    const fail = (error: SslError) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      reject(error);
    };

    socket.on("secureConnect", () => {
      if (settled) {
        return;
      }
      try {
        const rawCert = socket.getPeerX509Certificate();
        if (!rawCert) {
          fail(new SslError("Peer did not present a certificate.", "handshake"));
          return;
        }
        settled = true;
        const result: RawSslResult = {
          certificate: rawCert as unknown as RawCertificateLike,
          tlsVersion: socket.getProtocol() ?? undefined,
          cipherName: socket.getCipher()?.name ?? undefined,
        };
        socket.destroy();
        resolve(result);
      } catch (error) {
        fail(mapParseError(error));
      }
    });

    socket.on("timeout", () => {
      fail(new SslError("TLS handshake timed out.", "timeout"));
    });

    socket.on("error", (error: NodeJS.ErrnoException) => {
      fail(mapSocketError(error));
    });
  });
}

function mapSocketError(error: NodeJS.ErrnoException): SslError {
  if (error.code === "ECONNREFUSED") {
    return new SslError("No TLS service on port 443.", "no-tls-service");
  }
  // Name resolution failures get their own classification so the UI can
  // distinguish "the domain does not resolve" from a general connection
  // failure (V0.7.3).
  if (error.code === "ENOTFOUND" || error.code === "EAI_AGAIN") {
    return new SslError("Could not resolve the domain.", "dns-failed");
  }
  if (
    error.code === "ECONNRESET" ||
    error.code === "EHOSTUNREACH" ||
    error.code === "ENETUNREACH"
  ) {
    return new SslError("TLS connection failed (network error).", "network");
  }
  // TLS handshake failures surface as ERR_SSL_* / EPROTO codes.
  if (
    typeof error.code === "string" &&
    (error.code.startsWith("ERR_SSL") || error.code === "EPROTO")
  ) {
    return new SslError("TLS handshake failed.", "handshake");
  }
  return new SslError(`TLS connection failed (${error.code ?? error.message}).`, "network");
}

function mapParseError(error: unknown): SslError {
  if (error instanceof SslError) {
    return error;
  }
  return new SslError("Could not parse the peer certificate.", "invalid-cert");
}
