---
title: Branching and preview
author: ../authors/jeff.md
description: "How branches become preview environments — cookies, draft mode, revalidation, and exit."
---

# Branching and preview

Every markdown edit happens on a branch. tr33 wires branches to preview via a cookie, Next's `draftMode`, and `cacheTag`/`revalidateTag`. This page explains how the pieces fit.

## The cookie

Canonical name: `x-tr33-branch` (`TR33_BRANCH_COOKIE` in `@tr33/shared` / `tr33/nextjs/branch`). Legacy names `x-content-branch` and `tr33-active-ref` are still read (for migration) and are cleared on draft exit. New writes always use the canonical name.

When the user switches branches or creates a branch in the Kit toolbar (or any UI that calls the git service API), the host sets the cookie. Next renders then use that branch for all queries even though the data layer is shared.

## Resolution

```ts
import { getBranch, resolveBranch, cookiesFromCookieHeader } from "tr33/nextjs/branch";
import type { Tr33ForBranch } from "tr33/nextjs/branch";

// Server Component / Route (preferred): no manual cookie work
const ref = await getBranch(tr33);
// => tr33- cookie if present (canonical then fallbacks), else tr33._.config.ref

// With an explicit Next.js cookie store you already called:
const ref = resolveBranch({ tr33, cookies: await cookies() });

// From a raw Cookie header (H3, workers, edge middleware):
const ref = resolveBranch({
  tr33,
  cookies: cookiesFromCookieHeader(req.headers.get("cookie")),
});

// Override cookie name / fallback set:
resolveBranch({ tr33, cookies, cookieName: "x-my-branch", fallbackCookieNames: ["tr33-active-ref"] });
```

`getBranch` is the ergonomic wrapper around `resolveBranch` — it will attempt `await import("next/headers")` internally. If that fails (client component, non-Next runtime) it falls back to `config.ref` and never throws. Outside Next you must supply either a `cookies` jar or raw header via `cookiesFromCookieHeader`.

`resolveBranch` searches in this order:

1. `cookieName` (default `x-tr33-branch`)
2. `TR33_BRANCH_COOKIE_FALLBACKS` (`x-content-branch`, `tr33-active-ref`)
3. Falls back to `tr33._.config.ref`

## Route factory owns the wiring

In a typical Next.js app this is all you write:

```ts
// app/api/[...path]/route.ts
import { createTr33Route } from "tr33/nextjs/route";
import { tr33 } from "@/lib/tr33";

export const { GET, POST, HEAD, OPTIONS, PUT, PATCH, DELETE } = createTr33Route(
  () => tr33,
  { revalidateTagName: "docs-content" },
);
```

`createTr33Route` is a Next.js-specific wrapper around the framework-agnostic H3 handler (`tr33/nextjs/handler`). It:

- Lazily builds `handle(tr33)` (pure `Request → Response`, no `next/*`).
- Handles draft mode via `GET /api/tr33/draft?branch=<ref>` and `?disable=1` (legacy `/api/draft` also recognized for migration).
- Exits preview via `GET /api/tr33/preview` or `POST …/tr33/preview` (legacy `/preview/exit`).
- Sets the branch cookie on `POST /api/git/create-branch` and `POST /api/git/switch-branch` (using the returned `{ ref }` or the `name` from the request body for create).
- Clears canonical + legacy branch cookies (+ legacy names in the constructed options) on exit, disables draft mode, and never clears other cookies.
- Calls `revalidateTag(tagName, store)` on real mutations (`commit | discard | merge | pull | create-branch | switch-branch`) so `"use cache"` boundaries refresh. It does **not** global-purge on draft enter/exit — `draftMode().enable()` bypasses `"use cache"` per-user via `__prerender_bypass`. Purging would invalidate everyone else.

Override knobs:

```ts
createTr33Route(() => tr33, {
  revalidateTagName: "docs-content",  // tag name (default TR33_CACHE_TAG "tr33")
  branchCookieName: "x-tr33-branch",  // default TR33_BRANCH_COOKIE
  legacyCookieNames: ["x-content-branch","tr33-active-ref"],
  mutationRe: /\/git\/(commit|discard|…)/,
  revalidateTagStore: "default",      // "default" | "layout"
});
```

`createTr33RouteHandlers` / `createRoute` are aliases.

## Dedicated draft route (optional)

Most apps don't need this file at all — draft is inside the catch-all above. When you do want a standalone file (no catch-all, or a custom path), use `createDraftRoute`:

```ts
// app/api/draft/route.ts
import { createDraftRoute } from "tr33/nextjs/draft";
export const { GET, POST } = createDraftRoute();
```

Same `?branch=` / `?disable=1` contract. Writes only the canonical cookie on enable, clears canonical + fallbacks on disable.

## Per-user draft bypass

When `draftMode().enable()` has been called, Next.js automatically bypasses every `"use cache"` boundary for that user. One typical shape:

```ts
import { cacheLife, cacheTag } from "next/cache";
import { TR33_CACHE_TAG } from "tr33/nextjs/branch";
import { tr33 } from "@/lib/tr33";

async function DocList() {
  "use cache"; cacheLife("hours"); cacheTag(TR33_CACHE_TAG);
  const { items } = await tr33.docs.findMany({});
  return <ul>{items.map(i => <li key={i.path}>{i.title}</li>)}</ul>;
}
```

Because draft bypass is per-user, `createTr33Route` intentionally does not call `revalidateTag` on draft enter/exit — only on real mutations. Otherwise enabling preview for one editor would purge the production cache for every visitor.

## Exit preview / entering a branch

Kit's Exit Preview button `POST`s `/api/tr33/preview`. The route factory's factory handler clears cookies and disables draft mode, then the client soft-navigates (often via `router.refresh()` + `startTransition`). No full page reload is needed, though the docs app currently does a soft refresh to remount RSC boundaries.

Entering a branch: any UI that `POST`s `/api/git/create-branch` or `/api/git/switch-branch` gets back `{ ref, commit, ... }`. The route factory extracts `ref` and merges `Set-Cookie: x-tr33-branch=<ref>; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`. `TR33_CACHE_TAG` is revalidated immediately via the mutation hook.

## H3 only (no Next.js)

If you host tr33 in a non-Next Fetch runtime, skip `createTr33Route` and use the raw handler:

```ts
import { handle } from "tr33/nextjs/handler";

const api = handle(tr33);
// Request → Response. Framework owns cookies + revalidateTag in that env too.
export const fetch = async (req: Request) => api(req);
```

The canonical constants + `cookiesFromCookieHeader` / `resolveBranch` in `tr33/nextjs/branch` are framework-agnostic; use them to build your own preview toggle.

Next: [Editor routes](./editor-routes.md) (branch/create/commit/push bits) then [Kit toolbar](./kit.md).
