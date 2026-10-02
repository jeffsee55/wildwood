# Wildwood

MCP-driven content management for Next.js. Agents work in isolated drafts; people review immutable revisions and publish the exact content they approved. The docs site is the first production customer.

## Workspace

- `packages/core` — typed collections, content-addressed bytes, immutable snapshots, variant-aware SQL queries, validation, audit history, and optional Git import/export.
- `packages/web` — OAuth, scoped MCP tools, previews, review, publication, and a prebuilt editing toolbar.
- `apps/docs` — the complete Vercel integration and working manual.

The legacy CMS, playground, VS Code extension, and embedded IDE have been removed. No Git executable or filesystem checkout is required by the deployed app.

## Run

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Open http://localhost:3000. Sign in as the local developer through the toolbar. Local sign-in is available only on loopback development servers. It exercises real OAuth consent, PKCE, access tokens, and refresh.

```sh
pnpm test       # core and real HTTP/OAuth integration tests
pnpm typecheck # all three projects
pnpm build     # full production build
pnpm lint
```

## Connect an agent

Open `/cms/connect`, add the site's `/cms/mcp` URL to an OAuth-capable MCP client, and approve the desired scopes. Start by asking the agent to discover the content model and create a draft.

The MCP server exposes schema discovery, search, reference resolution, source and structured field edits, atomic batches, validation, history/restoration, preview sharing, and review submission. Every mutation checks authority and the observed revision; identical retries reuse a command key. Agents cannot approve their own work or publish with editing credentials. Owners can issue a separate, short-lived capability for one approved publication.

## Storage and publication

The durable database and blob store hold authoritative content snapshots, drafts, identities, and review history. **The database is not a disposable Git cache.** Git import/export is an optional interoperability adapter. There is currently no automatic GitHub synchronization.

Publication moves the configured live ref to the approved snapshot. The docs app reads that ref on each server request and caches document results by immutable snapshot. Publishing content therefore does not require a Vercel rebuild. Logged-in live previews notice external changes automatically. Pinned previews retain their original snapshot.

Markdown/JSON files in `apps/docs/content` bootstrap a new database. Redeploying does not overwrite authored content. Back up the remote database and any external blob store together.

See [the deployment guide](apps/docs/README.md), [core API](packages/core/README.md), and [web integration](packages/web/README.md).
