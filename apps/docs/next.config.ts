import type { NextConfig } from "next";

/**
 * `outputFileTracingRoot` is needed because we run from `apps/docs` in a monorepo.
 * Previously we computed it with `path.dirname(fileURLToPath(...))` which emits
 * filesystem ops; Turbopack's NFT tracer then flags `next.config.ts` as a file
 * that touches the filesystem + dynamic requires and traces the whole monorepo
 * (see handler -> route -> docs/api edge).
 *
 * In Vercel, `rootDirectory` is already set via `vercel.json` to `apps/docs`,
 * and `outputFileTracingRoot` is optional there. Locally, Next still needs the
 * root. We set it via env (Vercel sets `VERCEL_PROJECT_DIR`/`PWD`) and fall back
 * to a static relative — no `node:path` / `fileURLToPath` so NFT stays quiet.
 */

function resolveTracingRoot(): string | undefined {
  // Vercel: rootDirectory is apps/docs, no need for custom tracing root.
  if (process.env.VERCEL) return undefined;
  // Local dev / `pnpm turbo build` — Next already infers root from where it runs.
  // Returning undefined is safe because root is `process.cwd()` -> docs, but we
  // want pnpm workspace hoisted deps traced. Use env if caller set it.
  return process.env.WILDWOOD_TRACE_ROOT?.trim() || undefined;
}

const nextConfig: NextConfig = {
  // Only set when we explicitly know we need it. Undefined lets Next use its default
  // (process.cwd()), which on Vercel is apps/docs — correct because rootDirectory is set.
  ...(resolveTracingRoot() ? { outputFileTracingRoot: resolveTracingRoot() } : {}),
  // Prevent Next from warning "Unexpected file in NFT list" for wildwood's H3/blog store.
  outputFileTracingExcludes: {
    "*": [
      "packages/**",
      "../../packages/**",
      "**/*.db",
      "**/wildwood.db",
    ],
  },
};

export default nextConfig;
