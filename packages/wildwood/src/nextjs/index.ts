/**
 * `wildwood/nextjs` — compatibility barrel.
 *
 * Preferred new import layout:
 *
 *   - `wildwood/nextjs/handler`           — framework-agnostic H3 handler (`Request → Response`)
 *   - `wildwood/nextjs/route`             — Next.js route factory (`createWildwoodRoute`) with cookie + tag
 *   - `wildwood/nextjs/branch`            — branch cookie resolver, constants, `cacheTag` name
 *   - `wildwood/nextjs/resolve-active-ref` — legacy alias of `branch` (still works)
 *   - `wildwood/nextjs/kit`               — toolbar / visual editing host
 *   - `wildwood/react/markdown`           — mdast-typed, framework-agnostic markdown renderer
 */

export { createHandler, handle, type CreateHandlerOptions } from "./handler";
export type { WildwoodClient } from "@/client/index";

export { WildwoodKit, Toolbar, type KitAuthConfig, type ToolbarProps, type WildwoodKitHostClient, type WildwoodKitProps } from "./wildwood-kit";

// ── route factory (Next.js specific, uses next/headers + next/cache) ──────
// ── branch helpers (framework-agnostic) — export first, so `route` can
// re-export same names without duplicate-identifier collisions.
export {
  ACTIVE_REF_MAX_AGE_SEC,
  WILDWOOD_ACTIVE_REF_COOKIE,
  WILDWOOD_BRANCH_COOKIE,
  WILDWOOD_BRANCH_COOKIE_FALLBACKS,
  WILDWOOD_CACHE_TAG,
  WILDWOOD_SYNC_HOST_ACTIVE_REF_HEADER,
  activeRefSetCookieHeader,
  allBranchCookieNames,
  branchCookieOptions,
  clearBranchCookieHeader,
  cookiesFromCookieHeader,
  getActiveBranch,
  getActiveRef,
  getBranch,
  resolveBranch,
  type WildwoodForBranch,
  type WildwoodRequestCookies,
} from "./branch";

// ── route factory (Next.js specific, uses next/headers + next/cache) ──────
// Re-exports `WILDWOOD_BRANCH_COOKIE`/`WILDWOOD_CACHE_TAG` again from `route` for
// the convenience `import { createWildwoodRoute, WILDWOOD_CACHE_TAG } from "wildwood/nextjs/route"`,
// but we re-export the same consts under aliases here to keep the top-level
// barrel deduplicated without TS duplicate-export errors.
export {
  createRoute,
  createWildwoodRoute,
  createWildwoodRouteHandlers,
  WILDWOOD_BRANCH_COOKIE as WILDWOOD_ROUTE_BRANCH_COOKIE,
  WILDWOOD_CACHE_TAG as WILDWOOD_ROUTE_CACHE_TAG,
  type CreateWildwoodRouteOptions,
} from "./route";

export {
  createDraftRoute,
  createDraftRouteHandlers,
  draftRoute,
  type CreateDraftRouteOptions,
} from "./draft";

// ── legacy compat — still re-export shared constants ───────────────────────
export {
  ACTIVE_REF_MAX_AGE_SEC as ACTIVE_REF_MAX_AGE_SEC_SHARED,
  WILDWOOD_ACTIVE_REF_COOKIE as WILDWOOD_ACTIVE_REF_COOKIE_SHARED,
  WILDWOOD_ACTIVE_REF_STORAGE_KEY,
  WILDWOOD_SYNC_HOST_ACTIVE_REF_HEADER as WILDWOOD_SYNC_HOST_ACTIVE_REF_HEADER_SHARED,
  WILDWOOD_BRANCH_COOKIE as WILDWOOD_ACTIVE_REF_CANONICAL,
  WILDWOOD_BRANCH_COOKIE_FALLBACKS as WILDWOOD_ACTIVE_REF_FALLBACKS,
  WILDWOOD_CACHE_TAG as WILDWOOD_DEFAULT_CACHE_TAG,
  activeRefSetCookieHeader as activeRefSetCookieHeaderShared,
  allBranchCookieNames as allBranchCookieNamesShared,
  branchCookieOptions as branchCookieOptionsShared,
  clearBranchCookieHeader as clearBranchCookieHeaderShared,
} from "wildwood-shared";

// Legacy alias — `resolve-active-ref` still works, but import `wildwood/nextjs/branch` instead.
export {
  resolveActiveRef,
  type WildwoodForActiveRef,
} from "./resolve-active-ref";

export {
  buildWildwoodGitHubAppManifest,
  createGitHubAppManifestConversionRoute,
  exchangeGitHubAppManifestCode,
  formatEnvFileContent,
  GitHubAppManifestCallback,
  githubAppManifestConversionCommand,
  manifestConversionToEnv,
  shellExportSnippets,
  vercelEnvAddSnippets,
  type GitHubAppManifestConversion,
  type GitHubPermissionLevel,
  type WildwoodGitHubAppManifest,
  type WildwoodGitHubAppManifestOptions,
  type WildwoodGitHubEnvMap,
} from "./github-app-manifest";

export { createGitHubAppManifestRouter } from "./handlers/github-app-manifest-router";
export { WildwoodGitHubAppSetup } from "./github-app-setup";

// `createWildwoodPlayAuth` is intentionally NOT re-exported from the main barrel.
// It has heavy native deps (`better-sqlite3`, `node:fs`, etc) and must only be
// imported via `wildwood/nextjs/play-auth` to keep `wildwood/nextjs` / `wildwood/react`
// free of Node-only code for client/server bundling.
// See `play` app: `import { createWildwoodPlayAuth } from "wildwood/nextjs/play-auth";`
