import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";

const docsDir = path.dirname(fileURLToPath(import.meta.url));
const monorepoRoot = path.join(docsDir, "../..");

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3"],
  outputFileTracingRoot: monorepoRoot,
  outputFileTracingIncludes: {
    "/api/*": ["packages/extension/**/*"],
  },
};

export default nextConfig;
