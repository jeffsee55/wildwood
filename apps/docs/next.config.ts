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
const nextConfig: NextConfig = {
  // Wildwood ships prebuilt ESM (dist/) that contains bare imports like
  // `import { betterAuth } from "better-auth"`. On Vercel with Turbopack,
  // those dist files are traced as opaque "unexpected file in NFT list"
  // and their bare imports aren't resolved from the app's node_modules.
  // Transpiling the package from source lets Next's resolver see the
  // dependencies correctly (and the imported heavy auth code stays isolated
  // in the /api/auth route anyway).
  transpilePackages: ["wildwood", "wildwood-kit", "wildwood-shared", "wildwood-store"],
};

export default nextConfig;
