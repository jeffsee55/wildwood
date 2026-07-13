/**
 * Branch / preview cookie resolution — framework-agnostic.
 *
 * No `next/*` imports. Consumers (RSC, H3, etc) supply a minimal
 * `WildwoodRequestCookies` shape (from `next/headers` or parsed header).
 *
 * Canonical cookie: `WILDWOOD_BRANCH_COOKIE`. Legacy cookies are still read
 * for back-compat (`x-content-branch`, `wildwood-active-ref`, `x-tr33-branch`,
 * `tr33-active-ref`) but new writes always use the canonical name.
 */

import {
  ACTIVE_REF_MAX_AGE_SEC,
  WILDWOOD_ACTIVE_REF_COOKIE,
  WILDWOOD_BRANCH_COOKIE,
  WILDWOOD_BRANCH_COOKIE_FALLBACKS,
  WILDWOOD_CACHE_TAG,
  WILDWOOD_SYNC_HOST_ACTIVE_REF_HEADER,
  activeRefSetCookieHeader as sharedActiveRefSetCookieHeader,
  branchCookieOptions as sharedBranchCookieOptions,
  clearBranchCookieHeader as sharedClearBranchCookieHeader,
} from "wildwood-shared";

// Re-export canonical constants so `wildwood/nextjs/branch` is the only
// import apps need for Next.js integrations.
export {
  ACTIVE_REF_MAX_AGE_SEC,
  WILDWOOD_ACTIVE_REF_COOKIE,
  WILDWOOD_BRANCH_COOKIE,
  WILDWOOD_BRANCH_COOKIE_FALLBACKS,
  WILDWOOD_CACHE_TAG,
  WILDWOOD_SYNC_HOST_ACTIVE_REF_HEADER,
};

// localStorage key — keep legacy string for backward compat with existing clients
export const WILDWOOD_ACTIVE_REF_STORAGE_KEY = "wildwood.activeRef";

export function activeRefSetCookieHeader(
  ref: string,
  cookieName: string = WILDWOOD_BRANCH_COOKIE,
): string {
  return sharedActiveRefSetCookieHeader(ref, cookieName);
}

export function clearBranchCookieHeader(cookieName: string = WILDWOOD_BRANCH_COOKIE): string {
  return sharedClearBranchCookieHeader(cookieName);
}

export function branchCookieOptions(ref: string, cookieName: string = WILDWOOD_BRANCH_COOKIE) {
  return sharedBranchCookieOptions(ref, cookieName);
}

/** Every cookie name that might hold a branch (canonical + all legacy). */
export function allBranchCookieNames(): string[] {
  return [WILDWOOD_BRANCH_COOKIE, ...WILDWOOD_BRANCH_COOKIE_FALLBACKS];
}

// ── cookie adapter ─────────────────────────────────────────────────────────

export type WildwoodRequestCookies = {
  get(name: string): { value: string } | undefined;
};

function cookieValue(cookies: WildwoodRequestCookies, name: string): string | undefined {
  return cookies.get(name)?.value;
}

/**
 * Parse a raw `Cookie` header into `WildwoodRequestCookies` so
 * `resolveBranch` can be used from H3 / `Request` handlers.
 */
export function cookiesFromCookieHeader(
  cookieHeader: string | null | undefined,
): WildwoodRequestCookies {
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

export type WildwoodForBranch = {
  // Permissive — accepts Config, Config stub, or plain object with optional ref/org/repo.
  // Internally we trim, so callers don't need `.trim()`.
  _?:
    | {
        config?:
          | {
              ref?: string | undefined;
              org?: string | undefined;
              repo?: string | undefined;
            }
          | undefined;
      }
    | undefined;
};

/**
 * Resolve the active branch / ref from an explicit cookie jar.
 *
 * Search order:
 *   1. `WILDWOOD_BRANCH_COOKIE`            — canonical (`x-wildwood-branch`)
 *   2. `WILDWOOD_BRANCH_COOKIE_FALLBACKS` — legacy fallbacks
 *
 * Falls back to `wildwood._.config.ref`, trimmed internally — callers don't need `.trim()`.
 */
export function resolveBranch(args: {
  wildwood: WildwoodForBranch;
  cookies: WildwoodRequestCookies;
  draftModeEnabled?: boolean;
  cookieName?: string;
  fallbackCookieNames?: readonly string[];
}): string {
  const cookieOrder = [
    args.cookieName ?? WILDWOOD_BRANCH_COOKIE,
    ...(args.fallbackCookieNames ?? WILDWOOD_BRANCH_COOKIE_FALLBACKS),
  ];

  for (const name of cookieOrder) {
    const raw = cookieValue(args.cookies, name);
    if (!raw) continue;
    const trimmed = raw.trim();
    if (trimmed) return trimmed;
  }
  // `ref` may be string | null | undefined from optional input; trim internally.
  const rawRef = args.wildwood?._?.config?.ref;
  if (typeof rawRef === "string") {
    const t = rawRef.trim();
    if (t) return t;
  }
  return "main";
}

/**
 * Next.js convenience — resolves the active branch, reading cookies
 * automatically when no jar is provided.
 *
 * - In a Server Component / Route Handler: `await getBranch(wildwood)` will
 *   call `await cookies()` for you.
 * - If you already have a cookie store (`await cookies()`), pass it to
 *   `resolveBranch` directly instead.
 * - Outside Next (H3, workers) you can pass a raw `Cookie` header via
 *   `cookieHeader`, or fall back to `resolveBranch` with your own jar.
 *
 * Never throws — falls back to `wildwood._.config.ref` when cookies are
 * unavailable (e.g. client component, non-Next runtime).
 */
export async function getBranch(
  wildwood: WildwoodForBranch,
  opts?: {
    cookies?: WildwoodRequestCookies;
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
      wildwood,
      cookies: opts.cookies,
      cookieName: opts.cookieName,
      fallbackCookieNames: opts.fallbackCookieNames,
      draftModeEnabled: opts.draftModeEnabled,
    });
  }

  // Raw header path (edge, middleware, H3).
  if (opts?.cookieHeader != null) {
    return resolveBranch({
      wildwood,
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
      cookies: () => Promise<WildwoodRequestCookies> | WildwoodRequestCookies;
    };
    const store = await cookies();
    return resolveBranch({
      wildwood,
      cookies: store as WildwoodRequestCookies,
      cookieName: opts?.cookieName,
      fallbackCookieNames: opts?.fallbackCookieNames,
      draftModeEnabled: opts?.draftModeEnabled,
    });
  } catch {
    const fallback = wildwood?._?.config?.ref;
    if (typeof fallback === "string") {
      const t = fallback.trim();
      if (t) return t;
    }
    return "main";
  }
}

/** Alias — `getBranch` is the preferred name; kept for discoverability. */
export const getActiveBranch = getBranch;
export const getActiveRef = getBranch;
