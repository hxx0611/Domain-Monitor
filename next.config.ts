import path from "path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Ensure Next.js resolves the project root correctly even when the
  // repository is nested inside a larger workspace.
  outputFileTracingRoot: path.join(__dirname),
};

export default nextConfig;
