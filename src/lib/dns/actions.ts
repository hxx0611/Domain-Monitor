"use server";

import { revalidatePath } from "next/cache";
import { checkDns } from "./service";
import type { DnsChange } from "./types";

export type DnsActionResult =
  | { ok: true; snapshotId: number; checkedAt: Date; changes: DnsChange[] }
  | { ok: false; error: string };

/**
 * Run a manual DNS check for a stored domain.
 *
 * The domain id must reference an existing row (verified in the service
 * layer) — arbitrary ids never reach the DNS client, and no cross-domain
 * data can be read through this action. Errors are returned as user-safe
 * messages; details go to the server log.
 */
export async function checkDnsAction(domainId: number): Promise<DnsActionResult> {
  const result = await checkDns(domainId);

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath(`/domains/${domainId}`);
  revalidatePath("/");
  return {
    ok: true,
    snapshotId: result.snapshotId,
    checkedAt: result.checkedAt,
    changes: result.changes,
  };
}
