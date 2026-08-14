import { describe, expect, it, vi } from "vitest";
import { checkHttpAction } from "./actions";
import { checkHttp } from "./service";

vi.mock("./service", () => ({
  checkHttp: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import { revalidatePath } from "next/cache";

const mockedCheckHttp = vi.mocked(checkHttp);
const mockedRevalidatePath = vi.mocked(revalidatePath);

describe("checkHttpAction", () => {
  it("returns the mapped result and revalidates on success", async () => {
    mockedCheckHttp.mockResolvedValue({
      ok: true,
      snapshotId: 42,
      checkedAt: new Date("2026-08-13T00:00:00.000Z"),
    });

    const result = await checkHttpAction(7);

    expect(result).toEqual({
      ok: true,
      snapshotId: 42,
      checkedAt: new Date("2026-08-13T00:00:00.000Z"),
    });
    expect(mockedRevalidatePath).toHaveBeenCalledWith("/domains/7");
    expect(mockedRevalidatePath).toHaveBeenCalledWith("/");
  });

  it("returns the error without revalidating on failure", async () => {
    mockedCheckHttp.mockResolvedValue({
      ok: false,
      error: "HTTP monitoring unavailable.",
    });
    mockedRevalidatePath.mockClear();

    const result = await checkHttpAction(7);

    expect(result).toEqual({ ok: false, error: "HTTP monitoring unavailable." });
    expect(mockedRevalidatePath).not.toHaveBeenCalled();
  });

  it("forwards the snapshot id from the service", async () => {
    mockedCheckHttp.mockResolvedValue({
      ok: true,
      snapshotId: 1,
      checkedAt: new Date("2026-08-13T00:00:00.000Z"),
    });

    const result = await checkHttpAction(7);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.snapshotId).toBe(1);
    }
  });
});
