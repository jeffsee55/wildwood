---
title: Configuration
author: ../authors/jeff.md
description: defineConfig, remotes, database, auth, and how resolution works across environments.
---

# Configuration

tr33's runtime is driven by a single `defineConfig` call plus a database and optional auth.

## defineConfig

```ts
import { defineConfig, z } from "tr33";

const config = defineConfig({
  org: "jeffsee55",           // GitHub owner
  repo: "tr33",               // repository name
  ref: "main",                // default branch
  version: "1",               // bump when filter/connection shape changes
  localPath: "/abs/to/repo",  // optional — explicit local checkout path
  collections: { authors, docs, nav },
  variants: { locale: { options: ["en", "fr"], default: "en" } }, // optional
});
```

- `org`, `repo`, `ref` — identify the GitHub repo and default ref. Used by GitHub remote, branch listing, and commit API.
- `version` — string that namespaces the derived index in LibSQL. When you add a `z.filter`, change a `z.connect`, or otherwise alter indexed shape, bump `version` so tr33 re-indexes instead of serving a stale index.
- `localPath` — absolute path to a Git checkout. When set, tr33 uses a native Git remote (reads `.git` directly). When omitted, tr33 auto-detects by walking up from `cwd` to `.git` in dev/build; in production it falls back to GitHub remote.
- `collections` — `Record<string, { name, match, schema, basePath? }>`. Keys are arbitrary but typically match `name`. The config stores them normalized; the typed client maps `name` back as the property (`tr33.docs`).
- `variants` — optional variant axes (locale, version etc). See [Variants](./variants.md).

## Local path resolution

Resolution order for `resolvedLocalPath` (the property the remote chooses, not the raw `localPath`):

1. Explicit `localPath` from `defineConfig`.
2. `TR33_DOCS_REPO_PATH` or `TR33_PLAYGROUND_LOCAL_ROOT` env (override for `apps/docs` or `apps/play`).
3. Auto-detection: walk up from `process.cwd()` up to 12 directories looking for `.git`.
4. In production (`NODE_ENV=production`, not `phase-production-build`), auto-detection is disabled unless `TR33_DOCS_SOURCE=local` forces it.
5. If nothing found — undefined, which means "use GitHub remote."

## Database

`createClient` requires a LibSQL client:

```ts
import { createClient as libsql } from "@libsql/client";
import { createClient } from "tr33";

const database = libsql({
  url: process.env.TR33_DATABASE_URL || "file:./tr33.db",
  authToken: process.env.TR33_DATABASE_AUTH_TOKEN || "",
});

const tr33 = createClient({ config, database, auth });
```

During `next build` (which has the checkout), `findMany` / `findFirst` cold-cache into `LibsqlDatabase` via `git.switch` → `writeEntries` (tree traversal → blob parse → `config.index` into `filters` / `entries` / `connections` tables). That DB can then be copied to Turso (`process.env.TR33_DOCS_DATABASE_URL`) for production. When Vercel builds with `VERCEL_GIT_COMMIT_SHA`, `TR33_DOCS_REF` is set to that SHA so queries are pinned.

## Auth

Auth is optional. Pass `auth` to `createClient` when you need it:

```ts
import type { Tr33AuthConfig } from "tr33";

const auth: Tr33AuthConfig = {
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
  // getUser?: (req) => Promise<Tr33AuthUser | null>,
  // authorize?: (ctx) => boolean | void | Response | Promise<...>
};

const tr33 = createClient({ config, database, auth });
```

- `github.type = "app"` — installation token flow for reads and writes against the GitHub API.
- `github.type = "token"` / `"default"` — PAT or unauthenticated fallthrough (legacy / tokens).
- `betterAuth` / `getUser` — resolve the request actor (`Tr33AuthUser`). `getUser` takes precedence over `betterAuth`.
- `authorize(ctx)` — gate for git actions. Context has `action` (discriminated: `git.commit`, `git.push`, `git.createBranch` …), `config`, `request`, and `user`. Return `false` to deny, a `Response` to customize denial, or `true`/void to allow. The H3 route layer (`git-service` router) calls this via `authorizeGitAction`.

For docs app hosting, the public env slugs are `GITHUB_APP_SLUG` / `GITHUB_APP_NAME` (UI install links only, never for signing). Private signing material stays in `GITHUB_APP_ID` / `GITHUB_PRIVATE_KEY`.

## Env contract (this repo's docs app)

```
TR33_GITHUB_ORG=jeffsee55
TR33_GITHUB_REPO=tr33
TR33_DOCS_REF=main           # or VERCEL_GIT_COMMIT_SHA
TR33_DOCS_DATABASE_URL=      # libsql://.. for Turso, or file:./tr33.db
TR33_DOCS_DATABASE_AUTH_TOKEN=

# GitHub App (required for live edits against this repo)
GITHUB_APP_ID=
GITHUB_PRIVATE_KEY=
GITHUB_APP_INSTALLATION_ID=  # optional
GITHUB_APP_SLUG=             # install prompt UI
GITHUB_APP_NAME=Tr33

# Force selection (dev only)
TR33_DOCS_SOURCE=local|github     # override auto-detection
```

Next: [Schemas](./schemas.md) for the full collection/schema surface, then [Querying](./querying.md).
