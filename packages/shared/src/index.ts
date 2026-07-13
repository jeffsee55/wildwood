/**
 * Canonical git empty-tree OID. Skip re-uploading when creating new dirs.
 * Shared between extension patch, kit, and server to avoid duplication.
 */
export const GIT_EMPTY_TREE_OID = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

// ---- active ref / branch sync -------------------------------------------

/**
 * Canonical cookie name for the active branch / preview ref.
 *
 * New code should use this. Legacy names are still accepted when reading.
 */
export const WILDWOOD_BRANCH_COOKIE = "x-wildwood-branch";

/**
 * Legacy cookie names still accepted for backwards compatibility.
 * - `x-tr33-branch` — previous canonical
 * - `x-content-branch` — example from early docs / userland draft route
 * - `wildwood-active-ref` / `tr33-active-ref` — original names used by apps/docs and Kit
 */
export const WILDWOOD_BRANCH_COOKIE_FALLBACKS = [
  "x-tr33-branch",
  "x-content-branch",
  "wildwood-active-ref",
  "tr33-active-ref",
] as const;

// Back-compat aliases
/** @deprecated use WILDWOOD_BRANCH_COOKIE */
export const TR33_BRANCH_COOKIE = WILDWOOD_BRANCH_COOKIE;
/** @deprecated use WILDWOOD_BRANCH_COOKIE_FALLBACKS */
export const TR33_BRANCH_COOKIE_FALLBACKS = WILDWOOD_BRANCH_COOKIE_FALLBACKS;

// Cookie written by the Next/Kit host when branch changes (legacy alias).
export const WILDWOOD_ACTIVE_REF_COOKIE = "wildwood-active-ref";
/** @deprecated use WILDWOOD_ACTIVE_REF_COOKIE */
export const TR33_ACTIVE_REF_COOKIE = WILDWOOD_ACTIVE_REF_COOKIE;

// Header that gates whether the worktree API may set the cookie.
export const WILDWOOD_SYNC_HOST_ACTIVE_REF_HEADER = "x-wildwood-sync-host-active-ref";
/** @deprecated use WILDWOOD_SYNC_HOST_ACTIVE_REF_HEADER */
export const TR33_SYNC_HOST_ACTIVE_REF_HEADER = WILDWOOD_SYNC_HOST_ACTIVE_REF_HEADER;

// localStorage key (same-origin) for the active ref in embedded editor.
export const WILDWOOD_ACTIVE_REF_STORAGE_KEY = "wildwood.activeRef";
/** @deprecated use WILDWOOD_ACTIVE_REF_STORAGE_KEY */
export const TR33_ACTIVE_REF_STORAGE_KEY = WILDWOOD_ACTIVE_REF_STORAGE_KEY;

export const ACTIVE_REF_MAX_AGE_SEC = 60 * 60 * 24 * 7;

// ---- cache ----------------------------------------------------------------

/**
 * Default cache tag used by `wildwood/nextjs/route` and docs loaders.
 *
 * Call `cacheTag(WILDWOOD_CACHE_TAG)` inside a `"use cache"` boundary and
 * `revalidateTag(WILDWOOD_CACHE_TAG)` on mutations. When `draftMode()` is
 * enabled Next.js automatically bypasses `"use cache"` so preview mode
 * always sees fresh data.
 */
export const WILDWOOD_CACHE_TAG = "wildwood";
/** @deprecated use WILDWOOD_CACHE_TAG */
export const TR33_CACHE_TAG = WILDWOOD_CACHE_TAG;

// ---- cross-frame sync channels ------------------------------------------

// Kit page -> extension host (host ref changed).
export const WILDWOOD_KIT_HOST_REF_CHANNEL = "wildwood-kit-host-ref";
/** @deprecated */
export const TR33_KIT_HOST_REF_CHANNEL = WILDWOOD_KIT_HOST_REF_CHANNEL;

// Extension host -> Kit page (ref changed / workspace changed).
export const WILDWOOD_EXTENSION_TO_HOST_REF_CHANNEL = "wildwood-extension-to-host";
/** @deprecated */
export const TR33_EXTENSION_TO_HOST_REF_CHANNEL = WILDWOOD_EXTENSION_TO_HOST_REF_CHANNEL;

export const WILDWOOD_EXTENSION_WORKSPACE_CHANGED_CHANNEL = "wildwood-extension-workspace-changed";
/** @deprecated */
export const TR33_EXTENSION_WORKSPACE_CHANGED_CHANNEL =
  WILDWOOD_EXTENSION_WORKSPACE_CHANGED_CHANNEL;

// PostMessage types (must stay stable across Kit <-> extension).
export const WILDWOOD_KIT_CLOSE_MESSAGE = "wildwood-kit-close-editor";
/** @deprecated */
export const TR33_KIT_CLOSE_MESSAGE = WILDWOOD_KIT_CLOSE_MESSAGE;
export const WILDWOOD_KIT_BRANCH_CHANGED_MESSAGE = "wildwood-kit-branch-changed";
/** @deprecated */
export const TR33_KIT_BRANCH_CHANGED_MESSAGE = WILDWOOD_KIT_BRANCH_CHANGED_MESSAGE;
export const WILDWOOD_KIT_WORKSPACE_CHANGED_MESSAGE = "wildwood-kit-workspace-changed";
/** @deprecated */
export const TR33_KIT_WORKSPACE_CHANGED_MESSAGE = WILDWOOD_KIT_WORKSPACE_CHANGED_MESSAGE;

// ---- branch name generator ----------------------------------------------

export const BRANCH_CITIES = [
  "jakarta",
  "istanbul",
  "cairo",
  "mumbai",
  "tokyo",
  "seoul",
  "lima",
  "nairobi",
  "havana",
  "bogota",
  "tehran",
  "delhi",
  "dhaka",
  "hanoi",
  "riyadh",
  "ankara",
  "kabul",
  "quito",
  "dakar",
  "lusaka",
  "maputo",
  "tbilisi",
  "baku",
  "minsk",
  "tallinn",
  "riga",
  "vilnius",
  "oslo",
  "reykjavik",
  "helsinki",
  "dublin",
  "lisbon",
  "prague",
  "vienna",
  "budapest",
  "bucharest",
  "sofia",
  "tirana",
  "skopje",
  "belgrade",
] as const;

export function generateBranchName(): string {
  const city = BRANCH_CITIES[Math.floor(Math.random() * BRANCH_CITIES.length)]!;
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${city}-${suffix}`;
}

export function activeRefSetCookieHeader(
  ref: string,
  cookieName: string = WILDWOOD_BRANCH_COOKIE,
): string {
  const value = encodeURIComponent(ref);
  return `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${ACTIVE_REF_MAX_AGE_SEC}`;
}

export function clearBranchCookieHeader(cookieName: string = WILDWOOD_BRANCH_COOKIE): string {
  return `${cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

/** All cookie names that should be cleared when exiting preview. */
export function allBranchCookieNames(): string[] {
  return [WILDWOOD_BRANCH_COOKIE, ...WILDWOOD_BRANCH_COOKIE_FALLBACKS];
}

export function branchCookieOptions(ref: string, cookieName = WILDWOOD_BRANCH_COOKIE) {
  return {
    name: cookieName,
    value: ref,
    path: "/",
    httpOnly: true,
    sameSite: "Lax" as const,
    maxAge: ACTIVE_REF_MAX_AGE_SEC,
  };
}
