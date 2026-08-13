import { describe, expect, it, vi } from "vitest";
import { checkSslAction } from "./actions";
import { checkSsl } from "./service";
import type { SslChange } from "./types";

vi.mock("./service", () => ({
  checkSsl: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import { revalidatePath } from "next/cache";

const mockedCheckSsl = vi.mocked(checkSsl);
const mockedRevalidatePath = vi.mocked(revalidatePath);

const CHANGE: SslChange = {
  type: "CERT_REPLACED",
  previousFingerprint: "AA:BB",
  currentFingerprint: "CC:DD",
};

describe("checkSslAction", () => {
  it("returns the mapped result and revalidates on success", async () => {
    mockedCheckSsl.mockResolvedValue({
      ok: true,
      snapshotId: 42,
      checkedAt: new Date("2026-08-13T00:00:00.000Z"),
      changes: [CHANGE],
    });

    const result = await checkSslAction(7);

    expect(result).toEqual({
      ok: true,
      snapshotId: 42,
      checkedAt: new Date("2026-08-13T00:00:00.000Z"),
      changes: [CHANGE],
    });
    expect(mockedRevalidatePath).toHaveBeenCalledWith("/domains/7");
    expect(mockedRevalidatePath).toHaveBeenCalledWith("/");
  });

  it("returns the error without revalidating on failure", async () => {
    mockedCheckSsl.mockResolvedValue({
      ok: false,
      error: "SSL monitoring unavailable.",
    });
    mockedRevalidatePath.mockClear();

    const result = await checkSslAction(7);

    expect(result).toEqual({ ok: false, error: "SSL monitoring unavailable." });
    expect(mockedRevalidatePath).not.toHaveBeenCalled();
  });

  it("forwards an empty changes list on the first check", async () => {
    mockedCheckSsl.mockResolvedValue({
      ok: true,
      snapshotId: 1,
      checkedAt: new Date("2026-08-13T00:00:00.000Z"),
      changes: [],
    });

    const result = await checkSslAction(7);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.changes).toEqual([]);
    }
  });
});
