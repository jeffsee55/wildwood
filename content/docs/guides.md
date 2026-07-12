---
title: Guides
author: ../authors/jeff.md
description: How to wire Tr33 in this repo's docs app — the pattern to copy for your own site.
---

# Guides

These are the patterns used in this docs site. It dogfoods against this repo (`jeffsee55/tr33`), local in dev and GitHub-backed in prod when `GITHUB_APP_*` is configured.

## 1. Collections

```ts
// apps/docs/lib/tr33.ts
import { createClient, defineConfig, z } from "tr33";

const authors = z.collection({
  name: "authors",
  match: "content/authors/**/*.md",
  schema: z.markdown({ name: z.filter(z.string()), avatar: z.string().optional() }),
});

const docs = z.collection({
  name: "docs",
  match: "content/docs/**/*.md",
  schema: z.markdown({
    title: z.filter(z.string()),
    description: z.string().optional(),
    author: z.lazy(() => z.connect(authors)).optional(),
  }),
});

const nav = z.collection({
  name: "nav",
  match: "content/nav/**/*.json",
  schema: z.json({
    name: z.filter(z.string()),
    label: z.string(),
    // Real relation: children resolve to docs, in declared order.
    children: z.array(z.lazy(() => z.connect(docs))),
  }),
});

export const collections = { authors, docs, nav } as const;

export const config = defineConfig({
  org: "jeffsee55",
  repo: "tr33",
  ref: "main",
  version: "docs-0",
  collections,
});
```

`localPath` is absent — `tr33` auto-detects the git checkout from cwd.

## 2. The two queries (no franken-index)

Layout owns nav. Pages own docs. No fallbacks — missing nav surfaces as empty sidebar, missing doc surfaces as `notFound()`.

```tsx
// apps/docs/app/layout.tsx — navigation
import { tr33 } from "@/lib/tr33";

const navRes = await tr33.nav.findMany({
  with: { children: true },
});
const nav = navRes.items[0] ?? null;
// nav.children are the ordered docs
```

```tsx
// apps/docs/app/docs/[slug]/page.tsx — static params = all docs
export async function generateStaticParams() {
  const { items } = await tr33.docs.findMany({});
  return items.map((d) => ({ slug: d.slug }));
}

// doc page
const { value: doc } = await tr33.docs.findFirst({ where: { slug } });
if (!doc) notFound();
```

If `nav.children` and `docs.findMany` diverge, that surfaces intent mismatch — don't mask it with orphans-appended fallback.

## 3. Mounting the API — host owns cookies

```ts
// apps/docs/app/api/[...path]/route.ts
import { cookies } from "next/headers";
import { revalidateTag } from "next/cache";
import { NextResponse } from "next/server";
import { activeRefSetCookieHeader, handle, TR33_ACTIVE_REF_COOKIE } from "tr33/nextjs";
import { tr33 } from "@/lib/tr33";

const REVALIDATE_TAG = "docs-content";
const api = handle(tr33);

export async function POST(req: Request) {
  const pathname = new URL(req.url).pathname;

  if (pathname.endsWith("/tr33/preview")) {
    (await cookies()).delete(TR33_ACTIVE_REF_COOKIE);
    revalidateTag(REVALIDATE_TAG, "default");
    return NextResponse.json({ ok: true });
  }

  const upstream = await api(req);

  // host sets the branch cookie on create / switch
  if (/\/git\/(create-branch|switch-branch)\/?$/.test(pathname)) {
    let branch: string | undefined;
    try { branch = (await upstream.clone().json()).ref; } catch {}
    if (branch) {
      const headers = new Headers(upstream.headers);
      headers.append("Set-Cookie", activeRefSetCookieHeader(branch));
      return new NextResponse(upstream.body, { status: upstream.status, headers });
    }
  }

  // revalidate after git mutations so server-components see the update
  if (/\/git\/(commit|discard|merge|pull|create-branch|switch-branch)\/?$/.test(pathname)) {
    revalidateTag(REVALIDATE_TAG, "default");
  }

  return upstream;
}

export const GET     = (req: Request) => api(req);
export const HEAD    = (req: Request) => api(req);
export const OPTIONS = (req: Request) => api(req);
```

This is the full surface the library intentionally doesn't own: cookies + cache invalidation live in your app.

## 4. Branch preview + editor

```tsx
// Inlined auth — just check an env var, no extra module.
const auth = process.env.GITHUB_APP_ID?.trim()
  ? { githubApp: { appSlug: process.env.GITHUB_APP_SLUG?.trim(), name: "Tr33 Docs" } }
  : undefined;

<Toolbar tr33={tr33} apiBase="/api" theme="light" auth={auth} />
```

Switching or creating a branch in Kit:

- `POST /api/git/switch-branch { ref }` or `POST /api/git/create-branch { name, baseRef }`
- Host returns `Set-Cookie: tr33-active-ref=<branch>`
- Server-component refresh re-reads `activeRef` → Kit highlights the ref
- Exit preview `POST /api/tr33/preview` clears the cookie server-side

## 5. Common recipes

### Read from a non-default branch

```ts
const main    = await tr33.docs.findMany({ ref: "main" });
const feature = await tr33.docs.findMany({ ref: "feature/notion" });
```

### Guard mutations

`auth.authorize` in `createClient({ auth })` is called by the git-service router. Return `true` to allow, `false` or a custom `Response` to block.

### Client singleton

`apps/docs/lib/tr33.ts` owns the top-level `export const tr33`. No `getDocsTr33()` wrapper. Core factory stays pure — app owns the one singleton; Next reuses the module. `createClient` self-heals on cold cache via `findMany → switch → index`.

See [API](./api.md) for the surface spec.
