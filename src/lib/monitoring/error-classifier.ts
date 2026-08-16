/**
 * Monitoring error classification (V0.7.3).
 *
 * Maps the transport-layer error codes produced by the DNS / SSL / HTTP
 * clients to stable, prefixed, user-safe monitoring error codes.
 *
 * Hard rules:
 * - PURE functions only: no database, no network, no i18n, no server-only.
 *   Safe to import from any server module and to unit-test in isolation.
 * - Never leaks raw error messages: the returned codes are fixed machine
 *   values; the underlying error message (which may contain hostnames or
 *   resolved IPs, e.g. a blocked-address SSRF rejection) stays in the
 *   server log only.
 * - Unknown / non-client errors always collapse to the module `unknown`
 *   code — callers must treat any code they do not recognise as unknown.
 *
 * The code namespace is prefixed per module (`dns_*`, `ssl_*`, `http_*`)
 * so codes are unique across the app and cannot be confused with
 * notification delivery errors (which reuse HttpError for webhook sends).
 */

import { DnsError } from "@/lib/dns/client";
import { SslError } from "@/lib/ssl/client";
import { HttpError } from "@/lib/http/client";

/** Stable DNS monitoring error codes (V0.7.3). */
export type DnsErrorCode =
  "dns_timeout" | "dns_network" | "dns_invalid_response" | "dns_resolver_error" | "dns_unknown";

/** Stable SSL monitoring error codes (V0.7.3). */
export type SslErrorCode =
  | "ssl_timeout"
  | "ssl_network"
  | "ssl_dns_failed"
  | "ssl_handshake"
  | "ssl_no_tls_service"
  | "ssl_invalid_cert"
  | "ssl_unknown";

/** Stable HTTP monitoring error codes (V0.7.3). */
export type HttpErrorCode =
  | "http_dns_failed"
  | "http_timeout"
  | "http_network"
  | "http_blocked_redirect"
  | "http_too_many_redirects"
  | "http_unknown";

/** Union of every monitoring error code. */
export type MonitoringErrorCode = DnsErrorCode | SslErrorCode | HttpErrorCode;

/**
 * Classify an unknown error from the DNS check path.
 *
 *   classifyDnsError(new DnsError("...", "timeout"))  → "dns_timeout"
 *   classifyDnsError(new Error("boom"))               → "dns_unknown"
 */
export function classifyDnsError(error: unknown): DnsErrorCode {
  if (error instanceof DnsError) {
    switch (error.code) {
      case "timeout":
        return "dns_timeout";
      case "network":
        return "dns_network";
      case "invalid-response":
        return "dns_invalid_response";
      case "resolver-error":
        return "dns_resolver_error";
    }
  }
  return "dns_unknown";
}

/**
 * Classify an unknown error from the SSL check path.
 */
export function classifySslError(error: unknown): SslErrorCode {
  if (error instanceof SslError) {
    switch (error.code) {
      case "timeout":
        return "ssl_timeout";
      case "network":
        return "ssl_network";
      case "dns-failed":
        return "ssl_dns_failed";
      case "handshake":
        return "ssl_handshake";
      case "no-tls-service":
        return "ssl_no_tls_service";
      case "invalid-cert":
        return "ssl_invalid_cert";
    }
  }
  return "ssl_unknown";
}

/**
 * Classify an unknown error from the HTTP check path.
 *
 * `http_blocked_redirect` is the ONLY code exposed for SSRF rejections:
 * the raw HttpError message (which contains the resolved address) never
 * leaves the server log.
 */
export function classifyHttpError(error: unknown): HttpErrorCode {
  if (error instanceof HttpError) {
    switch (error.code) {
      case "timeout":
        return "http_timeout";
      case "network":
        return "http_network";
      case "dns":
        return "http_dns_failed";
      case "blocked-redirect":
        return "http_blocked_redirect";
      case "too-many-redirects":
        return "http_too_many_redirects";
      // "invalid-url" cannot occur for monitoring (hostname comes from a
      // stored, validated domain) — collapse to unknown.
      default:
        return "http_unknown";
    }
  }
  return "http_unknown";
}
