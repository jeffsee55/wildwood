---
title: Guides
author: ../authors/jeff.md
description: "Patterns used in this docs app for collections, reads, mounting the API, preview, editor, and deploying."
---

# Guides

This page collects the patterns actually used in `apps/docs` for `jeffsee55/wildwood`. Copy them directly — the code compiles against this repo's `wildwood` package.

## 1. Collections

```ts
// apps/docs/lib/wildwood.ts
import { createClient, defineConfig, z } from "wildwood";

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

// must be declared after `docs` so nav can connect to it without TDZ
const nav = z.collection({
  name: "nav",
  match: "content/nav/**/*.json",
  schema: z.json({
    name: z.filter(z.string()),
    label: z.string(),
    // Real relation — the indexer canonicalizes paths and resolves to docs.
    children: z.array(z.lazy(() => z.connect(docs))),
  }),
});

export const collections = { authors, docs, nav } as const;

export const config = defineConfig({
  org: "jeffsee55",
  repo: "wildwood",
  ref: "main",
  version: "docs-0",
  collections,
});
// localPath omitted — Wildwood auto-detects git checkout from cwd in dev/build.
// In production, GitHub remote or already-populated Turso DB is used.
```

`docs` first so `nav.children` can `lazy(() => connect(docs))` without a TDZ; and `authors` first so `docs.author` connects back. Cycles via `lazy` are fine.

## 2. Two queries (no fallback)

Layout owns nav. Pages own docs. No orphan-append or empty `notFound()` masking.

```tsx
// apps/docs/app/layout.tsx
import { wildwood } from "@/lib/wildwood";
const navRes = await wildwood.nav.findMany({ with: { children: true } });
const nav = navRes.items[0] ?? null;
const docs = (nav?.children ?? []) as Array<{ _meta:{path:string}; slug:string; title:string }>;
```

```tsx
// apps/docs/app/docs/[slug]/page.tsx
export async function generateStaticParams() {
  const { items } = await wildwood.docs.findMany({});
  return items.map((d) => ({ slug: d.slug }));
}

export default async function DocsPage({ params }: { params: Promise<{slug:string}> }) {
  const { slug } = await params;
  const res = await wildwood.docs.findFirst({ where:{slug}, with:{author:true} });
  const doc = res.value;
  if (!doc) notFound();
  // doc.title, doc.description, doc.body (mdast Root), doc.author?.name — fully typed
}
```

If `nav.children` vs `docs.findMany` diverge (for example a doc exists but nav hasn't included it), that surfaces intentionally — don't mask with orphans fallback. Notice `navRes.items[0]` because `content/nav/index.json` yields single entry.

No generic find types are exposed via a `Doc` interface file; everything inferred from `collections`.

## 3. Mounting the API — host owns cookies

```ts
// apps/docs/app/api/[...path]/route.ts
import { createWildwoodRoute } from "wildwood"nextjs/route";
import { wildwood } from "@/lib/wildwood";

export const { GET, POST, HEAD, OPTIONS, PUT, PATCH, DELETE } = createWildwoodRoute(
  () => wildwood,
  { revalidateTagName: "docs-content" },
);
```

That is the full wiring. `createWildwoodRoute` is Next-specific and lazy-initializes the underlying H3 handler which mounts `/git`, `/vscode`, `/github`. Around it, the factory adds:

- `GET/POST /api/wildwood/draft?branch=<ref>` and `?disable=1` (and legacy `/api/draft` alias) → `draftMode().enable()/disable()` + canonical branch cookie.
- `GET/POST /api/wildwood/preview` and legacy `/preview/exit` → clears cookies + disables draft.
- On `/git/create-branch` and `/git/switch-branch` responses, sets canonical branch cookie `x-tr33-branch` (decodes from returned `{ref}` or request `name` on create) and merges upstream `Set-Cookie` headers removed/replaced.
- On mutations (`commit | discard | merge | pull | create-branch | switch-branch`, customizable via `mutationRe`) calls `revalidateTag(tagName, store)` so `"use cache"` boundaries refresh.
- No `revalidateTag` on draft enter/exit — draft is per-user bypass (`__prerender_bypass`), purging would invalidate everyone else.

If you manage cookies elsewhere (middleware, custom path), you can avoid `createWildwoodRoute` and use `wildwood/nextjs/handler` (`handle`) directly, plus own `cookies` + `revalidateTag` yourself.

### Client singleton

`apps/docs/lib/wildwood.ts` owns the top-level singleton:

```ts
import { createClient as libsql } from "@libsql/client";
import { createClient } from "wildwood";

const database = libsql({
  url: process.env.WILDWOOD_DOCS_DATABASE_URL || "file:./tr33-docs.db",
  authToken: process.env.WILDWOOD_DOCS_DATABASE_AUTH_TOKEN || "",
});
// auth optional — only when GitHub App or allow-list needed
export const wildwood = createClient({ config, database, auth? });
```

No `getDocsTr33()` getter needed. Core factory stays pure — app owns the one singleton; Next reuses the module across requests. `createClient` self-heals via `findMany → switch → index` on cold cache.

## 4. Branch preview + editor

```tsx
// inlined auth — just check an env var, no extra module
import { Toolbar } from "wildwood"nextjs/kit";
import { wildwood } from "@/lib/wildwood";

export function DocsLayout({ children }) {
  return (
    <html>
      <body>
        {children}
        <Toolbar wildwood={tr33} apiBase="/api" />
      </body>
    </html>
  );
}
```

- With no `activeRef` / cookie logic in the host: `Toolbar`'s Server Component wrapper `WildwoodKit` now auto-resolves the active ref via `getBranch(wildwood)` (internally `await cookies()` from `next/headers`). Passing `activeRef` still works for custom cookie name override. No `cookies()` in layout.
- `theme` defaults to `"system"`. Remove `theme="light"` to respect `prefers-color-scheme`. If you pass `theme="light"` explicitly, Kit locks light ignoring system.
- Preview flow:

```ts
// inside Kit's FAB after branch mutation
// POST /api/git/switch-branch { ref }
or
// POST /api/git/create-branch { name, baseRef }
// Host's response path Sets cookie Set-Cookie: x-tr33-branch=<branch> and revalidates docs-content.
// Client soft-refresh via startTransition+router.refresh() coalesced 800ms (Set-Cookie commit race guard).

// Exit Preview button inside Kit
// POST /api/wildwood/preview → route factory clears cookie server-side → refresh
```

- Toolbar's BroadcastChannel sync + localStorage `wildwood.activeRef` are handled by Kit internally to keep extension host iframe in sync.

### Auth interior

- Library shows auth section when `_env` detects `GITHUB_APP_SLUG` + `GITHUB_APP_NAME` (public bits) or `auth` prop supplied. Private signing keys never leave server. `auth` merges `envAuth` + prop (`githubApp` shallow+mapped).
- Prod check in Kit enforces: if `NODE_ENV=production` + `auth.enforceInProduction` defaults true + `githubApp.appSlug` missing → throw a clear error (`"GITHUB_APP_SLUG missing. Set GITHUB_APP_SLUG (and GITHUB_APP_ID)"`), preventing prod unauthed silent run.
- Dev tolerance: shows auth panel if any of `githubApp.appSlug|githubApp.name|userEmail|githubOAuthEnabled` present, else hides. Pass `auth.enabled=false` to suppress in dev.

## 5. Recipes

### Read from another branch (no cookies)

```ts
const main    = await wildwood.docs.findMany({ ref: "main" });
const feature = await wildwood.docs.findMany({ ref: "feature/rewrite" });
```

### Guard mutations (authorize)

`auth.authorize` in `createClient({ auth: { github, authorize } })` is called by the git-service router. Return `true` to allow, `false` or a custom `Response` to block.

```ts
const wildwood = createClient({
  config, database,
  auth: {
    github: { type:"app", app:{ appId, privateKey } },
    betterAuth: betterAuthInstance,
    authorize(ctx) {
      // prevent pushes from non-editors, allow branch creation for editors etc.
      if (ctx.action.type === "git.push" && !isEditor(ctx.user)) return false;
      return true;
    },
  },
});
```

Caller actor is resolved via `betterAuth` (session via `api.getSession`) or custom `getUser(req)`.

### Dark mode

System dark auto via `prefers-color-scheme` media query and `color-scheme: light dark` + `.dark` class variant. Docs app's `globals.css` maps media and `dark` variants to same tokens — phosphor palette (`#0c0b0a` / `#f2ece6`) with looser `typeset` leading (1.95) on dark. Kit follows too (its ThemeProvider listens to media query and sets shadow host `dark` class, `colorScheme`, `data-kit-theme`). No toggle needed; if you add toggle in future inject before-paint script and toggle `.dark` class on `html`.

### Links in markdown

```tsx
function resolveHref(href: string): string {
  if (!href) return "#";
  if (href.endsWith(".md")) return `/docs/${href.replace(/^\.\//,"").replace(/\.md$/,"")}`;
  return href;
}

<Markdown
  root={doc.body}
  components={{
    a: ({ href, children, ...rest }) => (
      <Link href={resolveHref(href ?? "#")} {...(rest as any)}>{children}</Link>
    )
  }}
/>
```

`Markdown` forwards `Link` when present, otherwise own `<a>`. Avoid wrapping `Markdown` in layout — own the `a` component override in each page.

### Nav generation

```ts
// generateStaticParams from docs
const { items } = await wildwood.docs.findMany({});
return items.map((d)=>({ slug: d.slug }));

// Sidebar sorting — fully ordered by nav.children, not slug lexicographic
const navRes = await wildwood.nav.findMany({ with:{children:true} });
const docs = navRes.items[0]?.children ?? [];
```

### Deploying

- Use `WILDWOOD_DOCS_DATABASE_URL=libsql://...` Turso on Vercel (or `file:` relative only in preview/dev).
- In build, `.git` present → `NativeRemote` indexes to that Turso (build prefetch).
- Runtime on Vercel has no `.git` → reads only Turso. Cold miss fails fast with actionable message vs cryptic `Missing schema`.
- `.env.example` in repo root lists full contract: `WILDWOOD_GITHUB_ORG/REPO`, `WILDWOOD_DOCS_REF`(or `VERCEL_GIT_COMMIT_SHA`), `TR33_DOCS_DATABASE_{URL,AUTH_TOKEN}`, `GITHUB_APP_*`, `WILDWOOD_DOCS_SOURCE` override.

## 6. Common failures

- `Cannot read useRef of null` in Kit before → fixed by `ClientKitBoundary` gating shadow DOM/portal behind SSR boundary (Server → dynamic import with `ssr:false`).
- Phantom SCM changes on new draft draft branches → fixed by new branches starting clean (never inheriting base ref's sparse overlay).
- SCM walking entire repo on editor open → limited traversal, git-service tree cache + `git.getTree` reuse.
- Editor 500 from relative URLs on server → normalized origin base for iframe src + header normalization via `normalizeApiBase`.

See [API](./api.md) for the surface spec and [Deploy](./deploy.md) for Vercel details.
