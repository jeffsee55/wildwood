/**
 * Compatibility re-export of the new branch-aware resolver.
 *
 * New code should import from `tr33/nextjs/branch`:
 *
 *   import { resolveBranch, TR33_BRANCH_COOKIE, TR33_CACHE_TAG } from "tr33/nextjs/branch"
 *
 * This file stays around so existing `tr33/nextjs/resolve-active-ref`
 * imports keep working.
 */

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
  resolveBranch,
  type Tr33ForBranch,
  type Tr33RequestCookies,
} from "./branch";

import { TR33_BRANCH_COOKIE, TR33_BRANCH_COOKIE_FALLBACKS, type Tr33ForBranch, type Tr33RequestCookies } from "./branch";
import { resolveBranch as resolveBranchImpl } from "./branch";

// ---- compat aliases ------------------------------------------------------

export type Tr33ForActiveRef = Tr33ForBranch;

/**
 * Legacy alias for `resolveBranch`. Still works — reads the canonical
 * `x-tr33-branch` cookie plus historic fallbacks (`x-content-branch`,
 * `tr33-active-ref`), then the configured ref.
 */
export function resolveActiveRef(args: {
  tr33: Tr33ForBranch;
  cookies: Tr33RequestCookies;
  cookieName?: string;
}): string {
  return resolveBranchImpl({
    tr33: args.tr33,
    cookies: args.cookies,
    cookieName: args.cookieName,
    fallbackCookieNames: TR33_BRANCH_COOKIE_FALLBACKS,
  });
}

/** @deprecated use `TR33_BRANCH_COOKIE` */
export const LEGACY_TR33_ACTIVE_REF_COOKIE = TR33_BRANCH_COOKIE;

