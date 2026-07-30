import type { NextConfig } from "next";
import { wildwoodWellKnown } from "wildwood/nextjs/config";

/**
 * No `outputFileTracingRoot` — intentional.
 * Wildwood's production read-path is remote-first: entries come from
 * Turso/LibSQL (DB) or GitHub remote, never from direct `fs` access to
 * `content/` on the serverless filesystem.
 *
 * MCP OAuth discovery: `wildwoodWellKnown("/api")` forwards the two path-scoped
 * root `/.well-known/oauth-*` docs into the Wildwood catch-all at
 * `app/api/[...path]`. It never touches the bare-root `/.well-known/*` paths,
 * so nothing of ours is served that the app didn't opt into.
 */
const nextConfig: NextConfig = {
  cacheComponents: true,

  async rewrites() {
    return { beforeFiles: wildwoodWellKnown("/api"), afterFiles: [], fallback: [] };
  },
};

export default nextConfig;
