/**
 * Phase 14C-16 — Production Cloudflare Worker entry (custom-worker mode).
 *
 * OpenNext's `.open-next/worker.js` exports a server-only `fetch` handler that
 * Cloudflare's Next.js integration fully supports. This file adds the
 * `scheduled` handler (Cron entrypoint) and wires the D1 `DB` binding through
 * `getRepository()`, calling `runOnce()` (notifications scheduled-runner).
 *
 * Bundle-safety (verified via `wrangler deploy --dry-run` scan):
 *  - `@/db` → `src/db/cloudflare-stub.ts`, `@/db/node-singleton` → stub,
 *    `server-only` → empty stub (see tsconfig.cf.json). So `new Database` /
 *    `DATABASE_URL` / better-sqlite3 runtime never enter the bundle.
 *  - Wrangler bundles this file with `tsconfig.cf.json` (`"tsconfig"` in
 *    wrangler.prod.jsonc), NOT tsconfig.json.
 */
import { default as openNextHandler } from "./.open-next/worker.js";
import { getRepository } from "@/lib/runtime/repository";
import { runOnce } from "@/lib/notifications/worker";
import { createSender } from "@/lib/notifications/senders/factory";

export interface Env {
  DB: D1Database;
  CONFIG_TELEGRAM_ENDPOINT?: string;
  ENCRYPTION_KEY?: string;
  SESSION_SECRET?: string;
}

const fetch = openNextHandler.fetch;

async function scheduled(
  controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const repo = await getRepository({ d1: env.DB });
  await runOnce({ repo, senders: (type) => createSender(repo, env) });
}

export default {
  fetch,
  scheduled,
} satisfies ExportedHandler<Env>;

export { DOQueueHandler, DOShardedTagCache } from "./.open-next/worker.js";
