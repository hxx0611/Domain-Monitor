/**
 * Phase 14C-16 — `server-only` stub for the Cloudflare (wrangler/esbuild) bundle.
 *
 * The real `server-only@0.0.1` package THROWS at import time ("This module
 * cannot be imported from a Client Component module. It should only be used
 * from a Server Component."). That throw is intentional in Node/Next to keep
 * server-only code out of the client bundle.
 *
 * In a Cloudflare Worker (workerd) EVERYTHING is server, so the throw is
 * never desirable — it fires during deploy-side top-level scope validation
 * (error 10021) whenever `custom-worker.ts` imports a module that does
 * `import "server-only";` (e.g. `@/lib/notifications/repository`,
 * `encryption`, `secrets`, `@/db/repository`).
 *
 * `tsconfig.cf.json` (used by wrangler via `"tsconfig": "tsconfig.cf.json"`)
 * redirects `server-only` → this empty module. Node/Next (tsconfig.json) keeps
 * the real package, so the client-bundle guard is preserved outside Cloudflare.
 *
 * MUST have no side effects and export nothing meaningful.
 */
export {};
