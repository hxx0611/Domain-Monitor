"use server";

import { revalidatePath } from "next/cache";
import {
  createDomain,
  deleteDomain,
  getDomainById,
  setExpirationReminders,
  updateDomain,
  updateDomainRdap,
} from "./repository";
import { normalizeHostname, validateManualDates, normalizeReminderDaysList } from "./validation";
import { validateManagementUrl } from "./providers";
import { queryRdapWithFallback } from "@/lib/rdap";
import { requireAdmin } from "@/lib/auth/admin";

export type DomainActionResult = { ok: true; hostname: string } | { ok: false; error: string };

const UNAUTHORIZED_ERROR = "unauthorized";
const RDAP_UNAVAILABLE_MESSAGE = "RDAP information is currently unavailable.";

/**
 * Manual-expiration / registration-platform fields (Phase 11A).
 *
 * `expirationSource`:
 *   - "rdap"    — automatic; RDAP refresh owns the dates (default).
 *   - "manual"  — operator maintains `registrationDate`/`expirationDate`;
 *                 automatic RDAP refresh must never overwrite them.
 * `registrationProvider` / `registrationProviderUrl` — free-form; the URL
 *   must pass `validateManagementUrl` when present.
 * `reminders` — days-before-expiration notifications (1..3650, deduped).
 */
export interface DomainFields {
  expirationSource: "rdap" | "manual";
  registrationDate?: string | null;
  expirationDate?: string | null;
  registrationProvider?: string | null;
  registrationProviderUrl?: string | null;
  reminders?: number[];
}

/** Validate the manual portion of a DomainFields input (server-side). */
function validateDomainFields(fields: DomainFields | undefined):
  | {
      ok: true;
      fields: Required<
        Pick<
          DomainFields,
          | "expirationSource"
          | "registrationDate"
          | "expirationDate"
          | "registrationProvider"
          | "registrationProviderUrl"
        >
      > & { reminders: number[] };
    }
  | { ok: false; error: string } {
  const source = fields?.expirationSource ?? "rdap";
  if (source !== "rdap" && source !== "manual") {
    return { ok: false, error: "invalid_expiration_source" };
  }

  let registrationDate: string | null = null;
  let expirationDate: string | null = null;
  if (source === "manual") {
    const dates = validateManualDates(fields?.registrationDate, fields?.expirationDate);
    if (!dates.ok) {
      return { ok: false, error: dates.error };
    }
    registrationDate = dates.registrationDate;
    expirationDate = dates.expirationDate;
  }

  const registrationProvider = fields?.registrationProvider?.trim() || null;
  const registrationProviderUrl = fields?.registrationProviderUrl?.trim() || null;
  if (registrationProviderUrl !== null) {
    const url = validateManagementUrl(registrationProviderUrl);
    if (!url.ok) {
      return { ok: false, error: url.error };
    }
  }

  const reminders = normalizeReminderDaysList(fields?.reminders ?? []);
  if (!reminders.ok) {
    return { ok: false, error: reminders.error };
  }

  return {
    ok: true,
    fields: {
      expirationSource: source,
      registrationDate,
      expirationDate,
      registrationProvider,
      registrationProviderUrl: registrationProviderUrl ?? null,
      reminders: reminders.days,
    },
  };
}

/**
 * Create a domain from raw user input.
 *
 * Validation and normalization happen here. The domain row is created first;
 * an RDAP enrichment query then runs best-effort — a failing RDAP service
 * must never prevent the domain from being created. For manual domains the
 * RDAP query still runs (its metadata/status are stored, and the
 * `updateDomainRdap` manual protection keeps the operator's dates intact).
 */
export async function createDomainAction(
  input: string,
  fields?: DomainFields,
): Promise<DomainActionResult> {
  if (!(await requireAdmin())) {
    return { ok: false, error: UNAUTHORIZED_ERROR };
  }
  const result = normalizeHostname(input);

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  const validated = validateDomainFields(fields);
  if (!validated.ok) {
    return { ok: false, error: validated.error };
  }

  let domain;
  try {
    domain = createDomain(result.hostname, {
      expirationSource: validated.fields.expirationSource,
      registrationDate: validated.fields.registrationDate,
      expirationDate: validated.fields.expirationDate,
      registrationProvider: validated.fields.registrationProvider,
      registrationProviderUrl: validated.fields.registrationProviderUrl,
    });
  } catch {
    // Unique-constraint race: another request inserted the same hostname
    // between our existence check and the insert.
    return { ok: false, error: "This domain is already being monitored." };
  }

  if (!domain) {
    return { ok: false, error: "This domain is already being monitored." };
  }

  if (validated.fields.reminders.length > 0) {
    setExpirationReminders(domain.id, validated.fields.reminders);
  }

  if (domain.expirationSource !== "manual") {
    try {
      const { data, ownership } = await queryRdapWithFallback(domain.hostname);
      updateDomainRdap(domain.id, data, ownership);
    } catch (error) {
      // Domain creation still succeeds; the detail page shows
      // "RDAP information unavailable." with a manual Refresh option.
      console.error(`[rdap] initial query failed for ${domain.hostname}:`, error);
    }
  }

  revalidatePath("/");
  return { ok: true, hostname: domain.hostname };
}

/**
 * Update a domain's expiration source / manual dates / registration
 * platform / reminders (Phase 11A). Reminders are replaced wholesale.
 * Switching Manual → Automatic clears the manual dates (RDAP will
 * re-populate them on the next Refresh); switching Automatic → Manual
 * applies the supplied dates immediately.
 */
export async function updateDomainAction(
  id: number,
  fields: DomainFields,
): Promise<DomainActionResult> {
  if (!(await requireAdmin())) {
    return { ok: false, error: UNAUTHORIZED_ERROR };
  }
  const domain = getDomainById(id);

  if (!domain) {
    return { ok: false, error: "Domain not found." };
  }

  const validated = validateDomainFields(fields);
  if (!validated.ok) {
    return { ok: false, error: validated.error };
  }

  updateDomain(id, {
    expirationSource: validated.fields.expirationSource,
    registrationDate: validated.fields.registrationDate,
    expirationDate: validated.fields.expirationDate,
    registrationProvider: validated.fields.registrationProvider,
    registrationProviderUrl: validated.fields.registrationProviderUrl,
  });
  setExpirationReminders(id, validated.fields.reminders);

  revalidatePath(`/domains/${id}`);
  revalidatePath("/");
  return { ok: true, hostname: domain.hostname };
}

/**
 * Re-run the RDAP query for an existing domain and persist the result.
 * Returns a user-safe error message on failure (details go to server logs).
 */
export async function refreshRdapAction(id: number): Promise<DomainActionResult> {
  if (!(await requireAdmin())) {
    return { ok: false, error: UNAUTHORIZED_ERROR };
  }
  const domain = getDomainById(id);

  if (!domain) {
    return { ok: false, error: "Domain not found." };
  }

  try {
    const { data, ownership } = await queryRdapWithFallback(domain.hostname);
    updateDomainRdap(id, data, ownership);
  } catch (error) {
    console.error(`[rdap] refresh failed for domain ${id} (${domain.hostname}):`, error);
    return { ok: false, error: RDAP_UNAVAILABLE_MESSAGE };
  }

  revalidatePath(`/domains/${id}`);
  revalidatePath("/");
  return { ok: true, hostname: domain.hostname };
}

export async function deleteDomainAction(id: number): Promise<DomainActionResult> {
  if (!(await requireAdmin())) {
    return { ok: false, error: UNAUTHORIZED_ERROR };
  }
  try {
    const deleted = deleteDomain(id);

    if (!deleted) {
      return { ok: false, error: "Domain not found." };
    }

    revalidatePath("/");
    return { ok: true, hostname: "" };
  } catch {
    return { ok: false, error: "Failed to delete the domain." };
  }
}
