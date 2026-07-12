/**
 * Branch / preview cookie resolution — framework-agnostic.
 *
 * No `next/*` imports. Consumers (RSC, H3, etc) supply a minimal
 * `Tr33RequestCookies` shape (from `next/headers` or parsed header).
 *
 * Canonical cookie: `TR33_BRANCH_COOKIE`. Legacy cookies are still read
 * for back-compat (`x-content-branch`, `tr33-active-ref`) but new writes
 * always use the canonical name.
 */

import {
  ACTIVE_REF_MAX_AGE_SEC,
  TR33_ACTIVE_REF_COOKIE,
  TR33_BRANCH_COOKIE,
  TR33_BRANCH_COOKIE_FALLBACKS,
  TR33_CACHE_TAG,
  TR33_SYNC_HOST_ACTIVE_REF_HEADER,
  activeRefSetCookieHeader as sharedActiveRefSetCookieHeader,
  branchCookieOptions as sharedBranchCookieOptions,
  clearBranchCookieHeader as sharedClearBranchCookieHeader,
} from "@tr33/shared";

// Re-export canonical constants so `tr33/nextjs/branch` is the only
// import apps need for Next.js integrations.
export {
  ACTIVE_REF_MAX_AGE_SEC,
  TR33_ACTIVE_REF_COOKIE,
  TR33_BRANCH_COOKIE,
  TR33_BRANCH_COOKIE_FALLBACKS,
  TR33_CACHE_TAG,
  TR33_SYNC_HOST_ACTIVE_REF_HEADER,
};

// Legacy re-export from shared helpers
export const TR33_ACTIVE_REF_STORAGE_KEY = "tr33.activeRef";

export function activeRefSetCookieHeader(
  ref: string,
  cookieName: string = TR33_BRANCH_COOKIE,
): string {
  return sharedActiveRefSetCookieHeader(ref, cookieName);
}

export function clearBranchCookieHeader(
  cookieName: string = TR33_BRANCH_COOKIE,
): string {
  return sharedClearBranchCookieHeader(cookieName);
}

export function branchCookieOptions(
  ref: string,
  cookieName: string = TR33_BRANCH_COOKIE,
) {
  return sharedBranchCookieOptions(ref, cookieName);
}

/** Every cookie name that might hold a branch (canonical + all legacy). */
export function allBranchCookieNames(): string[] {
  return [TR33_BRANCH_COOKIE, ...TR33_BRANCH_COOKIE_FALLBACKS];
}

// ── cookie adapter ─────────────────────────────────────────────────────────

export type Tr33RequestCookies = {
  get(name: string): { value: string } | undefined;
};

function cookieValue(
  cookies: Tr33RequestCookies,
  name: string,
): string | undefined {
  return cookies.get(name)?.value;
}

/**
 * Parse a raw `Cookie` header into `Tr33RequestCookies` so
 * `resolveBranch` can be used from H3 / `Request` handlers.
 */
export function cookiesFromCookieHeader(
  cookieHeader: string | null | undefined,
): Tr33RequestCookies {
  return {
    get(name: string): { value: string } | undefined {
      if (!cookieHeader) return undefined;
      const parts = cookieHeader.split(";").map((p) => p.trimStart());
      const prefix = `${name}=`;
      for (const part of parts) {
        if (part.startsWith(prefix)) {
          const raw = part.slice(prefix.length);
          try {
            return { value: decodeURIComponent(raw) };
          } catch {
            return { value: raw };
          }
        }
      }
      return undefined;
    },
  };
}

// ── resolver ───────────────────────────────────────────────────────────────

export type Tr33ForBranch = {
  _: { config: { ref: string } };
};

/**
 * Resolve the active branch / ref from an explicit cookie jar.
 *
 * Search order:
 *   1. `TR33_BRANCH_COOKIE`            — canonical (`x-tr33-branch`)
 *   2. `TR33_BRANCH_COOKIE_FALLBACKS` — `x-content-branch`, `tr33-active-ref`
 *
 * Falls back to `tr33._.config.ref`.
 *
 * This function is framework-agnostic: you supply `cookies` (e.g. from
 * `next/headers` or `cookiesFromCookieHeader`). For Next.js App Router
 * convenience where you don't want to call `cookies()` yourself, use
 * `getBranch(tr33)` which does the `await cookies()` internally.
 */
export function resolveBranch(args: {
  tr33: Tr33ForBranch;
  cookies: Tr33RequestCookies;
  draftModeEnabled?: boolean;
  cookieName?: string;
  fallbackCookieNames?: readonly string[];
}): string {
  const cookieOrder = [
    args.cookieName ?? TR33_BRANCH_COOKIE,
    ...(args.fallbackCookieNames ?? TR33_BRANCH_COOKIE_FALLBACKS),
  ];

  for (const name of cookieOrder) {
    const raw = cookieValue(args.cookies, name);
    if (!raw) continue;
    const trimmed = raw.trim();
    if (trimmed) return trimmed;
  }
  return args.tr33._.config.ref;
}

/**
 * Next.js convenience — resolves the active branch, reading cookies
 * automatically when no jar is provided.
 *
 * - In a Server Component / Route Handler: `await getBranch(tr33)` will
 *   call `await cookies()` for you.
 * - If you already have a cookie store (`await cookies()`), pass it to
 *   `resolveBranch` directly instead.
 * - Outside Next (H3, workers) you can pass a raw `Cookie` header via
 *   `cookieHeader`, or fall back to `resolveBranch` with your own jar.
 *
 * Never throws — falls back to `tr33._.config.ref` when cookies are
 * unavailable (e.g. client component, non-Next runtime).
 */
export async function getBranch(
  tr33: Tr33ForBranch,
  opts?: {
    cookies?: Tr33RequestCookies;
    cookieName?: string;
    fallbackCookieNames?: readonly string[];
    /** Parse this raw header instead of calling `next/headers`. */
    cookieHeader?: string | null;
    draftModeEnabled?: boolean;
  },
): Promise<string> {
  // Explicit jar wins.
  if (opts?.cookies) {
    return resolveBranch({
      tr33,
      cookies: opts.cookies,
      cookieName: opts.cookieName,
      fallbackCookieNames: opts.fallbackCookieNames,
      draftModeEnabled: opts.draftModeEnabled,
    });
  }

  // Raw header path (edge, middleware, H3).
  if (opts?.cookieHeader != null) {
    return resolveBranch({
      tr33,
      cookies: cookiesFromCookieHeader(opts.cookieHeader),
      cookieName: opts.cookieName,
      fallbackCookieNames: opts.fallbackCookieNames,
      draftModeEnabled: opts.draftModeEnabled,
    });
  }

  // Next.js App Router — dynamic import so this file stays usable in
  // non-Next runtimes without a static `next/headers` dependency.
  try {
    const { cookies } = (await import("next/headers")) as {
      cookies: () => Promise<Tr33RequestCookies> | Tr33RequestCookies;
    };
    const store = await cookies();
    return resolveBranch({
      tr33,
      cookies: store as Tr33RequestCookies,
      cookieName: opts?.cookieName,
      fallbackCookieNames: opts?.fallbackCookieNames,
      draftModeEnabled: opts?.draftModeEnabled,
    });
  } catch {
    return tr33._.config.ref;
  }
}

/** Alias — `getBranch` is the preferred name; kept for discoverability. */
export const getActiveBranch = getBranch;
export const getActiveRef = getBranch;
