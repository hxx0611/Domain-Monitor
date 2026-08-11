"use server";

import { revalidatePath } from "next/cache";
import { createDomain, deleteDomain } from "./repository";
import { normalizeHostname } from "./validation";

export type DomainActionResult = { ok: true; hostname: string } | { ok: false; error: string };

/**
 * Create a domain from raw user input.
 * Validation and normalization happen here, before touching the database.
 */
export async function createDomainAction(input: string): Promise<DomainActionResult> {
  const result = normalizeHostname(input);

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  try {
    const domain = createDomain(result.hostname);

    if (!domain) {
      return { ok: false, error: "This domain is already being monitored." };
    }

    revalidatePath("/");
    return { ok: true, hostname: domain.hostname };
  } catch {
    // Unique-constraint race: another request inserted the same hostname
    // between our existence check and the insert.
    return { ok: false, error: "This domain is already being monitored." };
  }
}

export async function deleteDomainAction(id: number): Promise<DomainActionResult> {
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
