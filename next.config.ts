import path from "path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Ensure Next.js resolves the project root correctly even when the
  // repository is nested inside a larger workspace.
  outputFileTracingRoot: path.join(__dirname),
  // Phase 14C-2C: when building the Cloudflare/OpenNext worker
  // (OPENNEXT_CLOUDFLARE=1), swap tsconfig paths so `@/db` and
  // `@/db/node-singleton` resolve to forbidden stubs. better-sqlite3
  // therefore never enters the worker bundle; the worker registers a D1
  // factory via setRepositoryFactory() instead.
  //
  // IMPORTANT (Phase 14C-16): Next's `typescript.tsconfigPath` only switches
  // the tsconfig used for TYPE-CHECKING, NOT webpack's path-alias resolution.
  // webpack resolve.alias still reads tsconfig.json's `paths`
  // (`@/*` → `./src/*`), so `@/db` resolved to the REAL `src/db/index.ts`
  // (→ better-sqlite3 → `new Database(...)`), which leaked into the worker
  // bundle. The tsconfig.cf.json stub mapping was therefore a no-op at the
  // bundling stage. We must ALSO override webpack resolve.alias to redirect
  // `@/db` / `@/db/node-singleton` to the forbidden stubs. We use the `$`
  // (exact-match) alias suffix so `@/db/schema`, `@/db/repository`,
  // `@/db/adapters/*` etc. still resolve normally (they are real code with
  // no better-sqlite3 runtime); only the bare `@/db` and
  // `@/db/node-singleton` module roots are stubbed.
  typescript: {
    tsconfigPath:
      process.env.OPENNEXT_CLOUDFLARE === "1" ? "tsconfig.cf.json" : "tsconfig.json",
  },
  webpack(config) {
    if (process.env.OPENNEXT_CLOUDFLARE === "1") {
      config.resolve.alias = {
        ...config.resolve.alias,
        "@/db$": path.join(__dirname, "src/db/cloudflare-stub.ts"),
        "@/db/node-singleton$": path.join(
          __dirname,
          "src/db/cloudflare-node-singleton-stub.ts",
        ),
      };
    }
    return config;
  },
};

export default nextConfig;
