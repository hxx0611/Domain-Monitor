"use server";

import { revalidatePath } from "next/cache";
import { checkHttp } from "./service";

export type HttpActionResult =
  | { ok: true; snapshotId: number; checkedAt: Date }
  | {
      ok: false;
      error: string;
    };

/**
 * Run a manual HTTP check for a stored domain.
 *
 * The domain id must reference an existing row (verified in the service
 * layer) — arbitrary ids never reach the HTTP client, and no cross-domain
 * data can be read through this action. Errors are returned as user-safe
 * messages; details go to the server log.
 */
export async function checkHttpAction(domainId: number): Promise<HttpActionResult> {
  const result = await checkHttp(domainId);

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath(`/domains/${domainId}`);
  revalidatePath("/");
  return {
    ok: true,
    snapshotId: result.snapshotId,
    checkedAt: result.checkedAt,
  };
}
