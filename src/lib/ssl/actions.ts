"use server";

import { revalidatePath } from "next/cache";
import { checkSsl } from "./service";
import type { SslChange } from "./types";

export type SslActionResult =
  | { ok: true; snapshotId: number; checkedAt: Date; changes: SslChange[] }
  | { ok: false; error: string };

/**
 * Run a manual SSL check for a stored domain.
 *
 * The domain id must reference an existing row (verified in the service
 * layer) — arbitrary ids never reach the TLS client, and no cross-domain
 * data can be read through this action. Errors are returned as user-safe
 * messages; details go to the server log.
 */
export async function checkSslAction(domainId: number): Promise<SslActionResult> {
  const result = await checkSsl(domainId);

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
