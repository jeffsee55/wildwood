import type { NextConfig } from "next";

/** Monorepo `content/` for local-path runtime when the GitHub App is not installed. */
const contentFiles = "../../content/**/*";

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3"],
  outputFileTracingIncludes: {
    "/*": [contentFiles],
    "/docs/*": [contentFiles],
    "/api/*": [contentFiles],
  },
};

export default nextConfig;
