import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearAdminSessionCookie,
  isAdminConfigured,
  loginAdmin,
  recoverAdmin,
  setAdminSessionCookie,
  setupAdmin,
} from "./admin";
import {
  loginAdminAction,
  logoutAdminAction,
  recoverAdminAction,
  setupAdminAction,
} from "./actions";

vi.mock("./admin", () => ({
  clearAdminSessionCookie: vi.fn(),
  isAdminConfigured: vi.fn(),
  loginAdmin: vi.fn(),
  recoverAdmin: vi.fn(),
  setAdminSessionCookie: vi.fn(),
  setupAdmin: vi.fn(),
}));

const mockedIsAdminConfigured = vi.mocked(isAdminConfigured);
const mockedSetupAdmin = vi.mocked(setupAdmin);
const mockedLoginAdmin = vi.mocked(loginAdmin);
const mockedRecoverAdmin = vi.mocked(recoverAdmin);
const mockedSetSessionCookie = vi.mocked(setAdminSessionCookie);
const mockedClearSessionCookie = vi.mocked(clearAdminSessionCookie);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("setupAdminAction", () => {
  it("returns the one-time recovery code on success", async () => {
    mockedIsAdminConfigured.mockReturnValue(false);
    mockedSetupAdmin.mockReturnValue({ recoveryCode: "ab".repeat(16) });

    const result = await setupAdminAction({ password: "correct horse battery staple" });

    expect(result).toEqual({ ok: true, recoveryCode: "ab".repeat(16) });
    expect(mockedSetSessionCookie).toHaveBeenCalledTimes(1);
  });

  it("rejects when already configured", async () => {
    mockedIsAdminConfigured.mockReturnValue(true);
    const result = await setupAdminAction({ password: "correct horse battery staple" });
    expect(result).toEqual({ ok: false, error: "auth.errors.alreadyConfigured" });
    expect(mockedSetupAdmin).not.toHaveBeenCalled();
  });

  it("rejects short passwords without touching the admin module", async () => {
    mockedIsAdminConfigured.mockReturnValue(false);
    const result = await setupAdminAction({ password: "short" });
    expect(result).toEqual({ ok: false, error: "auth.errors.passwordTooShort" });
    expect(mockedSetupAdmin).not.toHaveBeenCalled();
    expect(mockedSetSessionCookie).not.toHaveBeenCalled();
  });
});

describe("loginAdminAction", () => {
  it("sets the session cookie on success", async () => {
    mockedLoginAdmin.mockReturnValue(true);
    const result = await loginAdminAction({ password: "correct horse battery staple" });
    expect(result).toEqual({ ok: true });
    expect(mockedSetSessionCookie).toHaveBeenCalledTimes(1);
  });

  it("returns the uniform error on failure (no account enumeration)", async () => {
    mockedLoginAdmin.mockReturnValue(false);
    const result = await loginAdminAction({ password: "wrong password" });
    expect(result).toEqual({ ok: false, error: "auth.errors.invalidCredentials" });
    expect(mockedSetSessionCookie).not.toHaveBeenCalled();
  });

  it("coerces non-string input to a failed login", async () => {
    mockedLoginAdmin.mockReturnValue(false);
    const result = await loginAdminAction({ password: 12345 });
    expect(result).toEqual({ ok: false, error: "auth.errors.invalidCredentials" });
  });
});

describe("logoutAdminAction", () => {
  it("clears the session cookie", async () => {
    const result = await logoutAdminAction();
    expect(result).toEqual({ ok: true });
    expect(mockedClearSessionCookie).toHaveBeenCalledTimes(1);
  });
});

describe("recoverAdminAction", () => {
  it("returns the new recovery code on success", async () => {
    mockedRecoverAdmin.mockReturnValue({ ok: true, recoveryCode: "cd".repeat(16) });
    const result = await recoverAdminAction({
      recoveryCode: "ab".repeat(16),
      password: "a brand new password",
    });
    expect(result).toEqual({ ok: true, recoveryCode: "cd".repeat(16) });
    expect(mockedSetSessionCookie).toHaveBeenCalledTimes(1);
  });

  it("returns the uniform error for an invalid recovery code", async () => {
    mockedRecoverAdmin.mockReturnValue({ ok: false });
    const result = await recoverAdminAction({
      recoveryCode: "bad-code",
      password: "a brand new password",
    });
    expect(result).toEqual({ ok: false, error: "auth.errors.invalidRecoveryCode" });
    expect(mockedSetSessionCookie).not.toHaveBeenCalled();
  });

  it("rejects short passwords", async () => {
    const result = await recoverAdminAction({
      recoveryCode: "ab".repeat(16),
      password: "short",
    });
    expect(result).toEqual({ ok: false, error: "auth.errors.passwordTooShort" });
    expect(mockedRecoverAdmin).not.toHaveBeenCalled();
  });
});
