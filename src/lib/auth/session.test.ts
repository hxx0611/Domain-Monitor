import { describe, expect, it } from "vitest";
import { createSessionValue, sessionCookieOptions, verifySessionValue } from "./session";

const SECRET = "test-session-secret-that-is-long-enough";

describe("createSessionValue / verifySessionValue", () => {
  it("accepts a freshly created session", () => {
    const now = 1_000_000_000_000;
    const value = createSessionValue(SECRET, now);
    expect(verifySessionValue(value, SECRET, now)).toBe(true);
  });

  it("rejects a session with the wrong secret", () => {
    const value = createSessionValue(SECRET, Date.now());
    expect(verifySessionValue(value, "another-secret", Date.now())).toBe(false);
  });

  it("rejects an expired session", () => {
    const created = 1_000_000_000_000;
    const value = createSessionValue(SECRET, created);
    // Just after the 7-day TTL.
    expect(verifySessionValue(value, SECRET, created + 7 * 24 * 60 * 60 * 1000 + 1)).toBe(false);
  });

  it("accepts a session inside the TTL window", () => {
    const created = 1_000_000_000_000;
    const value = createSessionValue(SECRET, created);
    expect(verifySessionValue(value, SECRET, created + 6 * 24 * 60 * 60 * 1000)).toBe(true);
  });

  it("rejects tampered payloads (signature no longer matches)", () => {
    const now = Date.now();
    const value = createSessionValue(SECRET, now);
    const [version, expiry, entropy, signature] = value.split(".");
    // Flip the entropy bytes: the signature no longer matches.
    const flipped = entropy
      .split("")
      .map((ch, index) => (index === 0 ? (ch === "A" ? "B" : "A") : ch))
      .join("");
    const tampered = `${version}.${expiry}.${flipped}.${signature}`;
    expect(verifySessionValue(tampered, SECRET, now)).toBe(false);
  });

  it("rejects malformed values", () => {
    expect(verifySessionValue("", SECRET, Date.now())).toBe(false);
    expect(verifySessionValue("1.abc", SECRET, Date.now())).toBe(false);
    expect(verifySessionValue("1.abc.def.ghi.extra", SECRET, Date.now())).toBe(false);
    expect(verifySessionValue("9.abc.def.ghi", SECRET, Date.now())).toBe(false);
  });

  it("produces unique values (entropy per session)", () => {
    const a = createSessionValue(SECRET, Date.now());
    const b = createSessionValue(SECRET, Date.now());
    expect(a).not.toBe(b);
  });
});

describe("sessionCookieOptions", () => {
  it("is HttpOnly + SameSite=Lax with path=/", () => {
    const options = sessionCookieOptions(false);
    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe("lax");
    expect(options.path).toBe("/");
    expect(options.maxAge).toBe(7 * 24 * 60 * 60);
  });

  it("is Secure in production, not Secure otherwise", () => {
    expect(sessionCookieOptions(true).secure).toBe(true);
    expect(sessionCookieOptions(false).secure).toBe(false);
  });
});
