/**
 * SSL snapshot diffing.
 *
 * `diffSslSnapshots` is a pure function: previous and current snapshots in,
 * a list of `SslChange`s out. The certificate fingerprint is the identity
 * key — a different fingerprint means the certificate was replaced.
 * Time passing (a later `validTo` on the same certificate) is not a change.
 */

import type { SslChange, SslSnapshot } from "./types";

/**
 * Compute the difference between two SSL snapshots.
 *
 * - Same fingerprint → no changes.
 * - Different fingerprint → CERT_REPLACED with both fingerprints.
 * - An undefined `previous` (first check) yields no changes at all.
 * - A snapshot without a certificate (failed check) never produces a
 *   change event, mirroring the DNS atomic-check behavior.
 */
export function diffSslSnapshots(
  previous: SslSnapshot | undefined,
  current: SslSnapshot,
): SslChange[] {
  if (!previous || !previous.certificate || !current.certificate) {
    return [];
  }

  if (previous.certificate.fingerprint256 === current.certificate.fingerprint256) {
    return [];
  }

  return [
    {
      type: "CERT_REPLACED",
      previousFingerprint: previous.certificate.fingerprint256,
      currentFingerprint: current.certificate.fingerprint256,
    },
  ];
}
