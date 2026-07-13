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
  // org/repo/ref/origin omitted — auto-resolved from VERCEL_GIT_* / git remote / defaults
  // No WILDWOOD_GITHUB_ORG / WILDWOOD_GITHUB_REPO fallback cascade.
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
import { createWildwoodRoute } from "wildwood/nextjs/route";
import { wildwood } from "@/lib/wildwood";

export const { GET, POST, HEAD, OPTIONS, PUT, PATCH, DELETE } = createWildwoodRoute(
  () => wildwood,
  { revalidateTagName: "docs-content" },
);
```

That is the full wiring. `createWildwoodRoute` is Next-specific and lazy-initializes the underlying H3 handler which mounts `/git`, `/vscode`, `/github`. Around it, the factory adds:

- `GET/POST /api/wildwood/draft?branch=<ref>` and `?disable=1` (and legacy `/api/draft` alias) → `draftMode().enable()/disable()` + canonical branch cookie.
- `GET/POST /api/wildwood/preview` and legacy `/preview/exit` → clears cookies + disables draft.
- On `/git/create-branch` and `/git/switch-branch` responses, sets canonical branch cookie `x-wildwood-branch` (decodes from returned `{ref}` or request `name` on create) and merges upstream `Set-Cookie` headers removed/replaced.
- On mutations (`commit | discard | merge | pull | create-branch | switch-branch`, customizable via `mutationRe`) calls `revalidateTag(tagName, store)` so `"use cache"` boundaries refresh.
- No `revalidateTag` on draft enter/exit — draft is per-user bypass (`__prerender_bypass`), purging would invalidate everyone else.

If you manage cookies elsewhere (middleware, custom path), you can avoid `createWildwoodRoute` and use `wildwood/nextjs/handler` (`handle`) directly, plus own `cookies` + `revalidateTag` yourself.

### Client singleton

`apps/docs/lib/wildwood.ts` owns the top-level singleton — explicit env mapping, no fallbacks inside wildwood:

```ts
import { createClient as libsql } from "@libsql/client";
import { createClient } from "wildwood";

const database = libsql({
  url: process.env.TURSO_DATABASE_URL || "file:./wildwood.db",
  authToken: process.env.TURSO_AUTH_TOKEN || "",
});
// auth optional — explicit, no WILDWOOD_* fallbacks
export const wildwood = createClient({ config, database, auth });
```

Route owns auth with explicit mapping + autodetect for origin:

```ts
// app/api/[...path]/route.ts
createWildwoodRoute(() => wildwood, {
  auth: {
    database: { url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN },
    secret: process.env.BETTER_AUTH_SECRET,
    // baseURL / trustedOrigins omitted → autodetected from Request — no NEXT_PUBLIC_ORIGIN needed
    github: { clientId: process.env.GITHUB_CLIENT_ID!, clientSecret: process.env.GITHUB_CLIENT_SECRET! },
    authenticate: async ({ user }) =>
      ["you@example.com"].includes(user.email?.toLowerCase() ?? ""),
    authorize: async ({ user }) => !!user,
  },
});
```

- `authenticate` = sign-in/sign-up gate (not distinguished; inspect `provider` if you ever need different rules).
- `authorize` = per-action gate (git, content).
- No `allowedEmails` array or `NEXT_PUBLIC_ORIGIN` / `BETTER_AUTH_TRUSTED_ORIGINS` env fallbacks inside wildwood — that's userland callback + Request autodetect.

No `getDocsTr33()` getter needed. Core factory stays pure — app owns the one singleton; Next reuses the module across requests. `createClient` self-heals via `findMany → switch → index` on cold cache.

## 4. Branch preview + editor

```tsx
// inlined auth — just check an env var, no extra module
import { Toolbar } from "wildwood/nextjs/kit";
import { wildwood } from "@/lib/wildwood";

export function DocsLayout({ children }) {
  return (
    <html>
      <body>
        {children}
        <Toolbar wildwood={wildwood} apiBase="/api" />
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
// Host's response path Sets cookie Set-Cookie: x-wildwood-branch=<branch> and revalidates docs-content.
// Client soft-refresh via startTransition+router.refresh() coalesced 800ms (Set-Cookie commit race guard).

// Exit Preview button inside Kit
// POST /api/wildwood/preview → route factory clears cookie server-side → refresh
```

- Toolbar's BroadcastChannel sync + localStorage `wildwood.activeRef` are handled by Kit internally to keep extension host iframe in sync.

### Auth interior

- Library shows auth section when `_env` detects `GITHUB_APP_SLUG` + `GITHUB_APP_NAME` (public bits) or `auth` prop supplied. Private signing keys never leave server. `auth` merges `envAuth` + prop (`githubApp` shallow+mapped).
- Auth is non-throwing in the client Kit: when `githubApp` is missing in prod, the Kit surfaces a `console.warn` and disables editing affordances with an inline “Set up GitHub App” entrypoint (`setupHintLabel`). The floating editor is wrapped in `KitErrorBoundary`/`WildwoodToolbarBoundary` so any render or chunk error shows a fixed-position fallback and never crashes the content page. Gate writes server-side in `/api/wildwood/github/*` if you need to enforce production auth; the Kit itself is UI-only.
- Dev tolerance: shows auth/setup panel even when no GitHub App is configured (so first-run setup is discoverable). Pass `auth.enabled=false` to suppress the auth entry entirely when you embed the Kit in read-only mode.

## 5. Recipes

### Read from another branch (no cookies)

```ts
const main    = await wildwood.docs.findMany({ ref: "main" });
const feature = await wildwood.docs.findMany({ ref: "feature/rewrite" });
```

### Guard mutations (authenticate vs authorize)

`authenticate` gates who may have a session at all (sign-in + sign-up, not distinguished):

```ts
authenticate: async ({ user, request, provider }) => {
  // userland allow-list — no ALLOWED_EMAILS split inside wildwood
  const allow = ["you@example.com", "teammate@example.com"];
  if (provider === "github") return allow.includes(user.email?.toLowerCase() ?? "");
  return !!user.email;
}
```

`authorize` gates what a signed-in user may do. It lives **only** on `createWildwoodRoute({ auth })` — `createClient({ provider })` is transport-only, no authz:

```ts
// app/api/[...path]/route.ts — only place authorize/authenticate live
createWildwoodRoute(() => wildwood, {
  auth: {
    secret: process.env.BETTER_AUTH_SECRET!,
    github: true,
    authenticate: async ({ user }) => allowList.has(user.email?.toLowerCase() ?? ""),
    authorize: async ({ user, action }) => {
      if (action.type === "content.update" && action.path === "docs/intro.md") return false;
      if (action.type === "git.commit" && action.ref === "main") return !!user;
      return true;
    },
  },
});
```

Route resolves session via better-auth (lazy, same Turso DB) before calling either callback. This is also how capabilities preflight (`/api/wildwood/auth/capabilities`) and H3 git mutations are gated — route injects the same `authorize` fn into the H3 handlers.

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

- `TURSO_DATABASE_URL=libsql://…` via Vercel marketplace — canonical. No `WILDWOOD_DOCS_DATABASE_URL` / `LIBSQL_URL` fallback inside wildwood; host maps env explicitly. `file:` fallback only local dev.
- In build, `.git` present → `NativeRemote` indexes to Turso (prefetch). Runtime on Vercel has no `.git` → reads Turso. Cold miss fails fast.
- Auth: `BETTER_AUTH_SECRET` + `GITHUB_CLIENT_ID/SECRET` (same App = OAuth + git) + `authenticate` callback (replaces `allowedEmails`). `baseURL` / `trustedOrigins` omitted → autodetected from Request — no `NEXT_PUBLIC_ORIGIN` / `BETTER_AUTH_TRUSTED_ORIGINS` env needed.
- `.env.example` lists: `TURSO_*`, `GITHUB_APP_*` 5-var single set, `BETTER_AUTH_SECRET`, `ALLOWED_EMAILS` (parsed in YOUR `authenticate`, not wildwood) — no `WILDWOOD_GITHUB_ORG/REPO` or `WILDWOOD_DOCS_REF` fallbacks; pass explicit `org`/`repo`/`ref` in `defineConfig` if you need override.

## 6. Common failures

- `Cannot read useRef of null` in Kit before → fixed by `ClientKitBoundary` gating shadow DOM/portal behind SSR boundary (Server → dynamic import with `ssr:false`).
- Phantom SCM changes on new draft draft branches → fixed by new branches starting clean (never inheriting base ref's sparse overlay).
- SCM walking entire repo on editor open → limited traversal, git-service tree cache + `git.getTree` reuse.
- Editor 500 from relative URLs on server → normalized origin base for iframe src + header normalization via `normalizeApiBase`.

See [API](./api.md) for the surface spec and [Deploy](./deploy.md) for Vercel details.
