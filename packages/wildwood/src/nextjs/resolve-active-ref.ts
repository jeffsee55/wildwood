/**
 * Compatibility re-export of the new branch-aware resolver.
 *
 * New code should import from `wildwood/nextjs/branch`:
 *
 *   import { resolveBranch, WILDWOOD_BRANCH_COOKIE, WILDWOOD_CACHE_TAG } from "wildwood/nextjs/branch"
 *
 * This file stays around so existing `wildwood/nextjs/resolve-active-ref`
 * imports keep working (and legacy `tr33` imports via compat layer).
 */

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
  resolveBranch,
  type WildwoodForBranch,
  type WildwoodRequestCookies,
} from "./branch";

import {
  WILDWOOD_BRANCH_COOKIE,
  WILDWOOD_BRANCH_COOKIE_FALLBACKS,
  type WildwoodForBranch,
  type WildwoodRequestCookies,
} from "./branch";
import { resolveBranch as resolveBranchImpl } from "./branch";

// ---- compat aliases ------------------------------------------------------

export type WildwoodForActiveRef = WildwoodForBranch;

/**
 * Legacy alias for `resolveBranch`. Still works — reads the canonical
 * `x-wildwood-branch` cookie plus historic fallbacks (`x-tr33-branch`,
 * `x-content-branch`, `wildwood-active-ref`, `tr33-active-ref`), then the
 * configured ref.
 */
export function resolveActiveRef(args: {
  wildwood: WildwoodForBranch;
  cookies: WildwoodRequestCookies;
  cookieName?: string;
}): string {
  return resolveBranchImpl({
    wildwood: args.wildwood,
    cookies: args.cookies,
    cookieName: args.cookieName,
    fallbackCookieNames: WILDWOOD_BRANCH_COOKIE_FALLBACKS,
  });
}

/** @deprecated use `WILDWOOD_BRANCH_COOKIE` */
export const LEGACY_WILDWOOD_ACTIVE_REF_COOKIE = WILDWOOD_BRANCH_COOKIE;

// Back-compat for `tr33` named imports
/** @deprecated use wildwood */
export type Tr33ForBranch = WildwoodForBranch;
export type Tr33RequestCookies = WildwoodRequestCookies;
export function resolveActiveRefLegacy(args: {
  tr33: WildwoodForBranch;
  cookies: WildwoodRequestCookies;
  cookieName?: string;
}) {
  return resolveActiveRef({
    wildwood: args.tr33,
    cookies: args.cookies,
    cookieName: args.cookieName,
  });
}
