/**
 * Registration platform presets & management-URL safety (Phase 11A).
 *
 * The presets are UI constants, not a database table — the project is a
 * small single-table SQLite app and `domains.registrationProvider` /
 * `registrationProviderUrl` are free-form columns. Only well-known official
 * website URLs are shipped (Phase 11A-11: no guessed URLs). Management
 * consoles (login-scoped domain managers) have no stable public template,
 * so the presets intentionally point at the provider's official site; the
 * operator may supply a specific manage URL which is strictly validated.
 */

export interface RegistrationProvider {
  /** Stable machine id, stored in `domains.registrationProvider`. */
  id: string;
  /** Display name. */
  name: string;
  /** Official website URL (https). */
  websiteUrl: string;
}

/** Built-in registration providers (official URLs verified 2026-08-18). */
export const REGISTRATION_PROVIDERS: readonly RegistrationProvider[] = [
  { id: "gname", name: "GNAME", websiteUrl: "https://www.gname.vip/" },
  { id: "cloudflare", name: "Cloudflare Registrar", websiteUrl: "https://dash.cloudflare.com/" },
  { id: "namecheap", name: "Namecheap", websiteUrl: "https://www.namecheap.com/" },
  { id: "godaddy", name: "GoDaddy", websiteUrl: "https://www.godaddy.com/" },
  { id: "porkbun", name: "Porkbun", websiteUrl: "https://porkbun.com/" },
] as const;

/** Look up a preset by its machine id (used for the Manage Domain link). */
export function getRegistrationProvider(id: string): RegistrationProvider | undefined {
  return REGISTRATION_PROVIDERS.find((provider) => provider.id === id);
}

/** Words that must never appear in a management URL (Phase 11A-14). */
const FORBIDDEN_URL_FRAGMENTS = ["token", "password", "api_key", "apikey", "secret"];

/**
 * Validate an operator-supplied registration manage URL (Phase 11A-3/14).
 *
 * Rules:
 * - must be an absolute, parseable URL;
 * - scheme must be `https:` only (http, javascript:, data:, file:, … all
 *   rejected);
 * - no credentials embedded (`user:pass@host`);
 * - the URL (lowercased) must not contain credential-like words
 *   (token / password / api_key / apikey / secret) — management links must
 *   never carry or look like they carry credentials.
 *
 * Returns the normalized URL string on success, or an error key on
 * failure: "invalid_url" | "invalid_scheme" | "invalid_credentials" |
 * "forbidden_credential_word".
 */
export function validateManagementUrl(
  raw: string,
): { ok: true; url: string } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, error: "invalid_url" };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: "invalid_url" };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, error: "invalid_scheme" };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: "invalid_credentials" };
  }
  const lower = trimmed.toLowerCase();
  for (const fragment of FORBIDDEN_URL_FRAGMENTS) {
    if (lower.includes(fragment)) {
      return { ok: false, error: "forbidden_credential_word" };
    }
  }
  return { ok: true, url: parsed.toString() };
}
