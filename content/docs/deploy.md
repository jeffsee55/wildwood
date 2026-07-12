---
title: Deploy to Vercel
author: ../authors/jeff.md
description: "Production deploy on Vercel — Turso via marketplace, GitHub App from the toolbar, and zero-config env wiring."
---

# Deploy to Vercel

Wildwood keeps the hot path on DB reads only. The git checkout is needed at build (Vercel already has it) and on incremental writes via the GitHub App.

On Vercel you want:

- Turso for LibSQL — created through `vercel` CLI so env vars are auto-injected.
- GitHub App for edits — created from the toolbar once deployed; credentials land in Vercel env via the callback page.
- A single Next build that indexes into Turso, so runtime readers have no checkout.

This page is the canonical flow. Follow it top to bottom on a fresh clone.

## 0 — Prerequisites

```sh
# one-time
npm i -g vercel   # or pnpm add -g vercel — brew install vercel also works
vercel login       # scope = your Vercel account/team
```

Your project already has a `vercel.json` at `apps/docs/vercel.json` for the monorepo build. You don't need to create one for a typical Wildwood app; the default Next.js framework detection is enough. The only reason we use one in this repo is the `cd ../.. && pnpm install` + `turbo --filter=docs` dance.

## 1 — Link & create the Vercel project

From the repo root, or from your app directory if you're not monorepo:

```sh
# from repo root for this docs app, or from your Next app directory normally:
vercel link
# → Set up and deploy? N (link only)
# → Which scope? <your team>
# → Link to existing project? N → Project name: wildwood-docs (or your name)
# or if you already pushed to GitHub:
# vercel --yes   (creates + deploys preview)
```

`vercel link` writes `.vercel/project.json`. Commit check: `.vercel` is gitignored — that's fine, it's local only.

## 2 — Add Turso — the right way (marketplace)

Don't create Turso manually in the dashboard and paste URLs. Use the marketplace so Vercel injects and rotates `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` for you across production, preview, and development.

```sh
# from the same directory you linked:
vercel integration add tursocloud/database
# → region? pick closest to your Vercel function region, e.g. iad1
# → plan? starter (free) is fine for docs
# → connect to current project? Y
# → environments? production, preview, development (default all — keep it)
```

What this does:

- Provisions a Turso database and adds it as a Vercel integration resource.
- Attaches `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` to your project (Build + Runtime vars).
- Offers `vercel env pull` so you can run locally against the same remote.

Verify:

```sh
vercel env ls | grep -i turso
# TURSO_DATABASE_URL   Production Preview Development   Added by integration
# TURSO_AUTH_TOKEN     Production Preview Development   Added by integration  (encrypted)

# optional — pull locally to test against Turso in dev:
vercel env pull .env.development.local
```

Wildwood's docs app now reads those directly — no renaming required:

```ts
// lib/wildwood.ts — resilient resolver, new in this guide
function resolveDatabaseUrl() {
  return (
    process.env.WILDWOOD_DOCS_DATABASE_URL?.trim() ||
    process.env.TURSO_DATABASE_URL?.trim() ||      // ← integration default
    process.env.LIBSQL_URL?.trim() ||
    "file:./wildwood-docs.db"
  );
}
function resolveAuthToken() {
  return (
    process.env.WILDWOOD_DOCS_DATABASE_AUTH_TOKEN?.trim() ||
    process.env.TURSO_AUTH_TOKEN?.trim() ||
    process.env.LIBSQL_AUTH_TOKEN?.trim() ||
    ""
  );
}
```

Keep `WILDWOOD_DOCS_DATABASE_URL` supported for backwards compat and for non-marketplace setups (e.g., self-hosted Turso). Recommended for new Vercel projects is just `TURSO_*` — no custom env needed.

> Tip: `vercel integration add` also accepts `--prefix` if you want `WILDWOOD_TURSO_DATABASE_URL` instead of bare `TURSO_DATABASE_URL`. In that case set `WILDWOOD_DOCS_DATABASE_URL` to the same value or just read your prefixed name in `resolveDatabaseUrl()`. We recommend no prefix for simplicity.

## 3 — Zero-config identity (no WILDWOOD_* needed on Vercel)

When you enable System Environment Variables in your Vercel project (Settings → Environment Variables → **Enable access to System Environment Variables**), Wildwood needs no custom env vars at all for `org`/`repo`/`ref`/`origin`:

- `org` ← `VERCEL_GIT_REPO_OWNER` (e.g. `jeffsee55`)
- `repo` ← `VERCEL_GIT_REPO_SLUG` (e.g. `wildwood`)
- `ref` ← `VERCEL_GIT_COMMIT_REF` (branch name, e.g. `main`) → `VERCEL_GIT_COMMIT_SHA` (SHA fallback for immutable deploys)
- `origin` ← `VERCEL_PROJECT_PRODUCTION_URL` → `VERCEL_BRANCH_URL` → `VERCEL_URL` (for absolute URLs, OG images, GitHub App manifest callback)

In local dev, `org`/`repo` are inferred from `git remote.origin` (no `gh` CLI needed), and `ref` defaults to `main`.

That means this is the whole config for most apps:

```ts
// lib/wildwood.ts — condensed, zero-config
import { createClient as libsql } from "@libsql/client";
import { createClient, defineConfig, z } from "wildwood";

export const collections = {
  authors: z.collection({
    name: "authors",
    match: "content/authors/**/*.md",
    schema: z.markdown({ name: z.filter(z.string()) }),
  }),
  docs: z.collection({
    name: "docs",
    match: "content/docs/**/*.md",
    schema: z.markdown({ title: z.filter(z.string()) }),
  }),
};

const config = defineConfig({
  // org/repo/ref/origin intentionally omitted — auto-resolved from:
  // explicit > WILDWOOD_* > VERCEL_GIT_* > git remote > defaults
  version: "docs-1",
  collections,
});

const database = libsql({
  // TURSO_* auto-injected by `vercel integration add tursocloud/database`
  url: process.env.TURSO_DATABASE_URL || "file:./wildwood.db",
  authToken: process.env.TURSO_AUTH_TOKEN,
});

export const wildwood = createClient({ config, database });
```

If you deploy outside Vercel or need to override (monorepo sharing a single repo, self-hosted), set `WILDWOOD_GITHUB_ORG` / `WILDWOOD_GITHUB_REPO` / `WILDWOOD_DOCS_REF` / `WILDWOOD_VERSION` — they win over system envs. To allow git-remote inference in production (e.g. Fly, self-hosted with a checkout), set `WILDWOOD_INFER_GIT_REMOTE=1`.

## 4 — Deploy — build indexes straight into Turso

Vercel's build has your git checkout. When `TURSO_DATABASE_URL` points at a real database, Wildwood's build-time prefetch writes there — there's no separate seed step.

```sh
vercel --prod
# or git push to your GitHub repo if you connected Git integration
```

What happens during `next build`:

1. `resolvedLocalPath` resolves to the working directory (exists on Vercel build host) → `NativeRemote`.
2. `findMany` in pages / layout cold-misses → `ensureRefInDb(ref)` → `git.switch(ref)` walks the tree, reads blobs matching `collections.match`, parses frontmatter, records connections, writes to the LibSQL client you passed — which is Turso because `TURSO_DATABASE_URL` is set in the build env.
3. Subsequent `generateStaticParams` / `generateMetadata` reads hit DB.
4. Build cache / static html emitted with tags ready for `revalidateTag`.

At runtime on Vercel there's no checkout — `resolvedLocalPath` is `undefined` (prod guard), so the runtime uses a read-only LibSQL client pointing at the same Turso. No filesystem needed.

If you deployed without Turso set at build time (e.g., `file:./wildwood-docs.db`), the build indexes locally then discards the file on runtime — you'll see "Wildwood index missing for ref …" at query time. Fix: set `TURSO_*` (or `WILDWOOD_DOCS_DATABASE_URL=libsql://…`) and redeploy.

## 5 — Set up the GitHub App from the live site (no env paste pre-needed)

Once deployed, the toolbar self-reports unconfigured state so you can create the app in one click:

1. Open your deployed URL → FAB (bottom right, shows `main` or active ref).
2. You'll see a highlighted **Set up GitHub App** entry (shown only when no `GITHUB_APP_*` present). Click it → **Create GitHub App** form → Submit.
3. GitHub shows its review UI (manifest = `contents:write`, `pull_requests:write`, `metadata:read`, webhook URL stable at `/api/wildwood/github/webhook`). Confirm creation.
4. GitHub redirects to `/api/wildwood/github/app-manifest/callback?code=…&state=…`.
5. The server verifies `state` cookie (mitigates CSRF), exchanges the single-use `code` via `POST https://api.github.com/app-manifests/:code/conversions`, and renders a credentials page with:
   - `.env.local` tab — copy for local dev.
   - **Vercel CLI** tab — shell lines:
     ```sh
     # already linked? just paste:
     printf '%s' '<secret>' | vercel env add GITHUB_APP_ID production --sensitive
     printf '%s' '<pem>'    | vercel env add GITHUB_PRIVATE_KEY production --sensitive
     printf '%s' '<secret>' | vercel env add GITHUB_CLIENT_ID production --sensitive
     printf '%s' '<secret>' | vercel env add GITHUB_CLIENT_SECRET production --sensitive
     printf '%s' '<slug>'   | vercel env add GITHUB_APP_SLUG production
     ```
   - Shell export tab / JSON / **Write to .env.local (dev)** button (dev only, gated by authorize).

Paste Vercel envs, then:

```sh
vercel --prod   # redeploy with new secrets in Build env too
```

The editor's `needs-install` / `needs-setup` guards now clear:

- `getRepoInstallationStatus()` confirms App installed on `ORG/REPO` (or shows Install link using `GITHUB_APP_SLUG`).
- `editor-guards` / `editor-bootstrap` return `ready` + `vscodeCommit`.

> Webhook: manifest includes `hook_attributes.url = ${origin}/api/wildwood/github/webhook` (placeholder 501 until wired). Keeping it stable in the manifest avoids recreating the App later.

## 6 — Install the App on your repo

After creating the App, you must install it on the repository Wildwood writes to. The callback page already links **Install App on a repo**. Or manually: `https://github.com/apps/<slug>/installations/new` → choose **Only select repositories** → pick your docs repo. The editor overlay itself also shows **Install on GitHub** when status is `not_installed`.

## Full env contract

```sh
# ── Vercel system envs (auto — enable "System Environment Variables") ──
# You never set these manually. Vercel populates them when System Envs are
# enabled (Settings → Environment Variables → checkbox).
VERCEL=1
VERCEL_ENV=production|preview|development
VERCEL_GIT_REPO_OWNER=jeffsee55           # → org
VERCEL_GIT_REPO_SLUG=wildwood             # → repo
VERCEL_GIT_COMMIT_REF=main                # → ref (branch, preferred)
VERCEL_GIT_COMMIT_SHA=fa1ead...           # → ref fallback (SHA, immutable)
VERCEL_PROJECT_PRODUCTION_URL=my-site.com # → origin (shortest prod domain)
VERCEL_BRANCH_URL=my-site-git-*.vercel.app# → origin fallback (preview branches)
VERCEL_URL=my-site-*.vercel.app           # → origin fallback (deployment URL)

# ── Database — Turso marketplace (preferred) ──
# Wired automatically by `vercel integration add tursocloud/database`:
TURSO_DATABASE_URL=libsql://...
TURSO_AUTH_TOKEN=...

# Optional aliases (self-host, non-marketplace):
WILDWOOD_DOCS_DATABASE_URL=
WILDWOOD_DOCS_DATABASE_AUTH_TOKEN=
LIBSQL_URL=
LIBSQL_AUTH_TOKEN=

# ── Identity overrides (optional — override Vercel system envs when needed) ──
WILDWOOD_GITHUB_ORG=jeffsee55   # or WILDWOOD_ORG / GITHUB_ORG
WILDWOOD_GITHUB_REPO=wildwood   # or WILDWOOD_REPO / GITHUB_REPO
WILDWOOD_DOCS_REF=               # or WILDWOOD_REF / WILDWOOD_BRANCH / GIT_REF
WILDWOOD_VERSION=0
WILDWOOD_INFER_GIT_REMOTE=1     # allow git remote parsing in prod (non-Vercel)

NEXT_PUBLIC_ORIGIN=https://wildwood.dev  # or ORIGIN / NEXT_PUBLIC_SITE_URL / SITE_URL

# ── GitHub App (only for toolbar edits) ──
GITHUB_APP_ID=
GITHUB_PRIVATE_KEY=
GITHUB_APP_INSTALLATION_ID=
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GITHUB_APP_SLUG=
GITHUB_APP_NAME=Wildwood

# ── Dev ──
WILDWOOD_DOCS_SOURCE=local|github
WILDWOOD_DOCS_REPO_PATH=/abs/to/repo
```

Minimal viable prod on Vercel: enable System Environment Variables in project settings, then add Turso via marketplace (`vercel integration add tursocloud/database`). That's it for read-only — org/repo/ref/origin auto-resolve from `VERCEL_GIT_*` / `VERCEL_*_URL`. Add `GITHUB_APP_*` only when enabling the editor.


## Route factory & toolbar (unchanged)

```ts
// app/api/[...path]/route.ts
import { createWildwoodRoute } from "wildwood/nextjs/route";
import { wildwood } from "@/lib/wildwood";

export const { GET, POST, HEAD, OPTIONS, PUT, PATCH, DELETE } = createWildwoodRoute(
  () => wildwood,
  { revalidateTagName: "docs-content" },
);
```

```tsx
// app/layout.tsx
import { Toolbar } from "wildwood/nextjs/kit";
import { wildwood } from "@/lib/wildwood";

export function Layout({ children }) {
  return <html><body>{children}<Toolbar wildwood={wildwood} apiBase="/api" /></body></html>;
}
```

`Toolbar` resolves branch + VS Code commit server-side, then hydrates a client boundary with shadow DOM / portals `ssr:false`. No manual `cookies()` handling in the host. Kit follows system theme by default (`prefers-color-scheme`); `layout` gets `suppressHydrationWarning` to avoid hydration mismatch from CSS media queries.

## Caching & draft model (recap)

- `findMany` calls are wrapped by Next's `"use cache"` + `cacheTag("wildwood")` from `wildwood/nextjs/branch`. `createWildwoodRoute` triggers `revalidateTag("wildwood")` only on mutations (`commit`, `discard`, `merge`, `pull`, `create-branch`, `switch-branch`).
- Draft / preview enters via `/api/wildwood/preview` bypass per-user with `__prerender_bypass`; does not globally purge prod cache.
- Turso is edge-ready — `createClient` accepts any `@libsql/client` driver (`file:`, `libsql://`, edge via `@libsql/client/web` if you rebuild for edge).

## Diagnostics

- `WILDWOOD_GIT_API_LOG=0` to silence git-api logging.
- `[wildwood:git-add]` and `[wildwood:patch-worktree]` logs include phase timings (prep, blob, tree, persist, index).
- `gitAddTimer`, `blobStore`, `trees.applyEntriesToTree`, internal — wire for telemetry as needed.

## Verifying

```sh
# Local repro of prod read path (no checkout) using pulled env:
vercel env pull .env.development.local
WILDWOOD_DOCS_SOURCE=github pnpm --filter docs next build

# If you see:
# "Wildwood index missing for ref <sha> version=docs-1 — did you forget to set TURSO/WILDWOOD_DOCS_DATABASE_URL at build time?"
# → you built with file:./wildwood-docs.db without Turso env. Set TURSO_* then rebuild.
```

Next: [Guides](./guides.md) — full patterns used in this repo, VS Code web embedding, auth extensions.
