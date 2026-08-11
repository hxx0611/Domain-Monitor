import { describe, expect, it } from "vitest";
import { queryRdap } from "./service";
import { buildSuffixMap } from "./bootstrap";

const BOOTSTRAP_MAP = buildSuffixMap({
  services: [["com", ["https://rdap.verisign.com/com/v1/"]]],
});

const FULL_RESPONSE = {
  ldhName: "example.com",
  events: [
    { eventAction: "registration", eventDate: "1997-08-14T04:00:00Z" },
    { eventAction: "expiration", eventDate: "2027-08-13T04:00:00Z" },
  ],
  nameservers: [{ ldhName: "a.iana-servers.net" }],
};

describe("queryRdap (integration, mocked)", () => {
  it("runs bootstrap → client → parser and returns normalized data", async () => {
    const fetchFn = async () =>
      new Response(JSON.stringify(FULL_RESPONSE), {
        status: 200,
        headers: { "content-type": "application/rdap+json" },
      });

    const data = await queryRdap("example.com", { bootstrapMap: BOOTSTRAP_MAP, fetchFn });

    expect(data).toEqual({
      domainName: "example.com",
      registrar: undefined,
      registrationDate: "1997-08-14T04:00:00.000Z",
      expirationDate: "2027-08-13T04:00:00.000Z",
      updatedDate: undefined,
      status: [],
      nameservers: ["a.iana-servers.net"],
    });
  });

  it("throws no-bootstrap for hostnames without a bootstrap entry", async () => {
    await expect(
      queryRdap("example.invalid", { bootstrapMap: BOOTSTRAP_MAP }),
    ).rejects.toMatchObject({ code: "no-bootstrap" });
  });

  it("propagates client errors (e.g. not-found)", async () => {
    const fetchFn = async () => new Response("{}", { status: 404 });
    await expect(
      queryRdap("example.com", { bootstrapMap: BOOTSTRAP_MAP, fetchFn }),
    ).rejects.toMatchObject({ code: "not-found" });
  });

  it("propagates parser errors for invalid payloads", async () => {
    const fetchFn = async () =>
      new Response(JSON.stringify({ status: [] }), {
        status: 200,
        headers: { "content-type": "application/rdap+json" },
      });
    await expect(
      queryRdap("example.com", { bootstrapMap: BOOTSTRAP_MAP, fetchFn }),
    ).rejects.toMatchObject({ code: "invalid-response" });
  });
});
