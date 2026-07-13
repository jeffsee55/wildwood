# docs app — production setup

Reference deployment for **Turso + GitHub App + Vercel, preview via branches, no separate preview infra.** Zero env fallbacks inside wildwood — host maps env → explicit options.

## How it runs

- **Build**: `.git` checkout → `NativeRemote` pre-indexes `content/` into LibSQL during `findMany`.
- **Prefetch**: `TURSO_DATABASE_URL=libsql://…` → build writes straight to Turso. `file:…` stays local.
- **Runtime**: No checkout, GitHub remote or DB-only. Reads Turso. Cold miss fails fast.
- **Preview**: Branch switch/create sets `x-wildwood-branch` cookie + `draftMode()`. Mutations call `revalidateTag(WILDWOOD_CACHE_TAG)`.

## Env — explicit host mapping, no fallbacks in lib

Copy `.env.example` → `.env.local` for dev. Wildwood itself reads zero `WILDWOOD_*`/`GITHUB_*` fallbacks except Vercel System Envs for org/repo identity + better-auth autodetect via `Request`.

### Identity — zero-config on Vercel

`defineConfig({ collections })` alone works when System Envs enabled:

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

### Auth — `BETTER_AUTH_SECRET` + callbacks

```
BETTER_AUTH_SECRET=…                   # openssl rand -base64 32
ALLOWED_EMAILS=you@example.com,other@example.com   # parsed in userland, not wildwood
```

Route (`app/api/[...path]/route.ts`):

```ts
createWildwoodRoute(() => wildwood, {
  auth: {
    database: { url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN },
    secret: process.env.BETTER_AUTH_SECRET,
    // baseURL omitted → autodetected from Request (x-forwarded-host/proto + origin)
    // Works for localhost, *.vercel.app previews, custom domains — no NEXT_PUBLIC_ORIGIN needed.
    // trustedOrigins omitted → defaults to derived origin. Map in userland if cross-domain:
    // trustedOrigins: (req) => [new URL(req!.url).origin, "https://studio.myapp.com"]
    github: { clientId: process.env.GITHUB_CLIENT_ID!, clientSecret: process.env.GITHUB_CLIENT_SECRET! },

    authenticate: async ({ user }) => {
      const allow = (process.env.ALLOWED_EMAILS ?? "").split(",").map(s=>s.trim().toLowerCase()).filter(Boolean);
      if (!allow.length) return process.env.NODE_ENV !== "production" ? !!user.email : false;
      return allow.includes(user.email?.toLowerCase() ?? "");
    },
    authorize: async ({ user }) => !!user,
  },
});
```

- `authenticate` = can this identity create a session? (sign-in/sign-up, not distinguished; inspect `provider` if you need different rules)
- `authorize` = can this session perform this action? (`git.commit`, `content.update`, …)

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
4. Auth: set `BETTER_AUTH_SECRET`, `ALLOWED_EMAILS` (parsed in your `authenticate` callback — not inside wildwood), optional `GITHUB_CLIENT_ID/SECRET` already from App.
5. Deploy — `baseURL`/`trustedOrigins` autodetect, preview branches work via cookie + `draftMode()`.

No `WILDWOOD_GITHUB_ORG/REPO`, `NEXT_PUBLIC_ORIGIN`, `BETTER_AUTH_TRUSTED_ORIGINS`, or `WILDWOOD_*` fallback cascade needed.

## Legacy

`TR33_*` env and `x-tr33-branch`/`tr33-active-ref` cookies still read as fallback, cleared on exit. New writes always use `x-wildwood-branch`. `allowedEmails` / `isAllowed` still accepted as deprecated for one minor — use `authenticate` callback instead.
