import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../../../test/helpers";
import { createSQLiteRepository } from "@/db/adapters/sqlite";
import type { Repository } from "@/db/repository";
import type { AdminDb } from "./admin";
import {
  getAdminRow,
  getEncryptionKey,
  getSessionSecret,
  insertAdminRow,
  isAdminAuthenticated,
  isAdminConfigured,
  loginAdmin,
  recoverAdmin,
  requirePageAccess,
  setupAdmin,
  updateAdminRow,
} from "./admin";
import { createSessionValue } from "./session";

// In-memory cookie store shared by the mocked next/headers.
const cookieStore = vi.hoisted(() => new Map<string, string>());

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) =>
      cookieStore.has(name) ? { name, value: cookieStore.get(name) as string } : undefined,
    set: (name: string, value: string) => {
      cookieStore.set(name, value);
    },
    delete: (name: string) => {
      cookieStore.delete(name);
    },
  })),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => {
    throw new Error("NEXT_REDIRECT");
  }),
}));

const PASSWORD = "correct horse battery staple";

function repoOf(db: AdminDb): Repository {
  return createSQLiteRepository(db);
}

describe("setupAdmin", () => {
  let db: AdminDb;

  beforeEach(() => {
    db = createTestDb();
  });

  it("returns a 128-bit recovery code and configures login", async () => {
    const { recoveryCode } = await setupAdmin(PASSWORD, repoOf(db));
    expect(recoveryCode).toMatch(/^[0-9a-f]{32}$/);
    expect(isAdminConfigured(db)).toBe(true);
    expect(await loginAdmin(PASSWORD, repoOf(db))).toBe(true);
  });

  it("throws when called twice (first-run only)", async () => {
    await setupAdmin(PASSWORD, repoOf(db));
    await expect(setupAdmin("another password here", repoOf(db))).rejects.toThrow(
      /already configured/,
    );
  });
});

describe("loginAdmin", () => {
  let db: AdminDb;

  beforeEach(async () => {
    db = createTestDb();
    await setupAdmin(PASSWORD, repoOf(db));
  });

  it("rejects a wrong password", async () => {
    expect(await loginAdmin("wrong password", repoOf(db))).toBe(false);
  });

  it("rejects empty input", async () => {
    expect(await loginAdmin("", repoOf(db))).toBe(false);
  });
});

describe("loginAdmin on an unconfigured install", () => {
  it("returns false (never reveals the account state)", async () => {
    const db = createTestDb();
    expect(await loginAdmin(PASSWORD, repoOf(db))).toBe(false);
    expect(await loginAdmin("", repoOf(db))).toBe(false);
  });
});

describe("recoverAdmin", () => {
  let db: AdminDb;

  beforeEach(() => {
    db = createTestDb();
  });

  it("resets password, rotates the recovery code and the session secret", async () => {
    const { recoveryCode } = await setupAdmin(PASSWORD, repoOf(db));
    const secretBefore = getSessionSecret(db);

    const result = await recoverAdmin(recoveryCode, "a brand new password", repoOf(db));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    // New password works, old one does not.
    expect(await loginAdmin("a brand new password", repoOf(db))).toBe(true);
    expect(await loginAdmin(PASSWORD, repoOf(db))).toBe(false);

    // Old recovery code is consumed; the new one works.
    expect((await recoverAdmin(recoveryCode, "yet another password", repoOf(db))).ok).toBe(false);
    expect((await recoverAdmin(result.recoveryCode, "yet another password", repoOf(db))).ok).toBe(
      true,
    );

    // Session secret rotated → all old sessions invalid.
    expect(getSessionSecret(db)).not.toBe(secretBefore);
  });

  it("returns ok:false for a wrong recovery code without changing anything", async () => {
    await setupAdmin(PASSWORD, repoOf(db));
    const result = await recoverAdmin(
      "00000000000000000000000000000000",
      "a brand new password",
      repoOf(db),
    );
    expect(result).toEqual({ ok: false });
    expect(await loginAdmin(PASSWORD, repoOf(db))).toBe(true);
  });

  it("returns ok:false on an unconfigured install", async () => {
    const result = await recoverAdmin(
      "00000000000000000000000000000000",
      "a brand new password",
      repoOf(db),
    );
    expect(result).toEqual({ ok: false });
  });
});

describe("getSessionSecret", () => {
  let db: AdminDb;

  beforeEach(() => {
    db = createTestDb();
  });

  it("prefers the SESSION_SECRET env var when set", () => {
    const previous = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = "env-secret";
    try {
      expect(getSessionSecret(db)).toBe("env-secret");
    } finally {
      if (previous === undefined) {
        delete process.env.SESSION_SECRET;
      } else {
        process.env.SESSION_SECRET = previous;
      }
    }
  });

  it("falls back to the persisted DB secret after setup", async () => {
    await setupAdmin(PASSWORD, repoOf(db));
    expect(getSessionSecret(db)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("throws when nothing is initialized", () => {
    expect(() => getSessionSecret(db)).toThrow(/not initialized/);
  });
});

describe("getEncryptionKey (reserved for 9F)", () => {
  let db: AdminDb;

  beforeEach(() => {
    db = createTestDb();
  });

  it("prefers the ENCRYPTION_KEY env var when set", () => {
    const previous = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = "env-enc-key";
    try {
      expect(getEncryptionKey(db)).toBe("env-enc-key");
    } finally {
      if (previous === undefined) {
        delete process.env.ENCRYPTION_KEY;
      } else {
        process.env.ENCRYPTION_KEY = previous;
      }
    }
  });

  it("throws when nothing is initialized (no silent random key per process)", () => {
    expect(() => getEncryptionKey(db)).toThrow(/not initialized/);
  });
});

describe("isAdminAuthenticated", () => {
  let db: AdminDb;
  let repo: Repository;

  beforeEach(async () => {
    cookieStore.clear();
    db = createTestDb();
    repo = repoOf(db);
    await setupAdmin(PASSWORD, repo);
  });

  it("returns false with no cookie", async () => {
    expect(await isAdminAuthenticated(repo)).toBe(false);
  });

  it("returns true with a valid signed session cookie", async () => {
    const secret = getSessionSecret(db);
    cookieStore.set("dm_admin_session", createSessionValue(secret));
    expect(await isAdminAuthenticated(repo)).toBe(true);
  });

  it("returns false with a tampered cookie", async () => {
    cookieStore.set("dm_admin_session", "1.invalid.entropy.signature");
    expect(await isAdminAuthenticated(repo)).toBe(false);
  });
});

describe("requirePageAccess", () => {
  beforeEach(() => {
    cookieStore.clear();
  });

  it("redirects to /setup when the install is unconfigured", async () => {
    const db = createTestDb();
    await expect(requirePageAccess(repoOf(db))).rejects.toThrow("NEXT_REDIRECT");
  });

  it("redirects to /login when unauthenticated", async () => {
    const db = createTestDb();
    await setupAdmin(PASSWORD, repoOf(db));
    await expect(requirePageAccess(repoOf(db))).rejects.toThrow("NEXT_REDIRECT");
  });

  it("passes through when configured and authenticated", async () => {
    const db = createTestDb();
    await setupAdmin(PASSWORD, repoOf(db));
    const secret = getSessionSecret(db);
    cookieStore.set("dm_admin_session", createSessionValue(secret));
    await expect(requirePageAccess(repoOf(db))).resolves.toBeUndefined();
  });
});

describe("insertAdminRow / updateAdminRow", () => {
  it("persists a row and updates it in place", () => {
    const db = createTestDb();
    insertAdminRow(db, {
      passwordHash: "scrypt$hash-a",
      recoveryCodeHash: "scrypt$hash-b",
      sessionSecret: "secret-1",
    });
    expect(isAdminConfigured(db)).toBe(true);
    const row = getAdminRow(db);
    expect(row).toBeDefined();
    if (!row) {
      return;
    }
    updateAdminRow(db, row.id, { sessionSecret: "secret-2" });
    const updated = getAdminRow(db);
    expect(updated?.sessionSecret).toBe("secret-2");
  });
});
