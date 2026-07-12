/**
 * `tr33/nextjs` — compatibility barrel.
 *
 * Preferred new import layout:
 *
 *   - `tr33/nextjs/handler`           — framework-agnostic H3 handler (`Request → Response`)
 *   - `tr33/nextjs/route`             — Next.js route factory (`createTr33Route`) with cookie + tag
 *   - `tr33/nextjs/branch`            — branch cookie resolver, constants, `cacheTag` name
 *   - `tr33/nextjs/resolve-active-ref` — legacy alias of `branch` (still works)
 *   - `tr33/nextjs/kit`               — toolbar / visual editing host
 *   - `tr33/react/markdown`           — mdast-typed, framework-agnostic markdown renderer
 */

export { createHandler, handle, type CreateHandlerOptions } from "./handler";
export type { Tr33Client } from "@/client/index";

export { Tr33Kit, Toolbar, type KitAuthConfig, type ToolbarProps, type Tr33KitHostClient, type Tr33KitProps } from "./tr33-kit";

// ── route factory (Next.js specific, uses next/headers + next/cache) ──────
// ── branch helpers (framework-agnostic) — export first, so `route` can
// re-export same names without duplicate-identifier collisions.
export {
  ACTIVE_REF_MAX_AGE_SEC,
  TR33_ACTIVE_REF_COOKIE,
  TR33_BRANCH_COOKIE,
  TR33_BRANCH_COOKIE_FALLBACKS,
  TR33_CACHE_TAG,
  TR33_SYNC_HOST_ACTIVE_REF_HEADER,
  activeRefSetCookieHeader,
  allBranchCookieNames,
  branchCookieOptions,
  clearBranchCookieHeader,
  cookiesFromCookieHeader,
  getActiveBranch,
  getActiveRef,
  getBranch,
  resolveBranch,
  type Tr33ForBranch,
  type Tr33RequestCookies,
} from "./branch";

// ── route factory (Next.js specific, uses next/headers + next/cache) ──────
// Re-exports `TR33_BRANCH_COOKIE`/`TR33_CACHE_TAG` again from `route` for
// the convenience `import { createTr33Route, TR33_CACHE_TAG } from "tr33/nextjs/route"`,
// but we re-export the same consts under aliases here to keep the top-level
// barrel deduplicated without TS duplicate-export errors.
export {
  createRoute,
  createTr33Route,
  createTr33RouteHandlers,
  TR33_BRANCH_COOKIE as TR33_ROUTE_BRANCH_COOKIE,
  TR33_CACHE_TAG as TR33_ROUTE_CACHE_TAG,
  type CreateTr33RouteOptions,
} from "./route";

// ── legacy compat — still re-export shared constants ───────────────────────
export {
  ACTIVE_REF_MAX_AGE_SEC as ACTIVE_REF_MAX_AGE_SEC_SHARED,
  TR33_ACTIVE_REF_COOKIE as TR33_ACTIVE_REF_COOKIE_SHARED,
  TR33_ACTIVE_REF_STORAGE_KEY,
  TR33_SYNC_HOST_ACTIVE_REF_HEADER as TR33_SYNC_HOST_ACTIVE_REF_HEADER_SHARED,
  TR33_BRANCH_COOKIE as TR33_ACTIVE_REF_CANONICAL,
  TR33_BRANCH_COOKIE_FALLBACKS as TR33_ACTIVE_REF_FALLBACKS,
  TR33_CACHE_TAG as TR33_DEFAULT_CACHE_TAG,
  activeRefSetCookieHeader as activeRefSetCookieHeaderShared,
  allBranchCookieNames as allBranchCookieNamesShared,
  branchCookieOptions as branchCookieOptionsShared,
  clearBranchCookieHeader as clearBranchCookieHeaderShared,
} from "@tr33/shared";

// Legacy alias — `resolve-active-ref` still works, but import `tr33/nextjs/branch` instead.
export {
  resolveActiveRef,
  type Tr33ForActiveRef,
} from "./resolve-active-ref";

export {
  createGitHubAppManifestConversionRoute,
  GitHubAppManifestCallback,
  githubAppManifestConversionCommand,
} from "./github-app-manifest";

// `createTr33PlayAuth` is intentionally NOT re-exported from the main barrel.
// It has heavy native deps (`better-sqlite3`, `node:fs`, etc) and must only be
// imported via `tr33/nextjs/play-auth` to keep `tr33/nextjs` / `tr33/react`
// free of Node-only code for client/server bundling.
// See `play` app: `import { createTr33PlayAuth } from "tr33/nextjs/play-auth";`
