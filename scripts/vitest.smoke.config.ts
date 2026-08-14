import path from "path";
import { defineConfig } from "vitest/config";

/**
 * Vitest config for the manual RDAP smoke test.
 *
 * The smoke test hits REAL RDAP registries and the REAL database, so it is
 * deliberately excluded from the default `pnpm test` run (CI safety).
 * Run it explicitly with:
 *   pnpm vitest run --config scripts/vitest.smoke.config.ts
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["scripts/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "..", "src"),
      // Same stub as vitest.config.ts: `server-only` throws outside Next.js.
      "server-only": path.resolve(__dirname, "..", "test/stubs/server-only.ts"),
    },
  },
});
