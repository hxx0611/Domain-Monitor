import { describe, expect, it } from "vitest";
import { generateRecoveryCode, hashPassword, verifyPassword } from "./password";

describe("hashPassword / verifyPassword", () => {
  it("verifies a correct password", () => {
    const stored = hashPassword("correct horse battery staple");
    expect(verifyPassword("correct horse battery staple", stored)).toBe(true);
  });

  it("rejects a wrong password", () => {
    const stored = hashPassword("correct horse battery staple");
    expect(verifyPassword("wrong password", stored)).toBe(false);
  });

  it("uses a fresh random salt on every hash (no two hashes equal)", () => {
    const a = hashPassword("same password");
    const b = hashPassword("same password");
    expect(a).not.toBe(b);
    // Both must still verify.
    expect(verifyPassword("same password", a)).toBe(true);
    expect(verifyPassword("same password", b)).toBe(true);
  });

  it("never stores the plaintext", () => {
    const stored = hashPassword("super-secret-value");
    expect(stored).not.toContain("super-secret-value");
    expect(stored.startsWith("scrypt$")).toBe(true);
  });

  it("returns false (does not throw) for malformed stored values", () => {
    expect(verifyPassword("anything", "")).toBe(false);
    expect(verifyPassword("anything", "scrypt$16384$8$1$00$00")).toBe(false);
    expect(verifyPassword("anything", "bcrypt$abc")).toBe(false);
    expect(verifyPassword("anything", "not-a-hash")).toBe(false);
  });
});

describe("generateRecoveryCode", () => {
  it("returns a 128-bit hex string (32 characters)", () => {
    const code = generateRecoveryCode();
    expect(code).toMatch(/^[0-9a-f]{32}$/);
  });

  it("produces distinct codes", () => {
    const codes = new Set(Array.from({ length: 100 }, () => generateRecoveryCode()));
    expect(codes.size).toBe(100);
  });
});
