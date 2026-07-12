import type { NextConfig } from "next";

/**
 * No `outputFileTracingRoot` — intentional.
 *
 * Wildwood's production read-path is remote-first: entries come from
 * Turso/LibSQL (DB) or GitHub remote, never from direct `fs` access to
 * `content/` on the serverless filesystem. The API surface owns its own tracing
 * via normal imports (dist files). Setting a monorepo tracing root only causes
 * Turbopack's NFT tracer to pull the entire monorepo into the bundle and warn
 * about unexpected `fs` ops.
 *
 * `vercel.json` already sets `rootDirectory: "apps/docs"` in prod, so Next's
 * default `process.cwd()` tracing root is correct.
 */
const nextConfig: NextConfig = {};

export default nextConfig;
