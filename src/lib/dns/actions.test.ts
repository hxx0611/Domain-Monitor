/**
 * Phase 13B — DNS server action contract tests.
 *
 * Covers checkDnsAction. The DNS service and admin boundary are mocked; no
 * DNS client, resolver or database is touched. Mirrors the http action
 * contract: unauthorized short-circuit, result passthrough on success,
 * error passthrough (with optional errorCode) without revalidation.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkDnsAction } from "./actions";
import { checkDns } from "./service";
import { requireAdmin } from "@/lib/auth/admin";

vi.mock("./service", () => ({ checkDns: vi.fn() }));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/auth/admin", () => ({
  requireAdmin: vi.fn(),
}));

import { revalidatePath } from "next/cache";

const mockedCheckDns = vi.mocked(checkDns);
const mockedRevalidatePath = vi.mocked(revalidatePath);
const mockedRequireAdmin = vi.mocked(requireAdmin);

const A_RECORD = { type: "A", name: "example.com", value: "1.2.3.4" } as const;

describe("checkDnsAction", () => {
  beforeEach(() => {
    mockedRequireAdmin.mockResolvedValue(true);
  });

  it("returns unauthorized without touching the service when not an admin", async () => {
    mockedRequireAdmin.mockResolvedValue(false);

    const result = await checkDnsAction(7);

    expect(result).toEqual({ ok: false, error: "unauthorized" });
    expect(mockedCheckDns).not.toHaveBeenCalled();
    expect(mockedRevalidatePath).not.toHaveBeenCalled();
  });

  it("returns the mapped result and revalidates on success", async () => {
    const checkedAt = new Date("2026-08-20T00:00:00.000Z");
    mockedCheckDns.mockResolvedValue({
      ok: true,
      snapshotId: 42,
      checkedAt,
      changes: [{ type: "RECORD_ADDED", record: A_RECORD }],
    });

    const result = await checkDnsAction(7);

    expect(result).toEqual({
      ok: true,
      snapshotId: 42,
      checkedAt,
      changes: [{ type: "RECORD_ADDED", record: A_RECORD }],
    });
    expect(mockedRevalidatePath).toHaveBeenCalledWith("/domains/7");
    expect(mockedRevalidatePath).toHaveBeenCalledWith("/");
  });

  it("returns an empty change list on the first check", async () => {
    const checkedAt = new Date("2026-08-20T00:00:00.000Z");
    mockedCheckDns.mockResolvedValue({
      ok: true,
      snapshotId: 1,
      checkedAt,
      changes: [],
    });

    const result = await checkDnsAction(7);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.changes).toEqual([]);
    }
  });

  it("returns the error without revalidating on failure", async () => {
    mockedCheckDns.mockResolvedValue({
      ok: false,
      error: "DNS monitoring unavailable.",
    });
    mockedRevalidatePath.mockClear();

    const result = await checkDnsAction(7);

    expect(result).toEqual({ ok: false, error: "DNS monitoring unavailable." });
    expect(mockedRevalidatePath).not.toHaveBeenCalled();
  });

  it("forwards the errorCode from the service on failure", async () => {
    mockedCheckDns.mockResolvedValue({
      ok: false,
      error: "DNS monitoring unavailable.",
      errorCode: "dns_timeout",
    });
    mockedRevalidatePath.mockClear();

    const result = await checkDnsAction(7);

    expect(result).toEqual({
      ok: false,
      error: "DNS monitoring unavailable.",
      errorCode: "dns_timeout",
    });
    expect(mockedRevalidatePath).not.toHaveBeenCalled();
  });
});
