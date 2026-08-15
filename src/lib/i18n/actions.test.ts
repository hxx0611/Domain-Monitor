/**
 * Locale server action tests (V0.7.x — Phase 3).
 *
 * setLocaleAction must strictly validate before writing the cookie,
 * use safe cookie attributes, and never touch DB / notifications / secrets.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("next/headers", () => ({
  cookies: vi.fn(),
}));

import { cookies } from "next/headers";
import { setLocaleAction } from "./actions";
import { COOKIE_NAME } from "./config";

const mockCookies = vi.mocked(cookies);

function mockCookieStore() {
  const set = vi.fn();
  const get = vi.fn();
  mockCookies.mockResolvedValue({ set, get } as never);
  return { set, get };
}

describe("setLocaleAction", () => {
  beforeEach(() => {
    mockCookies.mockReset();
  });

  it("writes the cookie for zh-CN", async () => {
    const { set } = mockCookieStore();
    const result = await setLocaleAction("zh-CN");

    expect(result).toEqual({ ok: true, locale: "zh-CN" });
    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith(COOKIE_NAME, "zh-CN", {
      path: "/",
      sameSite: "lax",
    });
  });

  it("writes the cookie for en", async () => {
    const { set } = mockCookieStore();
    const result = await setLocaleAction("en");

    expect(result).toEqual({ ok: true, locale: "en" });
    expect(set).toHaveBeenCalledWith(COOKIE_NAME, "en", {
      path: "/",
      sameSite: "lax",
    });
  });

  it("rejects invalid locales without writing a cookie", async () => {
    for (const invalid of ["fr", "EN", "en-US", "zh", "zh_CN", "", "de"]) {
      const { set } = mockCookieStore();
      const result = await setLocaleAction(invalid);
      expect(result).toEqual({ ok: false });
      expect(set, `must not write cookie for ${invalid}`).not.toHaveBeenCalled();
    }
  });

  it("uses path=/ and sameSite=lax (no HttpOnly, no Secure for local dev)", async () => {
    const { set } = mockCookieStore();
    await setLocaleAction("zh-CN");
    const options = set.mock.calls[0][2] as Record<string, unknown>;
    expect(options.path).toBe("/");
    expect(options.sameSite).toBe("lax");
    expect(options.httpOnly).toBeUndefined();
    expect(options.secure).toBeUndefined();
  });

  it("touches no database or notifications (no imports beyond cookies/config)", () => {
    // Static guard: the action module must not import any business layer.
    const source = readFileSync(__dirname + "/actions.ts", "utf8");
    const importLines = source.split(/\n/).filter((line) => /^import /.test(line));
    for (const line of importLines) {
      expect(line).not.toMatch(/@\/lib\/(dns|ssl|http|domains|notifications|rdap)/);
      expect(line).not.toContain("process.env");
    }
  });
});
