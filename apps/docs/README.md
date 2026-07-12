# docs app — production setup

This is the Wildwood docs site (`content/docs/**/*.md` → `wildwood.docs.findMany()`). It doubles as the reference deployment for how Wildwood should run in production: **Turso + GitHub App + Vercel, preview via branches, no separate preview infra.**

## How it runs

- **Build**: Next build has a `.git` checkout, so `wildwood` uses `NativeRemote` and pre-indexes your `content/` into LibSQL during `findMany` (cold-cache self-heal via `Git.switch`).
- **Prefetch target**: When `WILDWOOD_DOCS_DATABASE_URL=libsql://…` (Turso), the build writes straight to Turso. When `file:./wildwood-docs.db`, it stays local — you need a separate step to push to Turso or a seed job.
- **Runtime on Vercel**: No checkout. `resolvedLocalPath` undefined (prod guard), GitHub remote selected unless forced. Reads only Turso. Cold miss fails fast with "Re-run `next build` with checkout" instead of cryptic schema error.
- **Preview**: Any branch switch/create sets `x-wildwood-branch` cookie + enables `draftMode()`. Next bypasses `"use cache"` per-user (`__prerender_bypass`), so enabling preview for one editor doesn't purge prod cache. Real mutations (`commit`, `merge`, `create-branch` etc) call `revalidateTag(WILDWOOD_CACHE_TAG)`.

## Environment variables (opinionated production)

This app owns the singleton in `lib/wildwood.ts`. Copy `.env.example` → `.env.local` for dev, then set these in Vercel for production.

### Required

```
# Identity — namespaces the index DB; change requires re-index or version bump
WILDWOOD_GITHUB_ORG=jeffsee55
WILDWOOD_GITHUB_REPO=wildwood
```

### Required on Vercel (build + runtime)

```
# Where the derived index lives. Local file in dev, Turso in prod.
# Build writes here; runtime reads here.
WILDWOOD_DOCS_DATABASE_URL=libsql://<db>.turso.io
WILDWOOD_DOCS_DATABASE_AUTH_TOKEN=<turso-token>

# Pins queries to the deployed commit. Vercel sets VERCEL_GIT_COMMIT_SHA automatically.
# TR33_DOCS_REF removed — use WILDWOOD_DOCS_REF, or just rely on VERCEL_GIT_COMMIT_SHA.
# Fallback order: WILDWOOD_DOCS_REF → VERCEL_GIT_COMMIT_SHA → config.ref
WILDWOOD_DOCS_REF=main   # or leave unset and let VERCEL_GIT_COMMIT_SHA win

# GitHub App — powers /api/git writes, worktrees/B.Y.O clone via editor, PR ops.
# Private bits never leave server. Public slug/name are used only for install links.
GITHUB_APP_ID=<numeric>
GITHUB_PRIVATE_KEY=<PEM, \n escapes OK>
# Optional — skips GET /repos/{owner}/{repo}/installation lookup on each request
GITHUB_APP_INSTALLATION_ID=<numeric>
# Public slug/name for install links. If missing, Kit stays usable (content still
# renders); editing is visually disabled and a setup entrypoint is shown inline.
# No throw — enforce writes server-side in /api/wildwood/github/* if you need it.
GITHUB_APP_SLUG=wildwood
GITHUB_APP_NAME=Wildwood
```

Use `pnpm dlx` or Vercel env UI to store `GITHUB_PRIVATE_KEY` — keep literal newlines or `\n` escaped; `defineConfig` / `wildwood` runner normalizes both.

### Optional / dev-only

```
WILDWOOD_DOCS_SOURCE=local|github          # force remote selection, else auto-detect via cwd → .git
WILDWOOD_DOCS_REPO_PATH=/abs/to/repo       # override local checkout path (CI, non-standard layout)
WILDWOOD_PLAYGROUND_LOCAL_ROOT=/abs/to/…   # play app honours same override via this alias

# Pin VS Code web CDN commit (air-gapped builds). Unset → resolveVscodeWebCdn() fetches latest stable.
WILDWOOD_VSCODE_WEB_COMMIT=<sha>
WILDWOOD_VSCODE_WEB_VERSION=<semver>

# Silence git API logs
WILDWOOD_GIT_API_LOG=0

# Public better-auth instance is wired via lib/auth.ts in this app — when present,
# authorize() gates /api/git/* by session. Unset = authorize: () => true (owner only via GitHub App).
# BETTER_AUTH_URL, BETTER_AUTH_SECRET, etc live in lib/auth.ts, not here.
```

## Local dev

```bash
# from repo root
pnpm run dev:docs        # turbo watch:deps + next:dev + studio:play (docs DB at apps/docs/wildwood-docs.db)

# or this app only
pnpm --filter docs run dev   # next dev, relies on wildwood core auto-detecting .git checkout
```

No env needed for local read path — `WILDWOOD_DOCS_DATABASE_URL` defaults to `file:./wildwood-docs.db` and `WILDWOOD_DOCS_SOURCE` autodetects `NativeRemote`. Add `.env.local` only if you want to test with Turso / GitHub App.

## Production checklist (Vercel)

1. `turso db create wildwood-docs` + `turso db tokens create wildwood-docs`
2. Set `WILDWOOD_DOCS_DATABASE_URL`, `WILDWOOD_DOCS_DATABASE_AUTH_TOKEN` in Vercel (Build + Runtime).
3. Create GitHub App (Settings → Developer settings → GitHub Apps): permissions `Contents: Read & write`, `Pull requests: Read & write`, `Metadata: Read`. Install on `jeffsee55/wildwood`. Copy App ID + private key, derive slug/name.
4. Set `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, `GITHUB_APP_SLUG`, `GITHUB_APP_NAME` in Vercel. Optional `GITHUB_APP_INSTALLATION_ID` for perf.
5. Leave `WILDWOOD_DOCS_REF` unset to use `VERCEL_GIT_COMMIT_SHA` auto-pin, or set explicitly to `main` if you prefer branch pointer deploy.
6. Deploy. Build populates Turso. Runtime reads Turso. Branch previews work via cookie (`/api/wildwood/draft` + `GET /api/wildwood/preview` to exit). Toolbar auto-resolves active ref via `getBranch(wildwood)` → `await cookies()` internally.

## Verifying

```sh
# Simulate prod DB-only reader — no checkout, read from Turso (fail-fast message if seed missing)
WILDWOOD_DOCS_SOURCE=github WILDWOOD_DOCS_DATABASE_URL=$WILDWOOD_DOCS_DATABASE_URL \
  pnpm --filter docs next build

# Stage + cutover SHA pattern
VERCEL_GIT_COMMIT_SHA=$NEW_SHA pnpm --filter docs build
# then deploy; runtime env reads WILDWOOD_DOCS_REF=$NEW_SHA or VERCEL_GIT_COMMIT_SHA automatically
```

If `findMany` says "Wildwood index missing for ref X", you missed DB seed or version bump — it tells you whether `WILDWOOD_DOCS_DATABASE_URL` / `TURSO_*` was set.

## Legacy

`TR33_*` env names still accepted at runtime as fallback aliases (see `shared` constants + `lib/wildwood.ts` bridge), but docs and all new code should use `WILDWOOD_*`. `x-tr33-branch` / `tr33-active-ref` cookie fallbacks still read, cleared on draft exit. New writes always use `x-wildwood-branch`.
