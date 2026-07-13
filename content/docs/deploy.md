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

Wildwood's docs app now reads those directly — no renaming required. Host maps env → explicit options, no fallbacks inside wildwood:

```ts
// lib/wildwood.ts — explicit mapping, no WILDWOOD_* fallback cascade
const database = libsql({
  url: process.env.TURSO_DATABASE_URL?.trim() || "file:./wildwood-docs.db",
  authToken: process.env.TURSO_AUTH_TOKEN?.trim() || "",
});
```

For auth route, DB is reused from `wildwood` client — no `database:` field. GitHub sign-in reuses same App:

```ts
// lib/wildwood.ts — git writes (App creds)
export const wildwood = createClient({
  config, database, // Turso from integration
  provider: { github: { type: "app", app: { appId: process.env.GITHUB_APP_ID!, privateKey: process.env.GITHUB_PRIVATE_KEY! } } },
});

// app/api/[...path]/route.ts — sign-in reuses same App
createWildwoodRoute(() => wildwood, {
  auth: {
    secret: process.env.BETTER_AUTH_SECRET,
    github: true, // reuses GITHUB_CLIENT_ID/SECRET from same App
    authenticate: async ({ user }) => ["you@example.com"].includes(user.email?.toLowerCase() ?? ""),
  },
});
```

No `WILDWOOD_DOCS_DATABASE_URL` / `LIBSQL_URL` / `WILDWOOD_GITHUB_*` fallback cascade, no `database:` in auth config, no `GITHUB_TOKEN` fallback inside core. Host maps `TURSO_*` + `GITHUB_*` once in `lib/wildwood.ts` / App manifest conversion.

## 3 — Zero-config identity (no WILDWOOD_* needed on Vercel)

When you enable System Environment Variables (Settings → Environment Variables → **Enable access to System Environment Variables**), Wildwood needs no custom env for `org`/`repo`/`ref`/`origin`:

- `org` ← `VERCEL_GIT_REPO_OWNER` (e.g. `jeffsee55`)
- `repo` ← `VERCEL_GIT_REPO_SLUG` (e.g. `wildwood`)
- `ref` ← `VERCEL_GIT_COMMIT_REF` (branch) → `VERCEL_GIT_COMMIT_SHA` (SHA fallback)
- `origin` ← `VERCEL_PROJECT_PRODUCTION_URL` → `VERCEL_BRANCH_URL` → `VERCEL_URL`

In local dev, `org`/`repo` from `git remote.origin` (no `gh` CLI), `ref` defaults to `main`.

Auth origin is separate: `baseURL` / `trustedOrigins` on `createWildwoodRoute({ auth })` are optional and autodetected from the incoming `Request` (`x-forwarded-host`/`proto` + `origin`). Works for localhost, `*.vercel.app` previews, custom domains — no `NEXT_PUBLIC_ORIGIN` / `BETTER_AUTH_TRUSTED_ORIGINS` env needed. Only set explicitly if you need a fixed canonical origin or cross-domain `trustedOrigins` — map that in userland:

```ts
trustedOrigins: (req) => [new URL(req!.url).origin, "https://studio.myapp.com"]
// or dynamic baseURL:
// baseURL: { allowedHosts: ["myapp.com","*.vercel.app"], fallback: "https://myapp.com" }
```

That means this is the whole config for most apps:

```ts
import { createClient as libsql } from "@libsql/client";
import { createClient, defineConfig, z } from "wildwood";

export const collections = { ... };

const config = defineConfig({
  // org/repo/ref/origin omitted — auto-resolved from explicit > VERCEL_GIT_* > git remote > defaults
  // No WILDWOOD_GITHUB_ORG / WILDWOOD_GITHUB_REPO fallback cascade.
  version: "docs-1",
  collections,
});

const database = libsql({
  url: process.env.TURSO_DATABASE_URL || "file:./wildwood.db",
  authToken: process.env.TURSO_AUTH_TOKEN,
});

export const wildwood = createClient({ config, database });
```

If you need to override (monorepo sharing a repo, self-host), pass explicitly in `defineConfig({ org, repo, ref, origin })` — don't rely on `WILDWOOD_*` env fallbacks inside wildwood anymore. For auth, overrides are explicit `baseURL` / `trustedOrigins` on `createWildwoodRoute({ auth })` or `authenticate` / `authorize` callbacks.

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

If you deployed without Turso set at build time (e.g., `file:./wildwood-docs.db`), the build indexes locally then discards the file on runtime — you'll see "Wildwood index missing for ref …" at query time. Fix: set `TURSO_*` and redeploy — no `WILDWOOD_DOCS_DATABASE_URL` fallback inside wildwood anymore, host maps env explicitly.

## 5 — Set up the GitHub App from the live site (no env paste pre-needed)

Once deployed, the toolbar self-reports unconfigured state so you can create the app in one click:

1. Open your deployed URL → FAB (bottom right, shows `main` or active ref).
2. You'll see a highlighted **Set up GitHub App** entry (shown only when no `GITHUB_APP_*` present). Click it → **Create GitHub App** form → Submit.
3. GitHub shows its review UI (manifest = `contents:write`, `pull_requests:write`, `metadata:read`, no webhook — so no long-lived URL to worry about). Confirm creation.
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

> Webhook: opt-in only. By default the manifest omits `hook_attributes` and `default_events`, so no long-lived server-to-server URL is stored in GitHub and no permanent Vercel bypass secret is needed. This lets you create the App from any deployment including protected previews — `redirect_url` is transient (single-use, 1h). Add a webhook later by re-saving the App settings in GitHub with `https://<prod>/api/wildwood/github/webhook` when you wire event handling.

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
TURSO_DATABASE_URL=[redacted]
TURSO_AUTH_TOKEN=[redacted]

# ── GitHub App — single App = OAuth + git writes ──
GITHUB_APP_ID=
GITHUB_PRIVATE_KEY=
GITHUB_APP_INSTALLATION_ID=   # optional perf
GITHUB_CLIENT_ID=             # same App's OAuth id
GITHUB_CLIENT_SECRET=
GITHUB_APP_SLUG=              # public install-link UI only
GITHUB_APP_NAME=Wildwood

# ── Auth — mapped in userland, not inside wildwood ──
BETTER_AUTH_SECRET=…          # openssl rand -base64 32
ALLOWED_EMAILS=you@example.com,other@example.com   # parsed in authenticate callback

# Optional only if you need fixed origin / cross-domain (otherwise autodetected from Request):
# BETTER_AUTH_URL=https://myapp.com
# In code:
#   baseURL: { allowedHosts: ["myapp.com","*.vercel.app"], fallback: "https://myapp.com" }
#   trustedOrigins: (req) => [new URL(req!.url).origin, "https://studio.myapp.com"]

# ── Dev / overrides — explicit only, no WILDWOOD_* fallback cascade ──
WILDWOOD_DOCS_SOURCE=local|github
WILDWOOD_DOCS_REPO_PATH=/abs/to/repo
# org/repo/ref overrides now explicit in code, not env:
#   defineConfig({ org: "jeffsee55", repo: "wildwood", ref: "main", origin: "https://…", ... })
```

Minimal viable prod: System Envs + `vercel integration add tursocloud/database`. Read-only works with no custom env. Editor = GitHub App 5-var set (`GITHUB_APP_ID`, `PRIVATE_KEY`, `CLIENT_ID`, `CLIENT_SECRET`, `APP_SLUG`). Auth = `BETTER_AUTH_SECRET` + `authenticate` callback; `baseURL`/`trustedOrigins` omitted → autodetected from Request, no `NEXT_PUBLIC_ORIGIN` / `BETTER_AUTH_TRUSTED_ORIGINS` needed.


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
# "Wildwood index missing for ref <sha> version=docs-1 — did you forget to set TURSO at build time?"
# → you built with file:./wildwood-docs.db without Turso env. Set TURSO_* then rebuild.
```

Next: [Guides](./guides.md) — full patterns used in this repo, VS Code web embedding, auth extensions.
