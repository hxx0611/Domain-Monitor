import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { fetchSslCertificate, SslError, type SslClientOptions } from "./client";
import type { RawCertificateLike } from "./normalize";

/**
 * A fake TLS socket that emits the same events the real TLSSocket does.
 * The injected `connect` factory returns one of these, letting tests drive
 * success and every failure path without any network access.
 */
class FakeSocket extends EventEmitter {
  destroy = () => {
    this.destroyed = true;
  };
  destroyed = false;
  getPeerX509Certificate: () => RawCertificateLike | null;
  getProtocol: () => string | undefined;
  getCipher: () => { name: string } | undefined;

  constructor(opts: {
    certificate?: RawCertificateLike | null;
    protocol?: string;
    cipherName?: string;
  }) {
    super();
    this.getPeerX509Certificate = () => opts.certificate ?? null;
    this.getProtocol = () => opts.protocol;
    this.getCipher = () => (opts.cipherName ? { name: opts.cipherName } : undefined);
  }

  /** Simulate a successful handshake. */
  secureConnect() {
    this.emit("secureConnect");
  }

  /** Simulate a timeout. */
  timeOut() {
    this.emit("timeout");
  }

  /** Simulate a socket error. */
  socketError(code: string) {
    const err = new Error(code) as NodeJS.ErrnoException;
    err.code = code;
    this.emit("error", err);
  }
}

function fakeConnect(socket: FakeSocket): SslClientOptions["connect"] {
  return (() => socket) as unknown as SslClientOptions["connect"];
}

const VALID_CERT: RawCertificateLike = {
  fingerprint256: "AA:BB:CC:DD",
  subject: "CN=example.com",
  issuer: "CN=Test CA",
  validFrom: "Jan 1 00:00:00 2026 GMT",
  validTo: "Dec 31 23:59:59 2026 GMT",
  serialNumber: "01",
  subjectAltName: "DNS:example.com",
  ca: false,
  checkHost: () => "DNS:example.com",
};

describe("fetchSslCertificate", () => {
  it("resolves with certificate, protocol and cipher on success", async () => {
    const socket = new FakeSocket({
      certificate: VALID_CERT,
      protocol: "TLSv1.3",
      cipherName: "TLS_AES_256_GCM_SHA384",
    });
    const promise = fetchSslCertificate("example.com", { connect: fakeConnect(socket) });
    socket.secureConnect();

    const result = await promise;
    expect(result.certificate.fingerprint256).toBe("AA:BB:CC:DD");
    expect(result.tlsVersion).toBe("TLSv1.3");
    expect(result.cipherName).toBe("TLS_AES_256_GCM_SHA384");
  });

  it("leaves protocol/cipher undefined when the socket exposes none", async () => {
    const socket = new FakeSocket({ certificate: VALID_CERT });
    const promise = fetchSslCertificate("example.com", { connect: fakeConnect(socket) });
    socket.secureConnect();

    const result = await promise;
    expect(result.tlsVersion).toBeUndefined();
    expect(result.cipherName).toBeUndefined();
  });

  it("classifies a timeout as SslError timeout", async () => {
    const socket = new FakeSocket({ certificate: VALID_CERT });
    const promise = fetchSslCertificate("example.com", { connect: fakeConnect(socket) });
    socket.timeOut();

    await expect(promise).rejects.toMatchObject({ name: "SslError", code: "timeout" });
  });

  it("classifies ECONNREFUSED as no-tls-service", async () => {
    const socket = new FakeSocket({ certificate: VALID_CERT });
    const promise = fetchSslCertificate("example.com", { connect: fakeConnect(socket) });
    socket.socketError("ECONNREFUSED");

    await expect(promise).rejects.toMatchObject({ name: "SslError", code: "no-tls-service" });
  });

  it("classifies ENOTFOUND as network", async () => {
    const socket = new FakeSocket({ certificate: VALID_CERT });
    const promise = fetchSslCertificate("example.com", { connect: fakeConnect(socket) });
    socket.socketError("ENOTFOUND");

    await expect(promise).rejects.toMatchObject({ name: "SslError", code: "network" });
  });

  it("classifies ECONNRESET as network", async () => {
    const socket = new FakeSocket({ certificate: VALID_CERT });
    const promise = fetchSslCertificate("example.com", { connect: fakeConnect(socket) });
    socket.socketError("ECONNRESET");

    await expect(promise).rejects.toMatchObject({ name: "SslError", code: "network" });
  });

  it("classifies ERR_SSL_* codes as handshake", async () => {
    const socket = new FakeSocket({ certificate: VALID_CERT });
    const promise = fetchSslCertificate("example.com", { connect: fakeConnect(socket) });
    socket.socketError("ERR_SSL_WRONG_VERSION_NUMBER");

    await expect(promise).rejects.toMatchObject({ name: "SslError", code: "handshake" });
  });

  it("classifies EPROTO as handshake", async () => {
    const socket = new FakeSocket({ certificate: VALID_CERT });
    const promise = fetchSslCertificate("example.com", { connect: fakeConnect(socket) });
    socket.socketError("EPROTO");

    await expect(promise).rejects.toMatchObject({ name: "SslError", code: "handshake" });
  });

  it("classifies an unknown error code as network", async () => {
    const socket = new FakeSocket({ certificate: VALID_CERT });
    const promise = fetchSslCertificate("example.com", { connect: fakeConnect(socket) });
    socket.socketError("SOMETHING_WEIRD");

    await expect(promise).rejects.toMatchObject({ name: "SslError", code: "network" });
  });

  it("classifies a missing peer certificate as handshake", async () => {
    const socket = new FakeSocket({ certificate: null });
    const promise = fetchSslCertificate("example.com", { connect: fakeConnect(socket) });
    socket.secureConnect();

    await expect(promise).rejects.toMatchObject({ name: "SslError", code: "handshake" });
  });

  it("classifies certificate parse failures as invalid-cert", async () => {
    const socket = new FakeSocket({
      certificate: VALID_CERT,
    });
    // Make getPeerX509Certificate throw — simulates a parse error.
    socket.getPeerX509Certificate = () => {
      throw new Error("unable to decode");
    };
    const promise = fetchSslCertificate("example.com", { connect: fakeConnect(socket) });
    socket.secureConnect();

    await expect(promise).rejects.toMatchObject({ name: "SslError", code: "invalid-cert" });
  });

  it("only settles once (late events after success are ignored)", async () => {
    const socket = new FakeSocket({
      certificate: VALID_CERT,
      protocol: "TLSv1.3",
      cipherName: "TLS_AES_128_GCM_SHA256",
    });
    const promise = fetchSslCertificate("example.com", { connect: fakeConnect(socket) });
    socket.secureConnect();
    const result = await promise;
    // A late timeout after settle must not reject.
    socket.timeOut();
    expect(result.tlsVersion).toBe("TLSv1.3");
  });

  it("only settles once (late errors after failure are ignored)", async () => {
    const socket = new FakeSocket({ certificate: VALID_CERT });
    const promise = fetchSslCertificate("example.com", { connect: fakeConnect(socket) });
    socket.timeOut();
    await expect(promise).rejects.toMatchObject({ code: "timeout" });
    // Late error after settle is ignored (no unhandled rejection).
    socket.socketError("ECONNREFUSED");
  });
});

describe("SslError", () => {
  it("carries a typed code", () => {
    const error = new SslError("boom", "network");
    expect(error.name).toBe("SslError");
    expect(error.code).toBe("network");
    expect(error.message).toBe("boom");
  });
});
