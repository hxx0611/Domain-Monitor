/**
 * Minimal structural types for a Cloudflare D1 binding.
 *
 * The Repository contract never exposes these types (business code only
 * sees `Repository`); the D1 adapter accepts any object satisfying this
 * shape so that tests can pass a miniflare D1 instance and production can
 * pass the real `env.DB` binding.
 *
 * The adapter internally casts the binding to what `drizzle-orm/d1`
 * expects (`AnyD1Database`) — a type-only cast; the runtime object must be
 * a real D1 binding (prepare/batch/exec).
 */

export interface D1ResultLike {
  success: boolean;
  meta: {
    /** Rows changed by the statement (D1 shape — NOT `.changes`). */
    changes: number;
    /** Last inserted row id. */
    last_row_id: number;
    [key: string]: unknown;
  };
  results?: unknown[];
}

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = unknown>(...values: unknown[]): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
  run(...values: unknown[]): Promise<D1ResultLike>;
}

export interface D1BindingLike {
  prepare(sql: string): D1PreparedStatementLike;
  batch<T = unknown>(statements: D1PreparedStatementLike[]): Promise<T[]>;
  exec(sql: string): Promise<D1ResultLike>;
}
