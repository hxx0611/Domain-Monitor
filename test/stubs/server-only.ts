/**
 * Test-only stub for the `server-only` package.
 *
 * `server-only` throws when imported outside a Next.js server runtime,
 * which breaks unit tests that exercise the repository layer. Vitest
 * aliases the real package to this no-op module (see vitest.config.ts).
 * Production code is unaffected — Next.js resolves the real package.
 */
export {};
