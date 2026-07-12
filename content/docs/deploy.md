---
title: Deploy
author: ../authors/jeff.md
description: "Building for production, Turso and LibSQL indexing, Vercel setup, and GitHub App manifest."
---

# Deploy

tr33's deployment model keeps the hot path entirely on DB reads. Git checkout (local or GitHub API) is only needed at build and on incremental writes.

## Build prefetch

In dev and during `next build`, if a Git checkout exists (auto-detected or via `TR33_DOCS_REPO_PATH` / `localPath`), tr33 uses `NativeRemote`. At query time, if the cache for `ref` is cold (no entries, no ref row), `findMany` → `ensureRefInDb(ref)` → `git.switch(ref)` traverses the git tree, reads blobs matching your collections, parses frontmatter/filters, records connections, and stores to LibSQL (the same DB driver you pass to `createClient`). Subsequent reads in the same build hit DB.

That DB — `file:./tr33-docs.db` locally or `TR33_DOCS_DATABASE_URL` (Turso) — is the deployment artifact to populate. Vercel can run `next build` with the checkout available (your git repo clone for the build) and then you point runtime at Turso that already has the indexed rows.

## Vercel + Turso pattern (this docs app)

```ts
// lib/wildwood.ts
import { createClient as libsql } from "@libsql/client";
import { createClient, defineConfig, z } from "wildwood";

const ORG = process.env.TR33_GITHUB_ORG || "jeffsee55";
const REPO = process.env.TR33_GITHUB_REPO || "tr33";
const REF = process.env.TR33_DOCS_REF?.trim()
        || process.env.VERCEL_GIT_COMMIT_SHA?.trim()
        || "main";

const config = defineConfig({
  org: ORG, repo: REPO, ref: REF,
  version: "docs-0",
  collections: { /* ... */ },
});

const database = libsql({
  url: process.env.TR33_DOCS_DATABASE_URL || "file:./tr33-docs.db",
  authToken: process.env.TR33_DOCS_DATABASE_AUTH_TOKEN || "",
});

export const tr33 = createClient({ config, database });
```

- During build (`NEXT_PHASE=phase-production-build`), `TR33_DOCS_SOURCE` is ignored for local auto-detection — the build host has a `.git` dir so it uses the NativeRemote, indexes to whatever LibSQL driver you passed. If you set `TR33_DOCS_DATABASE_URL=libsql://...` that directly writes to Turso at build; if `file:./tr33-docs.db` you need a bundling step that pushes to Turso before deploy, or re-index in a post-deploy seed job.
- At runtime on Vercel, there's no checkout. `resolvedLocalPath` is undefined (PROD guard), GitHub remote is selected unless you forced local. Cold-cache on a non-built Turso fails fast with a clear message: tells you to re-run `next build` with the checkout (and that Turso is `libsql://` configured). No cryptic `Missing schema`.

### Env contract (Vercel)

```
TR33_GITHUB_ORG=jeffsee55
TR33_GITHUB_REPO=tr33
TR33_DOCS_REF=main            # or ${VERCEL_GIT_COMMIT_SHA} on Vercel to pin SHA
TR33_DOCS_DATABASE_URL=libsql://...  # or file:./tr33-docs.db for preview
TR33_DOCS_DATABASE_AUTH_TOKEN=...    # Turso token

# GitHub App (for writes/edits/live branches against this repo)
GITHUB_APP_ID=
GITHUB_PRIVATE_KEY=          # multiline — use \n escape or base64 decode in your runner if needed
GITHUB_APP_INSTALLATION_ID=  # optional optimization
GITHUB_APP_SLUG=             # install-link UI exposure (public bit)
GITHUB_APP_NAME=Tr33

# Optional overrides (dev)
TR33_DOCS_SOURCE=local|github
TR33_DOCS_REPO_PATH=/abs/to/repo
```

Why `TR33_DOCS_REF` over `GIT_SHA`? One indirection lets you use `VERCEL_GIT_COMMIT_SHA` (Vercel automatically sets this) without coupling tr33 to Vercel. Fallback order: `TR33_DOCS_REF` → `VERCEL_GIT_COMMIT_SHA` → `config.ref`.

## Route factory recap

```ts
// app/api/[...path]/route.ts
import { createTr33Route } from "wildwood"nextjs/route";
import { wildwood } from "@/lib/wildwood";

export const { GET, POST, HEAD, OPTIONS, PUT, PATCH, DELETE } = createTr33Route(
  () => tr33,
  { revalidateTagName: "docs-content" },
);
```

The factory owns branch cookie + `revalidateTag`. The underlying H3 `handle(tr33)` owns `/git/*`, `/tr33/draft`, `/tr33/preview`, `/vscode/*`, `/github/*`. No `next/*` inside handler — just `cookies()` via route factory outer layer.

## Toolbar wiring

```tsx
import { Toolbar } from "wildwood"nextjs/kit";
import { wildwood } from "@/lib/wildwood";

export function Layout({ children }) {
  return <html><body>{children}<Toolbar tr33={tr33} apiBase="/api" /></body></html>;
}
```

`Toolbar` is self-sufficient — no manual branch cookie resolution needed in the host. For SSG safety it's a Server Component that delegates to `ClientKitBoundary` dynamically (`ssr:false`) for shadow DOM / portal bits.

Theme: Kit follows system (`theme="system"` default). Remove explicit `theme="light"` to respect `prefers-color-scheme`. `ThemeProvider` listener syncs `dark` class, `colorScheme`, `data-kit-theme`. `layout.tsx` adds `suppressHydrationWarning` to avoid flash when CSP driven by media queries.

## GitHub App manifest

To install tr33's GitHub App into a target repo for the editor's remote:

```tsx
// app/github-app-manifest/page.tsx (Playground pattern)
import { createGitHubAppManifestConversionRoute, githubAppManifestConversionCommand, GitHubAppManifestCallback } from "wildwood"nextjs/github-app-manifest";

export async function GET(req: Request) {
  // Handles conversion (manifest callback) → stored secrets
}
```

`GITHUB_APP_SLUG` feeds into editor-guards `installUrl: https://github.com/apps/${appSlug}/installations/new`. `not_configured` response when App credentials absent (`getRepoInstallationStatus()` in `NativeRemote`? Skipped — so dev doesn't require App).

## Caching model

- Query caching via Next's `"use cache"` + `cacheTag(TR33_CACHE_TAG)` utilities (`cacheLife("hours")` typical). Enumerate in components, tag any function that reads `tr33.docs.findMany`.
- `tr33/nextjs/branch` exports `TR33_CACHE_TAG = "tr33"` (`cacheTag` name). `createTr33Route`'s mutation branch triggers `revalidateTag(tag, store)` for `commit | discard | merge | pull | create-branch | switch-branch` mutations (configurable via `mutationRe`).
- Draft/preview bypasses cache per-user via `__prerender_bypass`; no global purge on enter/exit (would invalidate production cache for all visitors). Only real mutations purge.
- `TR33_DOCS_DATABASE_URL` driver is LibSQL which you can deploy at edge (Turso) — `createClient` accepts any `@libsql/client` (Node) or web `createClient` if you re-build for edge.

## Diagnostics

- `TR33_GIT_API_LOG=0` to silence `[tr33:git-api]` logging.
- `[tr33:git-add]` and `[tr33:patch-worktree]` logs include ms timings for each phase (prep, blob/storage, tree application, persist, index).
- `gitAddTimer`, `blobStore`, `trees.applyEntriesToTree`, `ensureTrees`, `indexChangedFiles` available via hooks for custom telemetry (internal).

## Verifying deployment

```sh
# Local: simulate production DB-only reader (no local checkout)
TR33_DOCS_SOURCE=github TR33_DOCS_DATABASE_URL=file:./tr33-docs.db pnpm --filter docs next build

# Production: stage + cutover SHA pointer
# 1. Build (populates Turso when URL points there)
VERCEL_GIT_COMMIT_SHA=$NEW_SHA pnpm --filter docs build
# 2. Set runtime env
# TR33_DOCS_REF=$NEW_SHA (or rely on VERCEL_GIT_COMMIT_SHA)
# TR33_DOCS_DATABASE_URL, AUTH_TOKEN
# 3. Deploy
```

When `findMany` sans checkout in production issues "Tr33 index missing for ref X", it includes version + whether `TR33_DOCS_DATABASE_URL` / `LIBSQL_URL` / `TURSO_DATABASE_URL` presence hint, so you know instantly you missed the DB seed or the version bump.

Next: [Guides](./guides.md) — the full patterns used in this repo.
