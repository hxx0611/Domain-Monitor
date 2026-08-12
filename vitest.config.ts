import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      // `server-only` throws outside Next.js; stub it for unit tests so the
      // repository layer (which imports it as a guard) stays testable.
      "server-only": path.resolve(__dirname, "test/stubs/server-only.ts"),
    },
  },
});
