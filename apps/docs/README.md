# Wildwood docs — customer zero

This Next.js site uses the immutable core and the prebuilt Wildwood web integration in production. It has no dependency on the removed legacy CMS or VS Code editor.

## Development

Run `pnpm dev` from the root, then open http://localhost:3000. The development identity is explicitly selected from `/cms/sign-in`; it is unavailable on production builds. SQLite persists between restarts. Initial content comes from `content/`, bundled by `scripts/content.mjs`.

Create a draft, select a mapped title or body, save source, and review the before/after result. `/cms/connect` explains MCP setup. `/cms/health` reports database and provider readiness.

## Production on Vercel

Root Directory: `apps/docs`, with source outside the root included. `vercel.json` builds the three workspace projects through Turbo. Set:

| Variable                             | Purpose                                       |
| ------------------------------------ | --------------------------------------------- |
| `WILDWOOD_DOCS_DATABASE_URL`         | Persistent remote LibSQL/Turso database       |
| `WILDWOOD_DOCS_DATABASE_TOKEN`       | Database credential                           |
| `WILDWOOD_DOCS_ORIGIN`               | Stable HTTPS origin, without a trailing slash |
| `WILDWOOD_DOCS_GITHUB_CLIENT_ID`     | GitHub OAuth application ID                   |
| `WILDWOOD_DOCS_GITHUB_CLIENT_SECRET` | GitHub OAuth application secret               |
| `WILDWOOD_DOCS_OWNER_EMAIL`          | Verified GitHub email of the initial owner    |

GitHub callback: `<origin>/cms/auth/callback/github`. MCP URL: `<origin>/cms/mcp`. GitHub's repository connection to Vercel is separate from CMS user sign-in.

The existing `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` and `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` aliases are accepted. File-backed databases are rejected on Vercel. Use separate databases for preview and production. Canonical origin, issuer, and OAuth client configuration must agree; preview hostnames should not become permanent MCP connections.

Vercel deployment protection must permit intended MCP clients to reach the endpoint and discovery metadata. Wildwood enforces its own OAuth access. Do not enable local development authentication in production.

## Publication and persistence

Published page reads resolve `main` on each server request. Document caching is keyed by snapshot, generation, and locale, so content publication does not require redeployment. Signed-in moving views poll for external edits while visible. Pinned and shared previews remain pinned.

The database and blob store are authoritative. Redeploys do not overwrite existing documents. The initial seed runs only for an empty repository; the explicit agent-guide migration adds two missing manual pages once. It does not replace existing paths. Auth signing material is generated once and persisted in the database.

## Verification

```sh
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm check:deployment https://your-stable-origin.example
```

The deployment check verifies public rendering, database health, canonical OAuth discovery, PKCE and refresh metadata, unauthorized MCP rejection, and disabled production development-login. It exits nonzero if sign-in is unconfigured. The health response reports authentication as `configured`, which confirms presence of credentials, not a successful provider exchange. It does not claim a GitHub sign-in or authenticated write succeeded; those require the actual interactive OAuth flow.

Local tests cover real HTTP OAuth registration, consent, PKCE, token refresh, narrowed scopes, and revocation; content tools cover atomic edits, conflicts, history, restoration, preview sharing, and publication. Browser verification covers source selection, Server Action save, RSC refresh, review, approval, and publication.

Unconfigured Vercel PR previews render repository seed content in an in-memory, read-only workspace with sign-in disabled. They do not fall back to the production database. Configure a separate preview database and OAuth provider only when persistent preview editing is required. Production continues to require a durable remote database.

Native Git is bundled during Linux Vercel builds by `scripts/git-runtime.mjs`. Next traces `.git-runtime` into the function. `/cms/health` checks the executable. Agent branch updates hydrate temporary repositories; Git packs and merge plans persist in the database/blob store.

## Optional asset bytes and Git maintenance

Unmodeled files use SQL by default. Set `WILDWOOD_DOCS_ASSET_BLOB_TOKEN` (or Vercel’s linked `BLOB_READ_WRITE_TOKEN`) to a **private** Vercel Blob store token to send new asset bytes there. File trees, hashes, schema documents, and Git packs remain in the database. The adapter uses [Vercel's private Blob API](https://vercel.com/docs/vercel-blob/private-storage); public blob access is intentionally not used. Do not remove the store/token while any historical snapshot references its objects.

After building core, run `node --env-file=<production-env-file> apps/docs/scripts/compact-git.mjs` from the repository root to compact Git storage. The command prints storage counts only. It retains all Git history and old archive IDs, and removes duplicate bytes from the dedicated pack tables. Legacy shared content blobs and external media are not garbage-collected. Owners can also run **Optimize storage** from Manage access (bounded by the host function timeout). Maintenance is explicit; schedule it with your hosting infrastructure if desired.

Locale changes refresh the current view without invalidating immutable content caches. The layout, page and metadata share a request-memoized content load, and author references resolve together. Signed `ww-view` tokens remain the preview authority; Next Draft Mode is no longer enabled, and older bypass cookies are cleared on view/locale actions. Toolbar draft metadata is batched.

Production builds prepare both supported schema generations against the current published snapshot before deployment. Preparation never moves refs or overwrites documents. For an explicitly configured remote environment, `WILDWOOD_PREPARE_CONTENT=1 node scripts/prepare-content.mjs` runs the same step. Active drafts under a newly introduced generation are still prepared on first access.
