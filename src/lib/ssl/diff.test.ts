import { describe, expect, it } from "vitest";
import { diffSslSnapshots } from "./diff";
import type { SslCertificate, SslSnapshot } from "./types";

function certificate(fingerprint256: string, validTo = "2026-12-31T00:00:00.000Z"): SslCertificate {
  return {
    fingerprint256,
    validTo,
    san: [],
    isSelfSigned: false,
    hostnameMatched: true,
  };
}

function snapshot(
  id: number,
  certificateValue: SslCertificate | undefined,
  status: SslSnapshot["status"] = "ok",
): SslSnapshot {
  return {
    id,
    domainId: 1,
    checkedAt: new Date(),
    status,
    ...(certificateValue ? { certificate: certificateValue } : {}),
  };
}

describe("diffSslSnapshots", () => {
  it("produces no changes for identical fingerprints", () => {
    const cert = certificate("AA:BB:CC");
    expect(diffSslSnapshots(snapshot(1, cert), snapshot(2, cert))).toEqual([]);
  });

  it("produces no changes for an undefined previous snapshot (first check)", () => {
    expect(diffSslSnapshots(undefined, snapshot(1, certificate("AA:BB")))).toEqual([]);
  });

  it("reports CERT_REPLACED when the fingerprint changes", () => {
    const changes = diffSslSnapshots(
      snapshot(1, certificate("AA:BB")),
      snapshot(2, certificate("CC:DD")),
    );
    expect(changes).toEqual([
      { type: "CERT_REPLACED", previousFingerprint: "AA:BB", currentFingerprint: "CC:DD" },
    ]);
  });

  it("treats later expiry on the same certificate as no change", () => {
    const oldCert = certificate("AA:BB", "2026-06-01T00:00:00.000Z");
    const renewed = certificate("AA:BB", "2027-06-01T00:00:00.000Z");
    expect(diffSslSnapshots(snapshot(1, oldCert), snapshot(2, renewed))).toEqual([]);
  });

  it("produces no changes when either snapshot lacks a certificate", () => {
    expect(
      diffSslSnapshots(snapshot(1, undefined, "error"), snapshot(2, certificate("AA"))),
    ).toEqual([]);
    expect(
      diffSslSnapshots(snapshot(1, certificate("AA")), snapshot(2, undefined, "error")),
    ).toEqual([]);
  });

  it("produces no changes when both snapshots are failed checks", () => {
    expect(
      diffSslSnapshots(snapshot(1, undefined, "error"), snapshot(2, undefined, "error")),
    ).toEqual([]);
  });

  it("ignores non-fingerprint differences (issuer/subject changes on same fingerprint)", () => {
    const previous = snapshot(1, certificate("AA:BB"));
    const current = snapshot(2, {
      ...certificate("AA:BB"),
      issuer: "CN=Different CA",
      subject: "CN=other",
    });
    expect(diffSslSnapshots(previous, current)).toEqual([]);
  });
});
