/**
 * Registration provider presets & management-URL validation (Phase 11A).
 */
import { describe, expect, it } from "vitest";
import {
  REGISTRATION_PROVIDERS,
  getRegistrationProvider,
  validateManagementUrl,
} from "./providers";

describe("REGISTRATION_PROVIDERS", () => {
  it("ships the five well-known providers", () => {
    expect(REGISTRATION_PROVIDERS.map((provider) => provider.id)).toEqual([
      "gname",
      "cloudflare",
      "namecheap",
      "godaddy",
      "porkbun",
    ]);
  });

  it("every preset has a display name and an https website URL", () => {
    for (const provider of REGISTRATION_PROVIDERS) {
      expect(provider.name.length).toBeGreaterThan(0);
      expect(provider.websiteUrl.startsWith("https://")).toBe(true);
      expect(() => new URL(provider.websiteUrl)).not.toThrow();
    }
  });

  it("preset ids are unique", () => {
    const ids = REGISTRATION_PROVIDERS.map((provider) => provider.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("getRegistrationProvider finds presets by id and returns undefined otherwise", () => {
    expect(getRegistrationProvider("gname")?.name).toBe("GNAME");
    expect(getRegistrationProvider("nope")).toBeUndefined();
  });
});

describe("validateManagementUrl", () => {
  it("accepts a plain https URL and normalizes it", () => {
    const result = validateManagementUrl("  https://dash.cloudflare.com/domains  ");
    expect(result).toEqual({ ok: true, url: "https://dash.cloudflare.com/domains" });
  });

  it("accepts an https URL with a path/query that contains no credential words", () => {
    expect(validateManagementUrl("https://www.gname.vip/user/domains?tab=renew")).toEqual({
      ok: true,
      url: "https://www.gname.vip/user/domains?tab=renew",
    });
  });

  it("rejects empty input", () => {
    expect(validateManagementUrl("")).toEqual({ ok: false, error: "invalid_url" });
    expect(validateManagementUrl("   ")).toEqual({ ok: false, error: "invalid_url" });
  });

  it("rejects non-parseable URLs", () => {
    expect(validateManagementUrl("not a url")).toEqual({ ok: false, error: "invalid_url" });
  });

  it("rejects non-https schemes (http, javascript:, data:, file:)", () => {
    expect(validateManagementUrl("http://example.com/manage")).toEqual({
      ok: false,
      error: "invalid_scheme",
    });
    expect(validateManagementUrl("javascript:alert(1)")).toEqual({
      ok: false,
      error: "invalid_scheme",
    });
    expect(validateManagementUrl("data:text/html,hi")).toEqual({
      ok: false,
      error: "invalid_scheme",
    });
    expect(validateManagementUrl("file:///etc/passwd")).toEqual({
      ok: false,
      error: "invalid_scheme",
    });
  });

  it("rejects embedded credentials (user:pass@host)", () => {
    expect(validateManagementUrl("https://user:pass@example.com/manage")).toEqual({
      ok: false,
      error: "invalid_credentials",
    });
  });

  it("rejects URLs containing credential-like words (token/password/api_key/secret)", () => {
    for (const url of [
      "https://example.com/manage?token=abc123",
      "https://example.com/manage/password",
      "https://example.com/register?api_key=xyz",
      "https://example.com/secret/settings",
    ]) {
      expect(validateManagementUrl(url), url).toEqual({
        ok: false,
        error: "forbidden_credential_word",
      });
    }
  });

  it("rejects URLs with uppercase credential words (case-insensitive)", () => {
    expect(validateManagementUrl("https://example.com/manage?TOKEN=abc")).toEqual({
      ok: false,
      error: "forbidden_credential_word",
    });
  });
});
