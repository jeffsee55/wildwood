---
title: API reference
author: ../authors/jeff.md
description: The public surface you actually use while dogfooding docs — collections, findMany, refs, H3 handler, branch-preview helpers.
---

# API reference

This page reflects the surface validated against this repo's own `content/` source. See `content/docs/intro.md` for the minimal setup.

## `defineConfig`

```ts
function defineConfig(input: {
  org: string;
  repo: string;
  ref: string;
  localPath?: string;   // when set, NativeRemote reads local checkout
  version: string;      // bump when your filter/schema shape changes
  collections: Record<string, Collection>
  variants?: Record<string, VariantConfig>
}): Config
```

- `localPath` — point at this repo in dev / build prefetch. Omit on Vercel prod (deployed build reads only the LibSQL index).
- `ref` — default ref for collection queries when not passed explicitly.

## `z.collection`

```ts
const docs = z.collection({
  name: "docs",
  match: "content/docs/**/*.md",
  schema: z.markdown({
    title: z.filter(z.string()),          // filterable
    description: z.string().optional(),   // stored
    author: z.lazy(() => z.connect(authors)).optional(),
  }),
});

// JSON collection counterpart:
const nav = z.collection({
  name: "nav",
  match: "content/nav/**/*.json",
  schema: z.json({
    name: z.filter(z.string()),
    label: z.string(),
    children: z.array(z.string()),
  }),
});
```

`z.filter(T)` marks a field as filterable in `findMany({ where })`. `connect(other)` declares a relation (resolved from that field's value; path or id depending on collection conventions).

## `createClient`

```ts
import { createClient } from "tr33";
import { createClient as libsql } from "@libsql/client";

const database = libsql({
  url: process.env.TR33_DOCS_DATABASE_URL || "file:./tr33-docs.db",
  authToken: process.env.TR33_DOCS_DATABASE_AUTH_TOKEN || "",
});

const tr33 = createClient({ config, database, auth });
// tr33.docs.findMany(...)
// tr33._.git, tr33._.db, tr33._.config
```

Auth is optional: pass `{ github, authorize }` only when you want to enforce GitHub App or allow-list rules on the shared API.

## Collection queries

```ts
// All docs in the default (or passed) ref
const all = await tr33.docs.findMany({});

// Filtered, with author resolved
const one = await tr33.docs.findMany({
  where: { title: { eq: "Introduction" } },
  with: { author: true },
});
```

`ref` override:

```ts
const branchDocs = await tr33.docs.findMany({ ref: "feature/my-branch" });
```

`with` and nested `where` work on connected fields. `filters` and `connections` tables are materialized during `git.switch` (which `findMany`/`findFirst` fall through to automatically on a cold cache).

## H3 handler — `handle` / `createHandler`

```ts
import { createHandler, handle } from "tr33/nextjs";

const api = handle(client);           // (req: Request) => Promise<Response>
const app = createHandler(client);    // H3 app if you want to mount sub-routers
```

Pure Fetch, no `next/*`. Host responsibility:

- cookies (`tr33-active-ref`) set on `POST /git/create-branch` and `POST /git/switch-branch`
- cleared on `POST …/tr33/preview`
- `revalidateTag(tag)` after mutations so server components refresh

Use in Next's catch-all app route:

```ts
// app/api/[...path]/route.ts
export { GET, HEAD, OPTIONS, POST } from "./route-impl"
```

or in any Fetch/H3 runtime (Nitro, Cloudflare Workers via adapter, standalone server).

## Branch preview helpers

```ts
import {
  cookiesFromCookieHeader,
  resolveActiveRef,
  activeRefSetCookieHeader,
  TR33_ACTIVE_REF_COOKIE,
} from "tr33/nextjs";
```

- `cookiesFromCookieHeader(req.headers.get("cookie"))` — framework-free cookie jar for `resolveActiveRef`.
- `resolveActiveRef({ tr33, cookies })` — `tr33-active-ref` cookie or `config.ref` fallback.
- `activeRefSetCookieHeader(ref)` — `Set-Cookie` string the host should return.

### Kit

```tsx
import { Toolbar } from "tr33/nextjs";

<Toolbar
  tr33={tr33}
  activeRef={activeRef}   // from resolveActiveRef, or client.getActiveRef()
  apiBase="/api"
  theme="light"
  auth={getDocsKitAuth()}
/>
```

Kit reads no cookies itself; the host passes `activeRef` and controls the editor origin via `apiBase`. Kit's broadcast channels (`tr33-kit-host-ref`, etc.) live in `@tr33/shared` — used to keep the embedded VS Code iframe in sync with preview branch changes.

## Editor routes (built into the handler)

Mounted at `apiBase` — the docs app uses `/api`:

- `GET /api/git/branches` — local refs ∪ remote refs (via `git.remote.listBranches()`)
- `GET /api/git/editor-guards` — GitHub App install check + VS Code commit pin
- `GET /api/git/editor-bootstrap` — verifies active ref is indexed, returns VS Code commit
- `POST /api/git/switch-branch { ref }`
- `POST /api/git/create-branch { name, baseRef | base }`
- `POST /api/git/commit | discard | push | pull | merge` — gated by `authorize` when configured
- `POST /api/vscode/cdn/…` — proxied VS Code web shell + static assets

All routes are CORS + no-store safe; the handler adds `Access-Control-Allow-*` and removes its own `Set-Cookie` so the host's value is authoritative.

## Vercel / build prefetch

Client self-heals — no explicit ready-check needed. `findMany` / `findFirst` fall through to `git.switch` on a cold cache (missing tables → `db.init`, missing worktree → `switch` + `writeEntries`). In prod (Vercel, no checkout) a cold cache fails fast with a clear message; populate Turso during `next build` (which has the local checkout) so prod is DB-only.

Env contract (`.env.example`):

```sh
TR33_GITHUB_ORG=jeffsee55
TR33_GITHUB_REPO=tr33
TR33_DOCS_REF=main            # or deployment SHA on Vercel

TR33_DOCS_DATABASE_URL=       # LibSQL/Turso
TR33_DOCS_DATABASE_AUTH_TOKEN=

GITHUB_APP_ID=                # required for live edits against this repo
GITHUB_PRIVATE_KEY=
GITHUB_APP_INSTALLATION_ID=   # optional optimization
GITHUB_APP_SLUG=              # install prompt URL
```

`TR33_DOCS_SOURCE=local` forces NativeRemote even when GITHUB_APP_* are set (useful in dev when gating GitHub).

## Types

```ts
import type { Tr33Client } from "tr33";
import type { KitAuthConfig } from "tr33/nextjs";
```

`KitAuthConfig` is `{ githubApp?: { appSlug?, name?, origin? } }` — controls the install section in Kit and the editor's origin header.

For internals (`git.getTree`, worktree resolution) see `packages/tr33/src/git/git.ts`; for the query builder see `sqlite/query-builder.ts`. The public docs surface is intentionally narrower than what's in `types.ts`.
