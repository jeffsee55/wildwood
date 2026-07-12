/**
 * `tr33/nextjs/route`
 *
 * Next.js-specific route factory that owns everything that previously lived
 * copy-pasted in every app's `app/api/[...path]/route.ts`:
 *
 * - mounts the framework-agnostic H3 handler (`tr33/nextjs/handler`)
 * - branch cookie management (`x-tr33-branch` canonical, with legacy read support)
 * - `revalidateTag(TR33_CACHE_TAG)` on git mutations
 * - `/tr33/preview` exit endpoint (clears branch cookies + revalidates)
 * - `create-branch` / `switch-branch` response enrichment
 *
 * Draft mode is host-controlled. This module does NOT call `draftMode()`.
 * Your userland `/api/draft` route should do:
 *
 * ```ts
 * // app/api/draft/route.ts — userland, you own the mechanism
 * import { cookies, draftMode } from "next/headers";
 * import { type NextRequest, NextResponse } from "next/server";
 * import { TR33_BRANCH_COOKIE } from "tr33/nextjs/branch";
 *
 * export async function GET(request: NextRequest) {
 *   const branch = request.nextUrl.searchParams.get("branch");
 *   const disable = request.nextUrl.searchParams.get("disable");
 *   const jar = await cookies();
 *
 *   if (disable) {
 *     (await draftMode()).disable();
 *     jar.delete(TR33_BRANCH_COOKIE);
 *     jar.delete("x-content-branch");
 *     jar.delete("tr33-active-ref");
 *     return NextResponse.json({ draftMode: false });
 *   }
 *
 *   if (!branch) {
 *     return NextResponse.json({ error: "Missing ?branch=" }, { status: 400 });
 *   }
 *
 *   (await draftMode()).enable();
 *   jar.set(TR33_BRANCH_COOKIE, branch, { path: "/" });
 *   return NextResponse.json({ draftMode: true, branch });
 * }
 * ```
 *
 * When `draftMode().enable()` has been called, Next.js automatically
 * bypasses `"use cache"` boundaries, so `BlogList()` below always sees
 * fresh data in preview without extra logic:
 *
 * ```ts
 * import { cacheTag, cacheLife } from "next/cache";
 * import { TR33_CACHE_TAG } from "tr33/nextjs/branch";
 *
 * async function BlogList() {
 *   "use cache";
 *   cacheLife("hours");
 *   cacheTag(TR33_CACHE_TAG);
 *
 *   // tr33 client fetch — will be cached by branch=main, bypassed in draft
 *   const content = await tr33.docs.findMany({});
 *   return <ul>...</ul>;
 * }
 * ```
 *
 * Minimal app wiring:
 *
 * ```ts
 * // app/api/[...path]/route.ts
 * import { createTr33Route } from "tr33/nextjs/route";
 * import { getTr33 } from "@/lib/tr33";
 *
 * export const { GET, POST, HEAD, OPTIONS } = createTr33Route(() => getTr33(), {
 *   revalidateTagName: "docs-content", // optional, defaults to TR33_CACHE_TAG
 * });
 * ```
 */

import { cookies } from "next/headers";
import { revalidateTag } from "next/cache";
import { NextResponse } from "next/server";
import {
  TR33_BRANCH_COOKIE,
  TR33_CACHE_TAG,
  type Tr33ForBranch,
} from "./branch";
import { handle as createNextHandle } from "./handler";
import type { Tr33Client } from "@/client/index";
import {
  activeRefSetCookieHeader,
  clearBranchCookieHeader,
} from "@tr33/shared";

// Re-export for convenience — one import surface for app wiring.
export { TR33_BRANCH_COOKIE, TR33_CACHE_TAG };

const DEFAULT_MUTATION_RE =
  /\/git\/(commit|discard|merge|pull|create-branch|switch-branch)\/?$/;

export type CreateTr33RouteOptions = {
  /**
   * Tag name used for content queries. Defaults to `TR33_CACHE_TAG` (`"tr33"`).
   * Pass `"docs-content"` if your existing codebase uses that tag.
   *
   * Mutations call `revalidateTag(tag, "default")` so any `"use cache"` +
   * `cacheTag(tag)` boundaries re-render.
   */
  revalidateTagName?: string;
  /**
   * Cookie name used to persist the active branch. Defaults to
   * `TR33_BRANCH_COOKIE` (`x-tr33-branch`). Legacy names are still cleared
   * on exit for compatibility.
   */
  branchCookieName?: string;
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
export function createTr33Route(
  getClient: () => Tr33Client | Promise<Tr33Client>,
  opts: CreateTr33RouteOptions = {},
) {
  const tagName = opts.revalidateTagName ?? TR33_CACHE_TAG;
  const cookieName = opts.branchCookieName ?? TR33_BRANCH_COOKIE;
  const mutationRe = opts.mutationRe ?? DEFAULT_MUTATION_RE;
  const tagStore = opts.revalidateTagStore ?? "default";

  // Lazily created so top-level import doesn't trigger DB access.
  let handlerPromise: Promise<LazyHandler> | null = null;
  function getHandler(): Promise<LazyHandler> {
    if (!handlerPromise) {
      handlerPromise = Promise.resolve(getClient()).then((c) =>
        createNextHandle(c as Tr33ForBranch as unknown as Tr33Client),
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

  async function GET(req: Request) {
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

    // ── exit preview ─────────────────────────────────────────────────
    // Host clears branch cookies and busts cache so next render falls
    // back to the configured default ref.
    //
    // Supports both `.../tr33/preview` (new) and `GET /api/draft?disable=1`
    // style exits in userland; this handler only cares about clearing.
    if (pathname.endsWith("/tr33/preview") || pathname.endsWith("/preview/exit")) {
      try {
        const jar = await cookies();
        // Clear canonical + legacy so old branches don't linger.
        jar.delete(cookieName);
        // legacy variants — safe even if absent
        if (cookieName !== "tr33-active-ref") jar.delete("tr33-active-ref");
        if (cookieName !== "x-content-branch") jar.delete("x-content-branch");
        if (cookieName !== TR33_BRANCH_COOKIE) jar.delete(TR33_BRANCH_COOKIE);
      } catch {
        // ignore — in non-Next environments `cookies()` may not exist
      }
      revalidateContent();
      return NextResponse.json({ ok: true });
    }

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

/** Alias — same as `createTr33Route`. */
export const createTr33RouteHandlers = createTr33Route;
export const createRoute = createTr33Route;
