/**
 * Phase 13B — Domain server action contract tests.
 *
 * Covers createDomainAction / updateDomainAction / refreshRdapAction /
 * deleteDomainAction. The repository, RDAP query and admin boundary are
 * mocked; the real validation/normalization layer (hostname, manual dates,
 * management URL, reminders) runs through the actions so its error codes
 * are asserted end-to-end. No database file is opened and no real RDAP
 * network call is made.
 *
 * RDAP ownership semantics under test (Phase 10D / 11A-6):
 *   - exact    → action forwards the exact ownership to the repository
 *   - parent   → action forwards parent ownership (repository never writes
 *                parent data into the child)
 *   - no-object→ action forwards the status-less data (expiration stays
 *                null in the repository)
 *   - manual   → creation NEVER triggers an RDAP refresh (an automatic
 *                refresh could overwrite the operator's dates)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/rdap", () => ({ queryRdapWithFallback: vi.fn() }));
vi.mock("./repository", () => ({
  createDomain: vi.fn(),
  deleteDomain: vi.fn(),
  getDomainById: vi.fn(),
  setExpirationReminders: vi.fn(),
  updateDomain: vi.fn(),
  updateDomainRdap: vi.fn(),
}));

import { revalidatePath } from "next/cache";
import {
  createDomainAction,
  deleteDomainAction,
  refreshRdapAction,
  updateDomainAction,
} from "./actions";
import { requireAdmin } from "@/lib/auth/admin";
import { queryRdapWithFallback } from "@/lib/rdap";
import * as repository from "./repository";

const mRepo = {
  createDomain: vi.mocked(repository.createDomain),
  deleteDomain: vi.mocked(repository.deleteDomain),
  getDomainById: vi.mocked(repository.getDomainById),
  setExpirationReminders: vi.mocked(repository.setExpirationReminders),
  updateDomain: vi.mocked(repository.updateDomain),
  updateDomainRdap: vi.mocked(repository.updateDomainRdap),
};
const mockedQueryRdap = vi.mocked(queryRdapWithFallback);
const mockedRequireAdmin = vi.mocked(requireAdmin);
const mockedRevalidatePath = vi.mocked(revalidatePath);

/** A domain row shaped like the repository's DomainWithRdap. */
function domainRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    hostname: "example.com",
    expirationSource: "rdap",
    registrationDate: null,
    expirationDate: null,
    registrationProvider: null,
    registrationProviderUrl: null,
    registrar: null,
    updatedDate: null,
    rdapUpdatedAt: null,
    createdAt: new Date("2026-08-20T00:00:00.000Z"),
    updatedAt: new Date("2026-08-20T00:00:00.000Z"),
    nameservers: [],
    rdapStatus: [],
    ...overrides,
  };
}

/** Exact RDAP ownership result (a real domain that exists). */
function exactRdapResult() {
  return {
    data: {
      domainName: "CHATGPT.COM",
      registrar: "Gname.com Pte. Ltd.",
      registrationDate: "2022-04-08T00:00:00Z",
      expirationDate: "2026-11-30T04:00:00Z",
      updatedDate: "2025-11-20T04:00:00Z",
      status: ["clientTransferProhibited"],
      nameservers: ["ns1.example.net"],
    },
    matchedHostname: "chatgpt.com",
    ownership: "exact" as const,
  };
}

beforeEach(() => {
  mockedRequireAdmin.mockResolvedValue(true);
  vi.clearAllMocks();
});

describe("createDomainAction", () => {
  it("returns unauthorized and touches nothing when not an admin", async () => {
    mockedRequireAdmin.mockResolvedValue(false);

    const result = await createDomainAction("example.com");

    expect(result).toEqual({ ok: false, error: "unauthorized" });
    expect(mRepo.createDomain).not.toHaveBeenCalled();
    expect(mockedQueryRdap).not.toHaveBeenCalled();
    expect(mockedRevalidatePath).not.toHaveBeenCalled();
  });

  it("rejects an invalid hostname before touching the repository", async () => {
    const result = await createDomainAction("");

    expect(result).toEqual({ ok: false, error: "Please enter a valid domain name." });
    expect(mRepo.createDomain).not.toHaveBeenCalled();
  });

  it("rejects an IP address hostname", async () => {
    const result = await createDomainAction("192.168.1.1");

    expect(result).toEqual({ ok: false, error: "IP addresses are not supported." });
    expect(mRepo.createDomain).not.toHaveBeenCalled();
  });

  it("rejects an invalid expiration source", async () => {
    const result = await createDomainAction("example.com", {
      expirationSource: "weird" as never,
    });

    expect(result).toEqual({ ok: false, error: "invalid_expiration_source" });
    expect(mRepo.createDomain).not.toHaveBeenCalled();
  });

  it("rejects an invalid manual date", async () => {
    const result = await createDomainAction("example.com", {
      expirationSource: "manual",
      expirationDate: "2026-02-31",
    });

    expect(result).toEqual({ ok: false, error: "invalid_date" });
    expect(mRepo.createDomain).not.toHaveBeenCalled();
  });

  it("rejects an invalid manual date range (expiration before registration)", async () => {
    const result = await createDomainAction("example.com", {
      expirationSource: "manual",
      registrationDate: "2026-06-01",
      expirationDate: "2026-01-01",
    });

    expect(result).toEqual({ ok: false, error: "invalid_date_range" });
    expect(mRepo.createDomain).not.toHaveBeenCalled();
  });

  it("rejects a non-https management URL", async () => {
    const result = await createDomainAction("example.com", {
      expirationSource: "rdap",
      registrationProviderUrl: "http://example.com/manage",
    });

    expect(result).toEqual({ ok: false, error: "invalid_scheme" });
    expect(mRepo.createDomain).not.toHaveBeenCalled();
  });

  it("rejects a management URL containing a credential-like word", async () => {
    const result = await createDomainAction("example.com", {
      expirationSource: "rdap",
      registrationProviderUrl: "https://example.com/manage?token=abc",
    });

    expect(result).toEqual({ ok: false, error: "forbidden_credential_word" });
    expect(mRepo.createDomain).not.toHaveBeenCalled();
  });

  it("rejects an invalid reminder day", async () => {
    const result = await createDomainAction("example.com", {
      expirationSource: "rdap",
      reminders: [0],
    });

    expect(result).toEqual({ ok: false, error: "invalid_reminder" });
    expect(mRepo.createDomain).not.toHaveBeenCalled();
  });

  it("creates an rdap domain, runs RDAP enrichment and revalidates", async () => {
    mRepo.createDomain.mockReturnValue(domainRow() as never);
    mockedQueryRdap.mockResolvedValue(exactRdapResult());

    const result = await createDomainAction("example.com");

    expect(result).toEqual({ ok: true, hostname: "example.com" });
    expect(mRepo.createDomain).toHaveBeenCalledWith("example.com", {
      expirationSource: "rdap",
      registrationDate: null,
      expirationDate: null,
      registrationProvider: null,
      registrationProviderUrl: null,
    });
    expect(mockedQueryRdap).toHaveBeenCalledWith("example.com");
    expect(mRepo.updateDomainRdap).toHaveBeenCalledWith(1, exactRdapResult().data, "exact");
    expect(mRepo.setExpirationReminders).not.toHaveBeenCalled();
    expect(mockedRevalidatePath).toHaveBeenCalledWith("/");
  });

  it("persists reminders when supplied", async () => {
    mRepo.createDomain.mockReturnValue(domainRow() as never);
    mockedQueryRdap.mockResolvedValue(exactRdapResult());

    const result = await createDomainAction("example.com", {
      expirationSource: "rdap",
      reminders: [30, 30, 7],
    });

    expect(result).toEqual({ ok: true, hostname: "example.com" });
    expect(mRepo.setExpirationReminders).toHaveBeenCalledWith(1, [30, 7]);
  });

  it("skips the RDAP refresh entirely for a manual domain", async () => {
    mRepo.createDomain.mockReturnValue(domainRow({ expirationSource: "manual" }) as never);

    const result = await createDomainAction("example.com", {
      expirationSource: "manual",
      registrationDate: "2024-05-01",
      expirationDate: "2031-03-26",
      registrationProvider: "gname",
    });

    expect(result).toEqual({ ok: true, hostname: "example.com" });
    expect(mRepo.createDomain).toHaveBeenCalledWith("example.com", {
      expirationSource: "manual",
      registrationDate: "2024-05-01",
      expirationDate: "2031-03-26",
      registrationProvider: "gname",
      registrationProviderUrl: null,
    });
    // Automatic RDAP refresh must never overwrite the operator's dates.
    expect(mockedQueryRdap).not.toHaveBeenCalled();
    expect(mRepo.updateDomainRdap).not.toHaveBeenCalled();
  });

  it("still creates the domain when the RDAP enrichment query fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mRepo.createDomain.mockReturnValue(domainRow() as never);
    mockedQueryRdap.mockRejectedValue(new Error("network down"));

    const result = await createDomainAction("example.com");

    expect(result).toEqual({ ok: true, hostname: "example.com" });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("reports a duplicate hostname when the repository returns undefined", async () => {
    mRepo.createDomain.mockReturnValue(undefined as never);

    const result = await createDomainAction("example.com");

    expect(result).toEqual({ ok: false, error: "This domain is already being monitored." });
    expect(mockedQueryRdap).not.toHaveBeenCalled();
  });

  it("absorbs a unique-constraint race as a duplicate", async () => {
    mRepo.createDomain.mockImplementation(() => {
      throw new Error("UNIQUE constraint failed");
    });

    const result = await createDomainAction("example.com");

    expect(result).toEqual({ ok: false, error: "This domain is already being monitored." });
  });
});

describe("updateDomainAction", () => {
  it("returns unauthorized when not an admin", async () => {
    mockedRequireAdmin.mockResolvedValue(false);

    const result = await updateDomainAction(1, { expirationSource: "rdap" });

    expect(result).toEqual({ ok: false, error: "unauthorized" });
    expect(mRepo.updateDomain).not.toHaveBeenCalled();
  });

  it("reports a missing domain before validating fields", async () => {
    mRepo.getDomainById.mockReturnValue(undefined as never);

    const result = await updateDomainAction(999, { expirationSource: "rdap" });

    expect(result).toEqual({ ok: false, error: "Domain not found." });
    expect(mRepo.updateDomain).not.toHaveBeenCalled();
  });

  it("rejects invalid fields without updating", async () => {
    mRepo.getDomainById.mockReturnValue(domainRow() as never);

    const result = await updateDomainAction(1, {
      expirationSource: "manual",
      expirationDate: "not-a-date",
    });

    expect(result).toEqual({ ok: false, error: "invalid_date" });
    expect(mRepo.updateDomain).not.toHaveBeenCalled();
  });

  it("updates the domain, replaces reminders and revalidates", async () => {
    mRepo.getDomainById.mockReturnValue(domainRow() as never);
    mRepo.updateDomain.mockReturnValue(true);

    const result = await updateDomainAction(1, {
      expirationSource: "manual",
      registrationDate: "2024-05-01",
      expirationDate: "2031-03-26",
      reminders: [60, 30],
    });

    expect(result).toEqual({ ok: true, hostname: "example.com" });
    expect(mRepo.updateDomain).toHaveBeenCalledWith(1, {
      expirationSource: "manual",
      registrationDate: "2024-05-01",
      expirationDate: "2031-03-26",
      registrationProvider: null,
      registrationProviderUrl: null,
    });
    expect(mRepo.setExpirationReminders).toHaveBeenCalledWith(1, [60, 30]);
    expect(mockedRevalidatePath).toHaveBeenCalledWith("/domains/1");
    expect(mockedRevalidatePath).toHaveBeenCalledWith("/");
  });

  it("clears manual dates when switching manual → rdap", async () => {
    mRepo.getDomainById.mockReturnValue(domainRow({ expirationSource: "manual" }) as never);
    mRepo.updateDomain.mockReturnValue(true);

    const result = await updateDomainAction(1, {
      expirationSource: "rdap",
      registrationDate: null,
      expirationDate: null,
    });

    expect(result).toEqual({ ok: true, hostname: "example.com" });
    expect(mRepo.updateDomain).toHaveBeenCalledWith(1, {
      expirationSource: "rdap",
      registrationDate: null,
      expirationDate: null,
      registrationProvider: null,
      registrationProviderUrl: null,
    });
  });
});

describe("refreshRdapAction", () => {
  it("returns unauthorized when not an admin", async () => {
    mockedRequireAdmin.mockResolvedValue(false);

    const result = await refreshRdapAction(1);

    expect(result).toEqual({ ok: false, error: "unauthorized" });
    expect(mockedQueryRdap).not.toHaveBeenCalled();
    expect(mRepo.updateDomainRdap).not.toHaveBeenCalled();
  });

  it("reports a missing domain without querying RDAP", async () => {
    mRepo.getDomainById.mockReturnValue(undefined as never);

    const result = await refreshRdapAction(999);

    expect(result).toEqual({ ok: false, error: "Domain not found." });
    expect(mockedQueryRdap).not.toHaveBeenCalled();
  });

  it("forwards an exact ownership result to the repository", async () => {
    mRepo.getDomainById.mockReturnValue(domainRow() as never);
    mockedQueryRdap.mockResolvedValue(exactRdapResult());

    const result = await refreshRdapAction(1);

    expect(result).toEqual({ ok: true, hostname: "example.com" });
    expect(mockedQueryRdap).toHaveBeenCalledWith("example.com");
    expect(mRepo.updateDomainRdap).toHaveBeenCalledWith(1, exactRdapResult().data, "exact");
    expect(mockedRevalidatePath).toHaveBeenCalledWith("/domains/1");
    expect(mockedRevalidatePath).toHaveBeenCalledWith("/");
  });

  it("forwards a parent ownership result without dropping it", async () => {
    mRepo.getDomainById.mockReturnValue(domainRow() as never);
    mockedQueryRdap.mockResolvedValue({
      data: {
        domainName: "EU.CC",
        status: ["active"],
        nameservers: ["ns.eu.cc"],
      },
      matchedHostname: "eu.cc",
      ownership: "parent",
    });

    const result = await refreshRdapAction(1);

    expect(result).toEqual({ ok: true, hostname: "example.com" });
    expect(mRepo.updateDomainRdap).toHaveBeenCalledWith(
      1,
      {
        domainName: "EU.CC",
        status: ["active"],
        nameservers: ["ns.eu.cc"],
      },
      "parent",
    );
  });

  it("forwards a no-object result (status empty, no dates) to the repository", async () => {
    mRepo.getDomainById.mockReturnValue(domainRow() as never);
    mockedQueryRdap.mockResolvedValue({
      data: {
        domainName: "NOPE.EXAMPLE",
        status: ["no-object"],
        nameservers: [],
      },
      matchedHostname: "nope.example",
      ownership: "exact",
    });

    const result = await refreshRdapAction(1);

    expect(result).toEqual({ ok: true, hostname: "example.com" });
    // The repository keeps expiration null for a no-object result; the
    // action must pass the data through unchanged.
    expect(mRepo.updateDomainRdap).toHaveBeenCalledWith(
      1,
      {
        domainName: "NOPE.EXAMPLE",
        status: ["no-object"],
        nameservers: [],
      },
      "exact",
    );
  });

  it("still refreshes a manual domain (repository layer protects the dates)", async () => {
    mRepo.getDomainById.mockReturnValue(domainRow({ expirationSource: "manual" }) as never);
    mockedQueryRdap.mockResolvedValue(exactRdapResult());

    const result = await refreshRdapAction(1);

    expect(result).toEqual({ ok: true, hostname: "example.com" });
    // The RDAP refresh runs, but updateDomainRdap's manual protection keeps
    // the operator's expiration/registration dates untouched (Phase 11A-6,
    // covered at the repository layer).
    expect(mRepo.updateDomainRdap).toHaveBeenCalledWith(1, exactRdapResult().data, "exact");
  });

  it("returns a user-safe error when the RDAP query fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mRepo.getDomainById.mockReturnValue(domainRow() as never);
    mockedQueryRdap.mockRejectedValue(new Error("timeout"));

    const result = await refreshRdapAction(1);

    expect(result).toEqual({
      ok: false,
      error: "RDAP information is currently unavailable.",
    });
    expect(mRepo.updateDomainRdap).not.toHaveBeenCalled();
    expect(mockedRevalidatePath).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe("deleteDomainAction", () => {
  it("returns unauthorized when not an admin", async () => {
    mockedRequireAdmin.mockResolvedValue(false);

    const result = await deleteDomainAction(1);

    expect(result).toEqual({ ok: false, error: "unauthorized" });
    expect(mRepo.deleteDomain).not.toHaveBeenCalled();
  });

  it("reports a missing domain when nothing was deleted", async () => {
    mRepo.deleteDomain.mockReturnValue(false);

    const result = await deleteDomainAction(999);

    expect(result).toEqual({ ok: false, error: "Domain not found." });
    expect(mockedRevalidatePath).not.toHaveBeenCalled();
  });

  it("deletes the domain and revalidates", async () => {
    mRepo.deleteDomain.mockReturnValue(true);

    const result = await deleteDomainAction(1);

    expect(result).toEqual({ ok: true, hostname: "" });
    expect(mRepo.deleteDomain).toHaveBeenCalledWith(1);
    expect(mockedRevalidatePath).toHaveBeenCalledWith("/");
  });

  it("reports a controlled failure when the repository throws", async () => {
    mRepo.deleteDomain.mockImplementation(() => {
      throw new Error("FK constraint failed");
    });

    const result = await deleteDomainAction(1);

    expect(result).toEqual({ ok: false, error: "Failed to delete the domain." });
  });
});
