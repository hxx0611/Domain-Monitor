"use server";

import { revalidatePath } from "next/cache";
import { createDomain, deleteDomain, getDomainById, updateDomainRdap } from "./repository";
import { normalizeHostname } from "./validation";
import { queryRdapWithFallback } from "@/lib/rdap";
import { requireAdmin } from "@/lib/auth/admin";

export type DomainActionResult = { ok: true; hostname: string } | { ok: false; error: string };

const UNAUTHORIZED_ERROR = "unauthorized";
const RDAP_UNAVAILABLE_MESSAGE = "RDAP information is currently unavailable.";

/**
 * Create a domain from raw user input.
 *
 * Validation and normalization happen here. The domain row is created first;
 * an RDAP enrichment query then runs best-effort — a failing RDAP service
 * must never prevent the domain from being created.
 */
export async function createDomainAction(input: string): Promise<DomainActionResult> {
  if (!(await requireAdmin())) {
    return { ok: false, error: UNAUTHORIZED_ERROR };
  }
  const result = normalizeHostname(input);

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  let domain;
  try {
    domain = createDomain(result.hostname);
  } catch {
    // Unique-constraint race: another request inserted the same hostname
    // between our existence check and the insert.
    return { ok: false, error: "This domain is already being monitored." };
  }

  if (!domain) {
    return { ok: false, error: "This domain is already being monitored." };
  }

  try {
    const { data, ownership } = await queryRdapWithFallback(domain.hostname);
    updateDomainRdap(domain.id, data, ownership);
  } catch (error) {
    // Domain creation still succeeds; the detail page shows
    // "RDAP information unavailable." with a manual Refresh option.
    console.error(`[rdap] initial query failed for ${domain.hostname}:`, error);
  }

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
