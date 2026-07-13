---
title: Configuration
author: ../authors/jeff.md
description: "defineConfig, remotes, database, auth, and resolution across environments."
---

# Configuration

Wildwood's runtime is driven by a single `defineConfig` call plus a database and optional provider/auth.

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
| `org` | explicit `org` → `VERCEL_GIT_REPO_OWNER` (system) → git `remote.origin` owner (dev only) |
| `repo`| explicit `repo` → `VERCEL_GIT_REPO_SLUG` (system) → git `remote.origin` repo |
| `ref` | explicit `ref` → `VERCEL_GIT_COMMIT_REF` (branch) → `VERCEL_GIT_COMMIT_SHA` (immutable) → `"main"` |
| `origin`| explicit `origin` → `VERCEL_PROJECT_PRODUCTION_URL` → `VERCEL_BRANCH_URL` → `VERCEL_URL` |

That means `defineConfig({ collections })` alone is sufficient on Vercel after you enable System Environment Variables — no custom env wiring.

For auth, `baseURL` / `trustedOrigins` are optional and autodetected from the incoming `Request` by better-auth. DB is NOT configured in the route — it's reused from `createClient({ database })`. GitHub sign-in is `github: true | { clientId, clientSecret }`.

- `version` — string that namespaces the derived index in LibSQL. When you add a `z.filter`, change a `z.connect`, or otherwise alter indexed shape, bump `version` so wildwood re-indexes instead of serving a stale index.
- `localPath` — absolute path to a Git checkout. When set, wildwood uses a native Git remote (reads `.git` directly). When omitted, Wildwood auto-detects by walking up from `cwd` to `.git` in dev/build; in production it falls back to GitHub remote (or DB-only when no token is set).
- `collections` — `Record<string, { name, match, schema, basePath? }>`. Keys are arbitrary but typically match `name`. The config stores them normalized; the typed client maps `name` back as the property (`wildwood.docs`).
- `variants` — optional variant axes (locale, version etc). See [Variants](./variants.md).

## Identity resolution (no env required on Vercel)

`defineConfig` resolution via `packages/wildwood/src/env.ts` is explicit — no `WILDWOOD_GITHUB_*` cascade:

- Explicit args win.
- Otherwise Vercel System Envs — `VERCEL_GIT_REPO_OWNER`, `VERCEL_GIT_REPO_SLUG`, `VERCEL_GIT_COMMIT_REF` / `VERCEL_GIT_COMMIT_SHA`, `VERCEL_PROJECT_PRODUCTION_URL` / `VERCEL_BRANCH_URL` / `VERCEL_URL`.
- Otherwise local git `remote.origin` parsing in dev (no `gh` needed).

## Local path resolution

Resolution order for `resolvedLocalPath`:

1. Explicit `localPath` from `defineConfig`.
2. `WILDWOOD_LOCAL_PATH` env override (for monorepo / CI).
3. Auto-detection: walk up from `process.cwd()` up to 12 directories looking for `.git`.
4. In production, auto-detection disabled unless `WILDWOOD_SOURCE=local` forces it.
5. If nothing found — undefined → "use GitHub remote."

## Database

`createClient` requires a LibSQL client. This is the ONLY place DB URL is configured — auth reuses it.

```ts
import { createClient as libsql } from "@libsql/client";
import { createClient, defineConfig } from "wildwood";

const config = defineConfig({ collections, version: "1" });

// Host maps env explicitly — Turso integration is canonical on Vercel
const database = libsql({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

export const wildwood = createClient({
  config,
  database,
  provider: { github: { type: "app", app: { appId, privateKey } } },
});
```

Build indexes locally then syncs Turso for prod. `VERCEL_GIT_COMMIT_SHA` pins queries.

## Auth — `authenticate` vs `authorize`, providers, and zero-duplication

Wildwood's Next.js route owns better-auth. No `database` field — auth tables live in the same Turso DB as content.

```ts
// lib/wildwood.ts — git creds (single source of truth for App auth)
export const wildwood = createClient({
  config,
  database, // Turso
  provider: { // preferred name; `auth` still works as alias
    github: { type: "app", app: { appId: process.env.GITHUB_APP_ID!, privateKey: process.env.GITHUB_PRIVATE_KEY! } },
    authorize: () => true,
  },
});

// app/api/[...path]/route.ts — sign-in, reuses same App
export const { GET, POST, ... } = createWildwoodRoute(() => wildwood, {
  auth: {
    secret: process.env.BETTER_AUTH_SECRET!,
    github: true, // ← true = enable GitHub OAuth, reuse App's GITHUB_CLIENT_ID/SECRET
    // or explicit if sign-in creds differ: github: { clientId, clientSecret }

    authenticate: async ({ user }) => allowList.has(user.email?.toLowerCase() ?? ""),
    authorize: async ({ user, action }) => !!user,
  },
});
```

- `github: boolean | { clientId, clientSecret }` — `true` enables OAuth and reuses the App creds already configured for git (via `provider.github` / manifest conversion). No separate `WILDWOOD_GITHUB_*` or `GITHUB_TOKEN` needed in userland.
- Future: `providers: { gitlab: true }`, `google`, etc — `auth` → `provider` rename in `createClient` is forward-compatible; `auth` remains as deprecated alias for one minor.
- `baseURL` / `trustedOrigins` omitted → autodetected from Request (works for localhost, `*.vercel.app`, custom domains).
- `authenticate` = who may create a session? (sign-in gate) vs `authorize` = what may they do? (action gate). `authenticate` replaces `allowedEmails`.

For client layer (`createClient({ provider })`), `provider.github` = GitHub App / PAT for remote, `provider.authorize` gates git actions.

## Env overview

### Canonical env set — only these should exist (per your cleanup)

When Vercel Turso + GitHub App manifest are configured:

```
# From Turso marketplace — auto-injected, canonical DB source:
TURSO_DATABASE_URL=
TURSO_AUTH_TOKEN=

# From GitHub App manifest conversion — single App gives both git + OAuth:
GITHUB_APP_ID=
GITHUB_PRIVATE_KEY=
GITHUB_CLIENT_ID=            # OAuth pair from same App — used when route has `github: true`
GITHUB_CLIENT_SECRET=
GITHUB_APP_SLUG=              # public install prompt
GITHUB_APP_INSTALLATION_ID=   # optional optimization

# Your own secret for better-auth cookie signing:
BETTER_AUTH_SECRET=           # openssl rand -base64 32

# Who may sign in — parsed in YOUR `authenticate`, not by wildwood:
ALLOWED_EMAILS=you@example.com,other@example.com
```

What was removed:

- `WILDWOOD_GITHUB_ORG` / `WILDWOOD_GITHUB_REPO` / `WILDWOOD_DOCS_*` — use `defineConfig({ org, repo })` or Vercel System Envs.
- `WILDWOOD_DOCS_DATABASE_URL` / `LIBSQL_URL` fallback cascade — host maps `TURSO_DATABASE_URL` once in `lib/wildwood.ts`.
- `GITHUB_TOKEN` env fallback inside wildwood — pass explicitly via `provider: { github: { type: "token", token } }` if needed; dev `gh auth login` still works for zero-config local.
- `database:` inside `createWildwoodRoute({ auth })` — reused from client.
