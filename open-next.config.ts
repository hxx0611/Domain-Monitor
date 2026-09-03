// open-next.config.ts — Cloudflare adapter config (Phase 14C-2C local gate)
// Intentionally minimal: no R2 incremental cache / queues / Durable
// Objects, per the phase rule "don't add unrelated CF resources unless
// OpenNext explicitly requires them". The default incremental cache is
// used. This file is for the LOCAL wrangler prototype only; it is never
// deployed and never touches production Cloudflare resources.
import { defineCloudflareConfig } from "@opennextjs/cloudflare";

export default defineCloudflareConfig({});
