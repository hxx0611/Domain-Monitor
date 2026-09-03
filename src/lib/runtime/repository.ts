/**
 * Runtime repository resolver (Phase 14C-2C).
 *
 * Single entry point for business code to obtain a `Repository`:
 *
 *   - Cloudflare (worker): the worker entry registers a factory that
 *     builds a request-scoped `createD1Repository(env.DB)` from the
 *     request's `context.d1` binding. The D1 adapter is import-safe for
 *     the worker bundle (no better-sqlite3).
 *   - Node (self-hosted): the default branch lazily imports the SQLite
 *     singleton from `@/db/node-singleton`. The Node entry may also call
 *     `setRepositoryFactory()` explicitly to keep the Node path identical
 *     to the Cloudflare path.
 *
 * Business layer (actions → services) never imports SQLite/D1/Cloudflare
 * symbols — it only calls `getRepository(context)`.
 */

import type { Repository } from "@/db/repository";
import type { D1BindingLike } from "@/db/adapters/types";

/** Runtime context handed to the repository factory by the caller. */
export interface RuntimeContext {
  /** Cloudflare D1 binding (only present in the worker runtime). */
  d1?: D1BindingLike;
}

export type RepositoryFactory = (context: RuntimeContext) => Promise<Repository> | Repository;

let repositoryFactory: RepositoryFactory | undefined;

/**
 * Register the runtime-specific repository factory (Node or Cloudflare).
 * Called once by the runtime entry point. The default (no factory) is the
 * Node SQLite singleton.
 */
export function setRepositoryFactory(factory: RepositoryFactory): void {
  repositoryFactory = factory;
}

/**
 * Resolve the repository for the current runtime. Business code calls this
 * instead of importing a SQLite/D1 singleton.
 */
export async function getRepository(context: RuntimeContext = {}): Promise<Repository> {
  if (repositoryFactory) {
    return repositoryFactory(context);
  }
  if (context.d1 || isCloudflareRuntime()) {
    // Cloudflare worker: build a D1 repository from the request context.
    return createD1RepositoryFactory()(context);
  }
  // Node default: lazy SQLite singleton. Cloudflare workers MUST register
  // a factory (via `@/lib/runtime/cloudflare`); otherwise this branch
  // would pull better-sqlite3 into the worker bundle.
  const { nodeRepository } = await import("@/db/node-singleton");
  return nodeRepository;
}

/**
 * Detect the Cloudflare worker runtime. OpenNext stores the request-scoped
 * `{ env, ctx }` on `globalThis[Symbol.for("__cloudflare-context__")]` in
 * `cloudflare/init.js`; `process.versions.node` is NOT a reliable signal
 * because `nodejs_compat` polyfills it inside workerd.
 */
function isCloudflareRuntime(): boolean {
  try {
    const globalWithContext = globalThis as {
      [key: symbol]: unknown;
    };
    return typeof globalWithContext[Symbol.for("__cloudflare-context__")] !== "undefined";
  } catch {
    return false;
  }
}

/**
 * Request-scoped D1 repository factory for the Cloudflare worker runtime.
 * Intended for `setRepositoryFactory(createD1RepositoryFactory)`.
 */
export function createD1RepositoryFactory(): RepositoryFactory {
  return (context: RuntimeContext) => {
    const binding = context.d1 ?? getCloudflareD1Binding();
    if (!binding) {
      throw new Error("Cloudflare runtime: missing D1 binding in repository context");
    }
    const { createD1Repository } = requireD1Factory();
    return createD1Repository(binding);
  };
}

/**
 * Read the request-scoped D1 binding from the OpenNext Cloudflare context
 * (`globalThis[Symbol.for("__cloudflare-context__")].env.DB`), falling back
 * when business code calls `getRepository()` without an explicit context.
 */
function getCloudflareD1Binding(): D1BindingLike | undefined {
  try {
    const store = (globalThis as { [key: symbol]: unknown })[
      Symbol.for("__cloudflare-context__")
    ] as { env?: { DB?: D1BindingLike } } | undefined;
    return store?.env?.DB;
  } catch {
    return undefined;
  }
}

// Kept separate so the D1 adapter import only happens when the factory is
// actually used (and stays out of the Node-only default path).
function requireD1Factory(): {
  createD1Repository: (binding: D1BindingLike) => Repository;
} {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("@/db/adapters/d1");
}
