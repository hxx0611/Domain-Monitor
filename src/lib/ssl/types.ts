/**
 * SSL certificate monitoring types.
 *
 * `SslCertificate` is Domain Monitor's own normalized certificate shape —
 * it never mirrors Node's X509Certificate API directly. The TLS client
 * layer produces a raw certificate plus handshake metadata; normalize.ts
 * converts it into this canonical form. Everything above that layer only
 * ever sees these types.
 */

import type { SslErrorCode } from "@/lib/monitoring/error-classifier";

/**
 * Normalized outcome of an SSL check. `ok` means a certificate was
 * obtained and parsed; the finer-grained `validity` describes its state.
 */
export type SslStatus = "ok" | "expires_soon" | "expired" | "mismatch" | "error";

/** A single normalized leaf certificate as stored per snapshot. */
export interface SslCertificate {
  /** SHA-256 fingerprint, colon-separated uppercase. Identity key for change detection. */
  fingerprint256: string;
  subject?: string;
  issuer?: string;
  /** ISO 8601 (UTC). */
  validFrom?: string;
  /** ISO 8601 (UTC). */
  validTo?: string;
  serialNumber?: string;
  /** Canonicalized SAN entries (e.g. ["DNS:mozilla.org", "DNS:www.mozilla.org"]). */
  san: string[];
  isSelfSigned: boolean;
  /** Whether the certificate's SAN covers the queried hostname. */
  hostnameMatched: boolean;
}

/** One SSL check snapshot as stored for a domain. */
export interface SslSnapshot {
  id: number;
  domainId: number;
  checkedAt: Date;
  /** TLS protocol version, e.g. "TLSv1.3" (undefined on error). */
  tlsVersion?: string;
  /** Cipher name, e.g. "TLS_AES_256_GCM_SHA384" (undefined on error). */
  cipherName?: string;
  status: SslStatus;
  /** Machine error code when status is "error" (never a raw message). */
  error?: string;
  /** The leaf certificate (present when status is not "error"). */
  certificate?: SslCertificate;
}

/** Change events are deliberately coarse: certificate replaced / unchanged. */
export type SslChangeType = "CERT_REPLACED";

export interface SslChange {
  type: SslChangeType;
  previousFingerprint: string;
  currentFingerprint: string;
}

/** Result of a manual SSL check, as returned by the service layer. */
export type SslCheckResult =
  | {
      ok: true;
      snapshotId: number;
      checkedAt: Date;
      /** Empty on the first check (no previous snapshot to diff against). */
      changes: SslChange[];
    }
  | { ok: false; error: string; errorCode?: SslErrorCode };
