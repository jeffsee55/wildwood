import { withWildwood } from "wildwood/nextjs/config";

/**
 * No `outputFileTracingRoot` — intentional.
 * Wildwood's production read-path is remote-first: entries come from
 * Turso/LibSQL (DB) or GitHub remote, never from direct `fs` access to
 * `content/` on the serverless filesystem.
 */
export default withWildwood({
  cacheComponents: true,

  typescript: {
    // pnpm monorepo auto-install path ("It looks like you're trying to use TS... Installing")
    // triggers a second build worker with bad args and crashes with "id must be string".
    // We have our own `pnpm tsc --noEmit` via `turbo run typecheck`; skip during build.
    ignoreBuildErrors: true,
  },
});
