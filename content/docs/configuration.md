---
title: Configuration
author: ../authors/jeff.md
description: "defineConfig, remotes, database, auth, and resolution across environments."
---

# Configuration

Wildwood's runtime is driven by a single `defineConfig` call plus a database and optional auth.

## defineConfig — zero-config on Vercel

```ts
import { defineConfig, z } from "wildwood";

// Minimal — works on Vercel with System Env enabled, and locally via git remote:
const config = defineConfig({
  collections: { authors, docs, nav },
  version: "1",
});

// Explicit when you want:
const config = defineConfig({
  org: "jeffsee55",           // override: explicit wins over env
  repo: "wildwood",
  ref: "main",
  origin: "https://wildwood.dev", // optional; auto from Vercel production URL
  version: "1",
  localPath: "/abs/to/repo",  // optional — explicit local checkout path
  collections: { authors, docs, nav },
  variants: { locale: { options: ["en", "fr"], default: "en" } },
});
```

Resolution order — no `WILDWOOD_*` env required on Vercel when System Envs are enabled (Settings → Environment Variables → "Enable access to System Environment Variables"):

| Field | Priority (first wins) |
|-------|-----------------------|
| `org` | explicit `org` → `WILDWOOD_GITHUB_ORG` / `WILDWOOD_ORG` / `GITHUB_ORG` → `VERCEL_GIT_REPO_OWNER` (system) → git `remote.origin` owner (dev only) |
| `repo`| explicit `repo` → `WILDWOOD_GITHUB_REPO` / `WILDWOOD_REPO` → `VERCEL_GIT_REPO_SLUG` (system) → git `remote.origin` repo |
| `ref` | explicit `ref` → `WILDWOOD_DOCS_REF` / `WILDWOOD_REF` → `VERCEL_GIT_COMMIT_REF` (branch, e.g. `main`) → `VERCEL_GIT_COMMIT_SHA` (SHA for immutable deploys) → `"main"` |
| `origin`| explicit `origin` → `NEXT_PUBLIC_ORIGIN` / `ORIGIN` / `NEXT_PUBLIC_SITE_URL` → `VERCEL_PROJECT_PRODUCTION_URL` → `VERCEL_BRANCH_URL` → `VERCEL_URL` |

That means `defineConfig({ collections })` alone is sufficient on Vercel after you enable System Environment Variables — no custom env wiring. `WILDWOOD_*` overrides still work when you need them (self-hosted, monorepo overrides), but they are no longer required.

- `version` — string that namespaces the derived index in LibSQL. When you add a `z.filter`, change a `z.connect`, or otherwise alter indexed shape, bump `version` so wildwood re-indexes instead of serving a stale index.
- `localPath` — absolute path to a Git checkout. When set, wildwood uses a native Git remote (reads `.git` directly). When omitted, Wildwood auto-detects by walking up from `cwd` to `.git` in dev/build; in production it falls back to GitHub remote (or DB-only when no token is set).
- `collections` — `Record<string, { name, match, schema, basePath? }>`. Keys are arbitrary but typically match `name`. The config stores them normalized; the typed client maps `name` back as the property (`wildwood.docs`).
- `variants` — optional variant axes (locale, version etc). See [Variants](./variants.md).

## Identity resolution (no env required on Vercel)

`defineConfig` now lives in `packages/wildwood/src/env.ts`. All resolution is in one place:

- Explicit args win.
- Otherwise `WILDWOOD_*` overrides (back-compat, self-host).
- Otherwise Vercel System Envs — `VERCEL_GIT_REPO_OWNER`, `VERCEL_GIT_REPO_SLUG`, `VERCEL_GIT_COMMIT_REF` / `VERCEL_GIT_COMMIT_SHA`, `VERCEL_PROJECT_PRODUCTION_URL` / `VERCEL_BRANCH_URL` / `VERCEL_URL`.
- Otherwise local git `remote.origin` parsing in dev (no `gh` needed).
- `WILDWOOD_INFER_GIT_REMOTE=1` allows git remote parsing in production when you deploy outside Vercel without env.

If org/repo still cannot be resolved after all fallbacks, `defineConfig` throws a helpful error that mentions enabling System Environment Variables in Vercel and the received values.

## Local path resolution

Resolution order for `resolvedLocalPath` (the property the remote chooses, not the raw `localPath`):

1. Explicit `localPath` from `defineConfig`.
2. `WILDWOOD_DOCS_REPO_PATH` or `WILDWOOD_PLAYGROUND_LOCAL_ROOT` env (override for `apps/docs` or `apps/play`).
3. Auto-detection: walk up from `process.cwd()` up to 12 directories looking for `.git`.
4. In production (`NODE_ENV=production`, not `phase-production-build`), auto-detection is disabled unless `WILDWOOD_DOCS_SOURCE=local` forces it.
5. If nothing found — undefined, which means "use GitHub remote."

## Database

`createClient` requires a LibSQL client:

```ts
import { createClient as libsql } from "@libsql/client";
import { createClient } from "wildwood";

const database = libsql({
  url: process.env.WILDWOOD_DATABASE_URL || "file:./wildwood.db",
  authToken: process.env.WILDWOOD_DATABASE_AUTH_TOKEN || "",
});

const wildwood = createClient({ config, database, auth });
```

During `next build` (which has the checkout), `findMany` / `findFirst` cold-cache into `LibsqlDatabase` via `git.switch` → `writeEntries` (tree traversal → blob parse → `config.index` into `filters` / `entries` / `connections` tables). That DB can then be copied to Turso (`process.env.WILDWOOD_DOCS_DATABASE_URL`) for production. When Vercel builds with `VERCEL_GIT_COMMIT_SHA`, `WILDWOOD_DOCS_REF` is set to that SHA so queries are pinned.

## Auth

Auth is optional. Pass `auth` to `createClient` when you need it:

```ts
import type { WildwoodAuthConfig } from "wildwood";

const auth: WildwoodAuthConfig = {
  github: {
    type: "app",
    app: {
      appId: process.env.GITHUB_APP_ID!,
      privateKey: process.env.GITHUB_PRIVATE_KEY!,
      installationId: process.env.GITHUB_APP_INSTALLATION_ID, // optional optimization
    },
  },
  // Optional: better-auth passthrough or custom getUser
  betterAuth: authInstance, // Tr33BetterAuthLike
  // getUser?: (req) => Promise<WildwoodAuthUser | null>,
  // authorize?: (ctx) => boolean | void | Response | Promise<...>
};

const wildwood = createClient({ config, database, auth });
```

- `github.type = "app"` — installation token flow for reads and writes against the GitHub API.
- `github.type = "token"` / `"default"` — PAT or unauthenticated fallthrough (legacy / tokens).
- `betterAuth` / `getUser` — resolve the request actor (`WildwoodAuthUser`). `getUser` takes precedence over `betterAuth`.
- `authorize(ctx)` — gate for git actions. Context has `action` (discriminated: `git.commit`, `git.push`, `git.createBranch` …), `config`, `request`, and `user`. Return `false` to deny, a `Response` to customize denial, or `true`/void to allow. The H3 route layer (`git-service` router) calls this via `authorizeGitAction`.

For docs app hosting, the public env slugs are `GITHUB_APP_SLUG` / `GITHUB_APP_NAME` (UI install links only, never for signing). Private signing material stays in `GITHUB_APP_ID` / `GITHUB_PRIVATE_KEY`.

## Env overview

### Required — none on Vercel with System Envs

When `VERCEL=true` (System Environment Variables enabled), `defineConfig({ collections })` auto-detects:

- `org` from `VERCEL_GIT_REPO_OWNER`
- `repo` from `VERCEL_GIT_REPO_SLUG`
- `ref` from `VERCEL_GIT_COMMIT_REF` → `VERCEL_GIT_COMMIT_SHA`
- `origin` from `VERCEL_PROJECT_PRODUCTION_URL` → `VERCEL_BRANCH_URL` → `VERCEL_URL`

In local dev, `org`/`repo` are auto-detected from `git remote.origin` (no `gh` CLI), and `ref` defaults to `main`.

### Optional — overrides and self-host

```
# Overrides (highest priority when set) — back-compat, self-host, monorepo:
WILDWOOD_GITHUB_ORG=jeffsee55        # or WILDWOOD_ORG / GITHUB_ORG
WILDWOOD_GITHUB_REPO=wildwood         # or WILDWOOD_REPO / GITHUB_REPO
WILDWOOD_DOCS_REF=main                # or WILDWOOD_REF / WILDWOOD_BRANCH
WILDWOOD_VERSION=1
WILDWOOD_INFER_GIT_REMOTE=1           # allow git remote parsing in prod (non-Vercel)

# Origin (for absolute URLs, manifests, OG images):
NEXT_PUBLIC_ORIGIN=https://wildwood.dev
# or ORIGIN / NEXT_PUBLIC_SITE_URL / SITE_URL / Vercel auto URLs

# Database — Turso via marketplace (preferred) or libsql://
# No env needed for local file DB in dev:
WILDWOOD_DOCS_DATABASE_URL=           # libsql://.. for Turso, or file:./wildwood.db
WILDWOOD_DOCS_DATABASE_AUTH_TOKEN=
TURSO_DATABASE_URL=                   # auto-injected by `vercel integration add tursocloud/database`
TURSO_AUTH_TOKEN=

# GitHub App (required only for live edits via toolbar)
GITHUB_APP_ID=
GITHUB_PRIVATE_KEY=
GITHUB_APP_INSTALLATION_ID=  # optional optimization
GITHUB_APP_SLUG=             # public install prompt UI (safe to expose)
GITHUB_APP_NAME=Wildwood

# Dev engine selection:
WILDWOOD_DOCS_SOURCE=local|github     # override auto-detection
```

### What this repo's docs app actually needs

- Local dev: nothing — `defineConfig({ collections })` reads git remote.
- Vercel preview/prod (read-only): `TURSO_*` (auto from integration) + enable System Envs. That's it.
- Vercel with edits: add `GITHUB_APP_*` (created post-deploy from the toolbar's setup flow).

Next: [Schemas](./schemas.md) for the full collection/schema surface, then [Querying](./querying.md).
