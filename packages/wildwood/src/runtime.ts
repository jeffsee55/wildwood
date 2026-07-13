/**
 * Next.js / Vercel runtime phase detection — canonical source.
 *
 * `NODE_ENV=production` is true in BOTH `next build` AND the Vercel lambda.
 * `NEXT_PHASE=phase-production-build` is only set during the build.
 *
 * - build:   NODE_ENV=production + NEXT_PHASE=phase-production-build → has `.git` checkout
 * - runtime: NODE_ENV=production + NEXT_PHASE=undefined               → no FS, no gh CLI
 * - dev:     NODE_ENV=development
 *
 * This file has ZERO deps so it can be imported from anywhere (client, git, env, nextjs)
 * without creating cycles.
 */
export function isNextBuildPhase(): boolean {
  return process.env.NEXT_PHASE === "phase-production-build";
}

export function isProdRuntime(): boolean {
  return process.env.NODE_ENV === "production" && !process.env.NEXT_PHASE;
}

export function shouldAutoUseLocal(): boolean {
  if (isProdRuntime()) return false;
  // Single env to force GitHub remote in dev (e.g. when testing GitHubRemote locally).
  // No fallback cascade — set explicitly if you need it.
  if (process.env.WILDWOOD_SOURCE === "github") return false;
  if (process.env.WILDWOOD_SOURCE === "local") return true;
  return true;
}
