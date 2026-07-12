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
export const TR33_BRANCH_COOKIE = "x-tr33-branch";

/**
 * Legacy cookie names still accepted for backwards compatibility.
 * - `x-content-branch` — example from early docs / userland draft route
 * - `tr33-active-ref`  — original name used by `apps/docs` and Kit
 */
export const TR33_BRANCH_COOKIE_FALLBACKS = [
  "x-content-branch",
  "tr33-active-ref",
] as const;

// Cookie written by the Next/Kit host when branch changes (legacy alias).
export const TR33_ACTIVE_REF_COOKIE = "tr33-active-ref";

// Header that gates whether the worktree API may set the cookie.
export const TR33_SYNC_HOST_ACTIVE_REF_HEADER =
  "x-tr33-sync-host-active-ref";

// localStorage key (same-origin) for the active ref in embedded editor.
export const TR33_ACTIVE_REF_STORAGE_KEY = "tr33.activeRef";

export const ACTIVE_REF_MAX_AGE_SEC = 60 * 60 * 24 * 7;

// ---- cache ----------------------------------------------------------------

/**
 * Default cache tag used by `tr33/nextjs/route` and docs loaders.
 *
 * Call `cacheTag(TR33_CACHE_TAG)` inside a `"use cache"` boundary and
 * `revalidateTag(TR33_CACHE_TAG)` on mutations. When `draftMode()` is
 * enabled Next.js automatically bypasses `"use cache"` so preview mode
 * always sees fresh data.
 */
export const TR33_CACHE_TAG = "tr33";

// ---- cross-frame sync channels ------------------------------------------

// Kit page -> extension host (host ref changed).
export const TR33_KIT_HOST_REF_CHANNEL = "tr33-kit-host-ref";

// Extension host -> Kit page (ref changed / workspace changed).
export const TR33_EXTENSION_TO_HOST_REF_CHANNEL =
  "tr33-extension-to-host";
export const TR33_EXTENSION_WORKSPACE_CHANGED_CHANNEL =
  "tr33-extension-workspace-changed";

// PostMessage types (must stay stable across Kit <-> extension).
export const TR33_KIT_CLOSE_MESSAGE = "tr33-kit-close-editor";
export const TR33_KIT_BRANCH_CHANGED_MESSAGE = "tr33-kit-branch-changed";
export const TR33_KIT_WORKSPACE_CHANGED_MESSAGE =
  "tr33-kit-workspace-changed";

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
  const city =
    BRANCH_CITIES[Math.floor(Math.random() * BRANCH_CITIES.length)]!;
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${city}-${suffix}`;
}

export function activeRefSetCookieHeader(
  ref: string,
  cookieName: string = TR33_BRANCH_COOKIE,
): string {
  const value = encodeURIComponent(ref);
  return `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${ACTIVE_REF_MAX_AGE_SEC}`;
}

export function clearBranchCookieHeader(
  cookieName: string = TR33_BRANCH_COOKIE,
): string {
  return `${cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

/** All cookie names that should be cleared when exiting preview. */
export function allBranchCookieNames(): string[] {
  return [
    TR33_BRANCH_COOKIE,
    ...TR33_BRANCH_COOKIE_FALLBACKS,
  ];
}

export function branchCookieOptions(ref: string, cookieName = TR33_BRANCH_COOKIE) {
  return {
    name: cookieName,
    value: ref,
    path: "/",
    httpOnly: true,
    sameSite: "Lax" as const,
    maxAge: ACTIVE_REF_MAX_AGE_SEC,
  };
}
