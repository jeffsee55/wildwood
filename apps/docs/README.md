# docs app — production setup

Reference deployment for **Turso + GitHub App + Vercel, preview via branches, no separate preview infra.** Zero env fallbacks inside wildwood — host maps env → explicit options.

## How it runs

- **Build**: `.git` checkout → `NativeRemote` pre-indexes `content/` into LibSQL during `findMany`.
- **Prefetch**: `TURSO_DATABASE_URL=libsql://…` → build writes straight to Turso. `file:…` stays local.
- **Runtime**: No checkout, GitHub remote or DB-only. Reads Turso. Cold miss fails fast.
- **Preview**: Branch switch/create sets `x-wildwood-branch` cookie + `draftMode()`. Mutations call `revalidateTag(WILDWOOD_CACHE_TAG)`.

## Env — explicit host mapping, no fallbacks in lib

Copy `.env.example` → `.env.local` for dev. Wildwood auth has no environment-variable configuration; the host still maps deployment credentials into the Git and database clients explicitly. Vercel System Envs may supply org/repo identity, while Better Auth derives its origin from each `Request`.

### Identity — zero-config on Vercel

`wildwood({ collections })` alone works when System Envs enabled:

- `org` → `VERCEL_GIT_REPO_OWNER` → git remote (dev)
- `repo` → `VERCEL_GIT_REPO_SLUG` → git remote (dev)
- `ref` → `VERCEL_GIT_COMMIT_REF` / `SHA` → `main`
- `origin` → `VERCEL_PROJECT_PRODUCTION_URL` / `BRANCH_URL` / `URL`

### Database — Turso integration canonical

```
TURSO_DATABASE_URL=libsql://…          # auto-injected by Vercel integration
TURSO_AUTH_TOKEN=…
# dev only: file:./wildwood-docs.db when TURSO_ missing
```

### GitHub App — git writes + OAuth (single app)

```
GITHUB_APP_ID=<numeric>
GITHUB_PRIVATE_KEY=-----BEGIN RSA PRIVATE KEY-----…
GITHUB_APP_INSTALLATION_ID=<numeric>   # optional
GITHUB_APP_SLUG=wildwood               # public, install-link UI only
GITHUB_APP_NAME=Wildwood
GITHUB_CLIENT_ID=<same App>
GITHUB_CLIENT_SECRET=<same App>        # App doubles as OAuth — no second app
```

Store `GITHUB_PRIVATE_KEY` via Vercel env UI — wildwood normalizes `\n` or literal newlines.

### Auth — persisted, project-scoped authority

Better Auth's secret is created once and persisted in the same database. No auth
environment variables are required. An optional `authenticate` callback can add
a sign-in restriction when the product needs one.

Client (`lib/wildwood.ts`) — one flat `wildwood({...})` call. Bring your own DB
driver and pass the constructed client in via `database:`. Live handles (the DB
client, Octokit) are only touched on first query, so this module-scope value is
safe to reference directly inside `"use cache"` (no separate read-only client):

```ts
import { createClient as createLibsql } from "@libsql/client";

const db = createLibsql({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

export const wildwood = createWildwood({
  collections: { authors, docs, nav },
  database: db,
  github: {
    type: "app",
    appId: process.env.GITHUB_APP_ID,
    privateKey: process.env.GITHUB_PRIVATE_KEY,
    installationId: process.env.GITHUB_APP_INSTALLATION_ID,
    clientId: process.env.GITHUB_CLIENT_ID,        // OAuth sign-in — same App
    clientSecret: process.env.GITHUB_CLIENT_SECRET,
  },
});
```

Route (`app/api/[...path]/route.ts`) — `createCMS` layers managed, ref-scoped
authority on the client. Better Auth owns identity and automatically reuses the
client's GitHub credentials; its secret is persisted in the same database:

```ts
export const { GET, POST, HEAD, OPTIONS, PUT, PATCH, DELETE } = createCMS(wildwood, {
  dangerouslyAllowDatabaseReset: true,
  auth: {
    bootstrap: { owner: "jeffsee.55@gmail.com" },
  },
});
```

- Contributors receive read access to `config.ref` and control of
  `users/{userId}/*`; users, agents, approvals, and anonymous preview links are
  represented as revocable grants rather than callbacks in app configuration.
- Multiple repositories can share the same identity realm and database. Each is
  a stable `wildwood_project`; grants, credentials, approvals, and audit events
  carry its `project_id`. GitHub's immutable repository id preserves authority
  when an owner or repository slug changes.
- `authenticate` and `authorize` remain optional additional restrictions, not
  the source of managed authority.

### Prototype database reset

This reference deployment explicitly enables the destructive reset action.
While signed in as `jeffsee.55@gmail.com`, open **Database** in the toolbar to
inspect auth, access, and indexed Git row counts or reset the shared database.
The menu is discovered through a protected capability request and is absent for
every user except the configured bootstrap owner. It navigates to the
Wildwood-served `/api/wildwood/cms/database` page, which streams table-level
progress and stays rendered after the site data and current session are gone.

The corresponding API remains available for automation or troubleshooting:

```js
await fetch("/api/wildwood/access/reset", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ confirm: "wipe all wildwood data" }),
}).then((response) => response.json());
```

It removes indexed Git data, Better Auth users and sessions, and all managed
access data. It preserves only the generated signing secret so a warm Vercel
instance and the database stay consistent. You will be signed out; signing in
with GitHub again recreates the owner grant. Remove
`dangerouslyAllowDatabaseReset` once the deployment stops being disposable.

### Optional / dev-only

```
WILDWOOD_DOCS_SOURCE=local|github
WILDWOOD_DOCS_REPO_PATH=/abs/to/repo
WILDWOOD_PLAYGROUND_LOCAL_ROOT=/abs/to/…

WILDWOOD_VSCODE_WEB_COMMIT=<sha>
WILDWOOD_VSCODE_WEB_VERSION=<semver>
WILDWOOD_GIT_API_LOG=0
```

## Local dev

```sh
pnpm run dev:docs        # turbo watch:deps + next:dev + studio:play
pnpm --filter docs run dev
```

No env needed for local read path — defaults to `file:./wildwood-docs.db` + `.git` auto-detect. Add `.env.local` only for Turso / GitHub App testing.

## Production checklist (Vercel)

1. Turso: `vercel integration add tursocloud/database` (injects `TURSO_*`) or manual `turso db create` + tokens.
2. Enable System Environment Variables in project settings.
3. GitHub App: create App (Contents Read & write, PRs Read & write, Metadata Read), install on repo, save 5 vars (`GITHUB_APP_ID`, `PRIVATE_KEY`, `CLIENT_ID`, `CLIENT_SECRET`, `APP_SLUG`), redeploy.
4. Auth: configure `bootstrap.owner`; Better Auth persists its own secret and reuses the GitHub App credentials already passed to the client.
5. Deploy — `baseURL`/`trustedOrigins` autodetect, preview branches work via cookie + `draftMode()`.

No `WILDWOOD_GITHUB_ORG/REPO`, `NEXT_PUBLIC_ORIGIN`, `BETTER_AUTH_TRUSTED_ORIGINS`, or `WILDWOOD_*` fallback cascade needed.

## Legacy

`TR33_*` env and `x-tr33-branch`/`tr33-active-ref` cookies still read as fallback, cleared on exit. New writes always use `x-wildwood-branch`. `allowedEmails` / `isAllowed` still accepted as deprecated for one minor — use `authenticate` callback instead.
