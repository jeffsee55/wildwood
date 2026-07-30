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
import { WILDWOOD_BRANCH_COOKIE, WILDWOOD_BRANCH_COOKIE_FALLBACKS, type WildwoodForBranch } from "./branch";

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

/**
 * Re-enable draft mode when the branch cookie exists but draft mode was lost
 * (e.g. after a redeploy — the `__prerender_bypass` cookie is signed with a
 * random value per build, so the old cookie no longer matches).
 *
 * The branch cookie (`x-wildwood-branch`) persists across redeploys since it's
 * a regular cookie with a 7-day max-age. If it exists and differs from the
 * configured ref, we know the user is in a preview session and should re-enable
 * draft mode.
 *
 * Call this from a server component or route handler (e.g. inside `getContext`)
 * before reading `draftMode().isEnabled` — it will set the new bypass cookie
 * on the response so subsequent renders work.
 *
 * @returns `true` if the caller is in a preview session (branch cookie present),
 *   `false` otherwise. This is the "source of truth" — prefer it over
 *   `draftMode().isEnabled` for deciding whether to target a branch.
 */
export async function ensureDraftModeFromBranchCookie(
  wildwood: WildwoodForBranch,
): Promise<boolean> {
  const configRef = wildwood?._?.config?.ref;
  const trimmedConfigRef = typeof configRef === "string" ? configRef.trim() : "";

  let branchCookie: string | undefined;
  try {
    const jar = await cookies();
    branchCookie = jar.get(WILDWOOD_BRANCH_COOKIE)?.value;
  } catch {
    // Not in a server component context (e.g. client component).
    return false;
  }

  // No branch cookie → not in preview mode.
  const trimmedBranch = branchCookie?.trim();
  if (!trimmedBranch) return false;

  // Branch cookie matches config ref → not in preview mode either.
  if (trimmedBranch === trimmedConfigRef) return false;

  // Branch cookie exists and differs from config ref → re-enable draft mode.
  try {
    const dm = await draftMode();
    if (!dm.isEnabled) {
      dm.enable();
    }
  } catch {
    // Can't enable draft mode in this context — still return true so the
    // caller knows the branch should be targeted.
  }

  return true;
}
