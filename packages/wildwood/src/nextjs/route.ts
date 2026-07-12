/**
 * `wildwood/nextjs/route`
 *
 * Next.js-specific route factory that owns everything that previously lived
 * copy-pasted in every app's `app/api/[...path]/route.ts`:
 *
 * - mounts the framework-agnostic H3 handler (`wildwood/nextjs/handler`)
 * - branch cookie management (`x-wildwood-branch` canonical, with legacy read support)
 * - `revalidateTag(WILDWOOD_CACHE_TAG)` on git mutations
 * - `/wildwood/preview` exit + `/wildwood/draft` toggle (per-user draft, no global purge)
 * - `create-branch` / `switch-branch` response enrichment
 *
 * Draft / preview is now built-in:
 *
 * - `GET /api/wildwood/draft?branch=<ref>` → enables draft (per-user cache bypass),
 *   sets canonical branch cookie.
 * - `GET /api/wildwood/draft?disable=1`     → disables draft, clears branch cookies.
 * - Legacy `GET /api/draft?...` is also handled if your catch-all covers `/api`.
 *
 * Why no `revalidateTag` on draft enter/exit:
 * `draftMode().enable()` makes Next bypass `"use cache"` **for that user only**
 * via `__prerender_bypass`. Disabling re-enables cache for that user. Global
 * purge on enter/exit would invalidate everyone else — wrong.
 * `revalidateTag(WILDWOOD_CACHE_TAG)` only fires for real mutations (commit etc).
 *
 * Standalone `wildwood/nextjs/draft` still exports `createDraftRoute()` for apps
 * that prefer a dedicated `/api/draft` route file — it's optional.
 *
 * When `draftMode().enable()` has been called, Next.js automatically
 * bypasses `"use cache"` boundaries, so `BlogList()` below always sees
 * fresh data in preview without extra logic:
 *
 * ```ts
 * import { cacheTag, cacheLife } from "next/cache";
 * import { WILDWOOD_CACHE_TAG } from "wildwood/nextjs/branch";
 *
 * async function BlogList() {
 *   "use cache";
 *   cacheLife("hours");
 *   cacheTag(WILDWOOD_CACHE_TAG);
 *
 *   const c = await wildwood.docs.findMany({});
 *   return <ul>...</ul>;
 * }
 * ```
 *
 * Minimal app wiring:
 *
 * ```ts
 * // app/api/[...path]/route.ts  (covers /api/wildwood/* and legacy /api/draft)
 * import { createWildwoodRoute } from "wildwood/nextjs/route";
 * import { wildwood } from "@/lib/wildwood";
 *
 * export const { GET, POST, HEAD, OPTIONS, PUT, PATCH, DELETE } =
 *   createWildwoodRoute(() => wildwood);
 * ```
 */

import { cookies } from "next/headers";
import { revalidateTag } from "next/cache";
import { NextResponse } from "next/server";
import {
  WILDWOOD_BRANCH_COOKIE,
  WILDWOOD_BRANCH_COOKIE_FALLBACKS,
  WILDWOOD_CACHE_TAG,
  type WildwoodForBranch,
} from "./branch";
import { handle as createNextHandle } from "./handler";
import type { WildwoodClient } from "@/client/index";
import {
  activeRefSetCookieHeader,
  clearBranchCookieHeader,
} from "wildwood-shared";

// Re-export for convenience — one import surface for app wiring.
export { WILDWOOD_BRANCH_COOKIE, WILDWOOD_CACHE_TAG };

const DEFAULT_MUTATION_RE =
  /\/git\/(commit|discard|merge|pull|create-branch|switch-branch)\/?$/;

export type CreateWildwoodRouteOptions = {
  /**
   * Tag name used for content queries. Defaults to `WILDWOOD_CACHE_TAG` (`"wildwood"`).
   * Pass `"docs-content"` if your existing codebase uses that tag.
   *
   * Mutations call `revalidateTag(tag, "default")` so any `"use cache"` +
   * `cacheTag(tag)` boundaries re-render.
   */
  revalidateTagName?: string;
  /**
   * Cookie name used to persist the active branch. Defaults to
   * `WILDWOOD_BRANCH_COOKIE` (`x-wildwood-branch`). Legacy names are still cleared
   * on exit for compatibility.
   */
  branchCookieName?: string;
  /**
   * Extra cookie names to delete when disabling draft/preview. Defaults to
   * `WILDWOOD_BRANCH_COOKIE_FALLBACKS` (`x-content-branch`, `wildwood-active-ref`, `x-tr33-branch`, `tr33-active-ref`).
   * Deletions are idempotent.
   */
  legacyCookieNames?: readonly string[];
  /**
   * Regex that identifies git mutations that should trigger revalidation.
   * Defaults to commit / discard / merge / pull / create-branch / switch-branch.
   */
  mutationRe?: RegExp;
  /**
   * Override cookie store used for sync `revalidateTag` cache (advanced).
   * If you manage cookies elsewhere, pass `"default"` | `"layout"` per
   * Next.js docs. Defaults to `"default"`.
   */
  revalidateTagStore?: "default" | "layout";
};

type LazyHandler = ReturnType<typeof createNextHandle>;

function pathnameOf(req: Request): string {
  try {
    return new URL(req.url).pathname;
  } catch {
    return "";
  }
}

function cookieHeaderValue(name: string, ref: string, maxAge?: number): string {
  // When clearing we set Max-Age=0, Expires=epoch.
  if (maxAge === 0) return clearBranchCookieHeader(name);
  return activeRefSetCookieHeader(ref, name);
}

/**
 * Factory — returns `{ GET, POST, HEAD, OPTIONS }` that can be spread into
 * your catch-all route module.
 */
export function createWildwoodRoute(
  getClient: () => WildwoodClient | Promise<WildwoodClient>,
  opts: CreateWildwoodRouteOptions = {},
) {
  const tagName = opts.revalidateTagName ?? WILDWOOD_CACHE_TAG;
  const cookieName = opts.branchCookieName ?? WILDWOOD_BRANCH_COOKIE;
  const legacyNames = opts.legacyCookieNames ?? WILDWOOD_BRANCH_COOKIE_FALLBACKS;
  const mutationRe = opts.mutationRe ?? DEFAULT_MUTATION_RE;
  const tagStore = opts.revalidateTagStore ?? "default";

  // Lazily created so top-level import doesn't trigger DB access.
  let handlerPromise: Promise<LazyHandler> | null = null;
  function getHandler(): Promise<LazyHandler> {
    if (!handlerPromise) {
      handlerPromise = Promise.resolve(getClient()).then((c) =>
        createNextHandle(c as WildwoodForBranch as unknown as WildwoodClient),
      );
    }
    return handlerPromise;
  }

  async function apiFetch(req: Request): Promise<Response> {
    const h = await getHandler();
    return h(req);
  }

  function revalidateContent() {
    revalidateTag(tagName, tagStore as never);
  }

  function isDraftPath(pathname: string): boolean {
    // Canonical: /api/wildwood/draft and legacy /api/draft (if catch-all sits at /api/[...path])
    // Also keep /api/tr33/draft for backward compat during migration
    return pathname.endsWith("/wildwood/draft") || pathname.endsWith("/tr33/draft") || pathname.endsWith("/draft");
  }

  function isExitPreviewPath(pathname: string): boolean {
    return pathname.endsWith("/wildwood/preview") || pathname.endsWith("/preview/exit");
  }

  async function clearBranchCookies(jar: Awaited<ReturnType<typeof cookies>>) {
    jar.delete(cookieName);
    for (const name of legacyNames) {
      if (name !== cookieName) jar.delete(name);
    }
    // Extra guard: if canonical was customized but legacy list didn't include
    // the built-in default, still clear the default fallback names.
    for (const f of WILDWOOD_BRANCH_COOKIE_FALLBACKS) {
      if (f !== cookieName && !(legacyNames as readonly string[]).includes(f)) jar.delete(f);
    }
    if (cookieName !== WILDWOOD_BRANCH_COOKIE) jar.delete(WILDWOOD_BRANCH_COOKIE);
  }

  async function handleDraft(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const disable = url.searchParams.get("disable");
    const branch = url.searchParams.get("branch")?.trim() || "";

    try {
      if (disable) {
        const dm = (await import("next/headers")) as unknown as {
          draftMode: () => Promise<{ disable: () => void }>;
        };
        (await dm.draftMode()).disable();
        const jar = await cookies();
        await clearBranchCookies(jar);
        return NextResponse.json({ draftMode: false });
      }

      if (!branch) {
        return NextResponse.json({ error: "Missing ?branch=" }, { status: 400 });
      }

      const dm = (await import("next/headers")) as unknown as {
        draftMode: () => Promise<{ enable: () => void }>;
      };
      (await dm.draftMode()).enable();
      const jar = await cookies();
      // Write only canonical. Read path already falls back to legacy.
      jar.set(cookieName, branch, { path: "/" });
      return NextResponse.json({ draftMode: true, branch });
    } catch {
      // Non-Next environment or `next/headers` unavailable — degrade to cookie-only.
      // We don't have `cookies()` / `draftMode()` here, so just return 400-ish hint
      // rather than silently failing.
      if (disable) return NextResponse.json({ draftMode: false });
      if (!branch) return NextResponse.json({ error: "Missing ?branch=" }, { status: 400 });
      const headers = new Headers();
      headers.append("Set-Cookie", cookieHeaderValue(cookieName, branch));
      return new NextResponse(JSON.stringify({ draftMode: true, branch }), {
        headers,
        status: 200,
      });
    }
  }

  async function handleExitPreview(): Promise<Response> {
    try {
      const jar = await cookies();
      await clearBranchCookies(jar);
      try {
        const { draftMode } = (await import("next/headers")) as {
          draftMode: () => Promise<{ disable: () => void }>;
        };
        (await draftMode()).disable();
      } catch {
        // ignore — not in Next or unavailable
      }
    } catch {
      // ignore — non-Next
    }
    // No revalidateContent() here — draft is per-user; global purge would
    // invalidate everyone else. Real mutations revalidate below.
    return NextResponse.json({ ok: true });
  }

  async function GET(req: Request) {
    const pathname = pathnameOf(req);
    // Draft is now part of the catch-all: /api/wildwood/draft (and legacy /api/draft)
    if (isDraftPath(pathname)) return handleDraft(req);
    if (isExitPreviewPath(pathname)) return handleExitPreview();
    return apiFetch(req);
  }
  async function HEAD(req: Request) {
    return apiFetch(req);
  }
  async function OPTIONS(req: Request) {
    return apiFetch(req);
  }

  async function POST(req: Request) {
    const pathname = pathnameOf(req);

    // ── draft toggle (GET+POST) ───────────────────────────────────
    if (isDraftPath(pathname)) return handleDraft(req);

    // ── exit preview ─────────────────────────────────────────────────
    // Clears branch cookies so next render falls back to the configured
    // default ref. No global `revalidateTag` — would purge cache for all users.
    // Supports `POST .../wildwood/preview` (Kit toolbar) and legacy `/preview/exit`.
    if (isExitPreviewPath(pathname)) return handleExitPreview();

    // ── remember caller-intended branch name before consuming body ──
    let createBranchName: string | undefined;
    if (/\/git\/create-branch\/?$/.test(pathname)) {
      try {
        const b = (await req.clone().json()) as { name?: string };
        const n = typeof b.name === "string" ? b.name.trim() : "";
        if (n) createBranchName = n;
      } catch {
        // ignore — body may not be JSON (e.g. multipart)
      }
    }

    const upstream = await apiFetch(req);

    // ── mutation -> revalidate ───────────────────────────────────────
    if (mutationRe.test(pathname)) {
      revalidateContent();
    }

    // ── branch switch / create -> set branch cookie ──────────────────
    if (!/\/git\/(create-branch|switch-branch)\/?$/.test(pathname)) {
      return upstream;
    }

    let branch: string | undefined = createBranchName;
    if (!branch) {
      try {
        const data = (await upstream.clone().json()) as { ref?: string };
        if (typeof data.ref === "string" && data.ref.trim()) {
          branch = data.ref.trim();
        }
      } catch {
        // upstream may not be JSON (error) — fall through
      }
    }
    if (!branch) return upstream;

    // Merge branch cookie with whatever upstream set.
    const headers = new Headers(upstream.headers);
    // Remove any cookie the upstream handler set (we own preview cookie).
    headers.delete("set-cookie");
    headers.append("Set-Cookie", cookieHeaderValue(cookieName, branch));

    return new NextResponse(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  }

  // Common Next.js convention: delegate any extras to POST semantics.
  // PUT / PATCH / DELETE aren't used today but forward them for completeness.
  async function PUT(req: Request) {
    return POST(req);
  }
  async function PATCH(req: Request) {
    return POST(req);
  }
  async function DELETE(req: Request) {
    return POST(req);
  }

  return { GET, POST, HEAD, OPTIONS, PUT, PATCH, DELETE, tagName, cookieName, mutationRe };
}

/** Alias — same as `createWildwoodRoute`. */
export const createWildwoodRouteHandlers = createWildwoodRoute;
export const createRoute = createWildwoodRoute;
