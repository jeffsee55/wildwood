import { withWildwood } from "wildwood-web/next/config";
import type { NextConfig } from "next";
const config: NextConfig = {
  outputFileTracingIncludes: { "/*": ["./.git-runtime/**/*"] },
  distDir: process.env.WILDWOOD_REVIEW_DIST_DIR || ".next",
};
// Optional: this only forwards the two path-scoped OAuth discovery URLs.
export default withWildwood(config, { mcpDiscovery: true });
