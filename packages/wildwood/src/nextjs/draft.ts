/**
 * `wildwood/nextjs/draft`
 *
 * Standalone draft/preview route factory. Optional — `createWildwoodRoute` already
 * exposes `/wildwood/draft` inside your catch-all `app/api/[...path]/route.ts`, so
 * most apps don't need this file at all.
 *
 * When you *do* want a dedicated route (e.g. `/api/draft/route.ts` without a
 * catch-all, or a custom path), use this:
 *
 *   // app/api/draft/route.ts
 *   import { createDraftRoute } from "wildwood/nextjs/draft";
 *   export const { GET, POST } = createDraftRoute();
 *
 * Behavior (same as `createWildwoodRoute`'s built-in):
 * - `GET /api/draft?branch=<ref>`  → draft on, branch cookie set
 * - `GET /api/draft?disable=1`      → draft off, branch cookies cleared
 * - Missing `?branch=` on enable     → 400
 *
 * Why no `revalidateTag` on enter/exit:
 * `draftMode().enable()` bypasses `"use cache"` per-user via
 * `__prerender_bypass`. Global purge on draft enter/exit would invalidate
 * everyone else — wrong. `revalidateTag(WILDWOOD_CACHE_TAG)` only fires for real
 * mutations (commit/etc) inside `createWildwoodRoute`.
 *
 * Cookie: writes only canonical `WILDWOOD_BRANCH_COOKIE`, deletes
 * `WILDWOOD_BRANCH_COOKIE_FALLBACKS` on disable for migration hygiene.
 */

import { cookies, draftMode } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import { WILDWOOD_BRANCH_COOKIE, WILDWOOD_BRANCH_COOKIE_FALLBACKS } from "./branch";

export type CreateDraftRouteOptions = {
  /**
   * Cookie name that holds the active branch.
   * Defaults to `WILDWOOD_BRANCH_COOKIE` (`x-wildwood-branch`).
   * Keep in sync with `createWildwoodRoute({ branchCookieName })` if customized.
   */
  branchCookieName?: string;
  /**
   * Extra cookie names to delete when disabling draft. Defaults to
   * `WILDWOOD_BRANCH_COOKIE_FALLBACKS` — `x-content-branch` and `wildwood-active-ref`
   * from older releases (plus legacy `x-tr33-branch`, `tr33-active-ref`). Safe to leave alone; deletions are idempotent.
   */
  legacyCookieNames?: readonly string[];
};

export function createDraftRoute(opts: CreateDraftRouteOptions = {}) {
  const cookieName = opts.branchCookieName ?? WILDWOOD_BRANCH_COOKIE;
  const legacy = opts.legacyCookieNames ?? WILDWOOD_BRANCH_COOKIE_FALLBACKS;

  async function enable(branch: string) {
    (await draftMode()).enable();
    const jar = await cookies();
    jar.set(cookieName, branch, { path: "/" });
    // Don't write legacy names — only the canonical one. Read path already
    // handles legacy via fallbacks, so old clients still resolve.
    return NextResponse.json({ draftMode: true, branch });
  }

  async function disable() {
    (await draftMode()).disable();
    const jar = await cookies();
    // Clear canonical + legacy so stale migration state doesn't survive.
    jar.delete(cookieName);
    for (const name of legacy) {
      if (name !== cookieName) jar.delete(name);
    }
    // Also clear the raw header names the old userland route used to write
    // (guard: if someone set a custom cookie name that collides with a
    // legacy name we already deleted above, the Set dedup above handles it).
    return NextResponse.json({ draftMode: false });
  }

  async function GET(req: NextRequest) {
    const url = req.nextUrl;
    if (url.searchParams.get("disable")) return disable();

    const branch = url.searchParams.get("branch")?.trim() || "";
    if (!branch) {
      return NextResponse.json({ error: "Missing ?branch=" }, { status: 400 });
    }
    return enable(branch);
  }

  async function POST(req: NextRequest) {
    return GET(req);
  }

  return { GET, POST };
}

/** Aliases for discoverability. */
export const createDraftRouteHandlers = createDraftRoute;
export const draftRoute = createDraftRoute;
