import path from "path";
import { defineConfig } from "vitest/config";

/**
 * Vitest config for the V0.7 Phase 3 CLI / operations suite.
 *
 * Spawns the real `pnpm worker` CLI (scripts/worker.ts) as an independent
 * process against a real SQLite file. Excluded from default `pnpm test`.
 * Run explicitly with:
 *   pnpm vitest run --config scripts/vitest.phase3.config.ts
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["scripts/worker-cli.test.ts"],
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
