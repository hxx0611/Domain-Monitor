import path from "path";
import { defineConfig } from "vitest/config";

/**
 * Vitest config for the V0.7 Phase 2 real-process concurrency suite.
 *
 * These tests spawn real independent Node processes (worker-proc.ts) and
 * a real shared SQLite file, so they are deliberately excluded from the
 * default `pnpm test` run. Run explicitly with:
 *   pnpm vitest run --config scripts/vitest.phase2.config.ts
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["scripts/worker-concurrency.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "..", "src"),
      // Same stub as vitest.config.ts: `server-only` throws outside Next.js.
      "server-only": path.resolve(__dirname, "..", "test/stubs/server-only.ts"),
    },
  },
});
