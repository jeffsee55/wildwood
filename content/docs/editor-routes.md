---
title: Editor routes
author: ../authors/jeff.md
description: "git/*, tr33/*, vscode/* endpoints mounted by the H3 handler and the branch cookie."
---

# Editor routes

The content editor (Kit toolbar, VS Code web, or custom UIs) talks to the same H3 handler as the rest of the app. Routes are mounted per the factory `{ GET, POST, ... }` export. Requests flow `next/route → createWildwoodRoute → wildwood/nextjs/handler (H3) → git-service / github / vscode routers`.

## Base

- Mount point: `/api` by default (`apiBase` option). All paths below are relative to it unless shown absolute (`/api/git/...`).
- Framework shape: route factory is Next-specific; `handle` (`wildwood/nextjs/handler`) is pure Fetch and framework-agnostic. CORS headers are set for `/api` (allow caller `Origin` + credentials) and replaced for `/api/vscode/*` with `vscodeEmbedCorsHeaders`. `OPTIONS` is handled (204) before calling the sub-routers.

## Git routes (`/api/git/*`) — handled in `git-service` router

| Method | Path | Body | Auth | Effect |
|--------|------|------|------|--------|
| GET | `/git/branches` | – | none | Lists local + remote refs. Local = `db.refs.listRefs()` (worktrees indexed so far). Remote = `remote.listBranches()`. Merges + dedupes. On error, `{branches:[]}` with soft-fail if remote list throws after returning locals. |
| GET | `/git/editor-guards` | – | none | Checks GitHub App install + VS Code CDN commit. In dev (non-GitHub remote) returns `ready` with CDN commit. In prod GitHub mode checks `remote.getRepoInstallationStatus()` and may return `not_installed` (with `installUrl` derived from `GITHUB_APP_SLUG`) or `not_configured`. Result: `{ status:"ready"|"not_configured"|"not_installed", repo, vscodeCommit?, installUrl?, hint?, message? }`. |
| GET | `/git/editor-bootstrap` | – | none (returns cached state) | Verifies active ref is indexed. Calls `git.resolveWorktreeForApi({ref:activeRef})`, then `getTree` on `rootTreeOid ?? commit.treeOid`. Returns `{ status:"ready", ref, commitTreeOid, rootTreeOid, entryCount }` or error/remind states when treeCount is zero (`"Repository tree … is not indexed yet"`). |
| POST | `/git/switch-branch` | `{ ref }` | `git.switchRef` | Switches DB index to `ref`: ensures remote commit exists (fetch if needed), calls `git.switch`. Returns `{ ref, commitOid, treeOid }`. Host route factory sets branch cookie. |
| POST | `/git/create-branch` | `{ name, baseRef | base }` | `git.createBranch` | Creates branch from `base`. `ensureRefInDb(base)` materializes base ref row (commit row, no full indexing), then `refs.updateCommit(ref=name, commit=base.commit)`, `setTreeOid`, copy versions. Does not index new branch (`switch` happens lazily on first query). Returns `{ ref, baseRef, commitOid, treeOid, alreadyExists? }`. `name` is trimmed; host also stores `name` from body for cookie before JSON response when available. |
| POST | `/git/commit` | `{ ref, message, author?:{name,email}, files?:Record<string,string|Uint8Array>, rootTreeOid?:string, trees?:{oid,entries}[], changedFiles?:{path,oid,content}[] }` (z-validated) | `git.commit` | Commits. Two paths:<br/>• **patch fast-path** when `rootTreeOid`, `trees`, `changedFiles` supplied (client-computed worktree from VS Code FS provider) → `git.patchWorktree({ref, rootTreeOid, trees, changedFiles})` + `indexChangedFiles` only for those files (avoid full `switch`). Logs `[wildwood:patch-worktree]` timing.<br/>• **fallback `git.add` path** when `files` supplied without tree precompute → `gitAddTimer`, `calculateBlobOid`, `blobStore`, `batchPut`, `ensureRefInDb`, `applyEntriesToTree`, `writeEntries`, `ensureTrees`. Returns commit metadata (`commitOid`, `treeOid`, parent info) plus patch summary when applicable. |
| POST | `/git/discard` | `{ ref }` | `git.discard` | Resets branch state for `ref`: re-indexes to remote's current commit for that ref (removes local overlay). Returns `{ ref, commitOid, treeOid }` after re-index. |
| POST | `/git/push` | `{ ref }` | `git.push` | Pushes local commits for `ref` to upstream. Returns push result (commitOid mapping, treeOid, optional PR link depending on remote). |
| POST | `/git/pull` | `{ ref }` | `git.pull` | Pulls remote into `ref` (fetch commit + rebase/merge strategy). Returns updated commit oid. |
| POST | `/git/merge` | `{ ref, ref2?, message? }` | `git.merge` | Merge (or second-parent merge into `ref`). `ref2` is the other branch. Returns merge commit OID + merged flag (`{ commitOid, merged }`). |
| POST | `/git/create-pr` | `{ ref, title?, body?, labels?, base? ...}` (via PR input schema) | `git.createPr` | Creates PR using the `Remote` impl (GitHub or Native throw/not-implemented). Returns `PrResult` `{ number, url, title, body, labels }`. |
| POST | `/git/update-pr` etc. | … | … | PR operations (update, find, comment, merge) mapped through `Remote`. Native remote throws `Not implemented` (mapped to sensible 501/4xx via `auth.ts` helper `isNativeRemoteNotImplementedError`). |

Errors from the git router are logged via `[wildwood:git-api]`. When `authorize` denies, the router returns the authorizer's response or a 403 JSON (`{ error:"Forbidden" }`). Ref names in 404/400 reference `config.ref` style branch.

### Commit path — deeper

- Zod-validated inputs (strict strings + optional author + `files` map).
- `createBlob` for binary when `Uint8Array`, `calculateBlobOidFromBytes` for bytes path vs `calculateBlobOid` for UTF-8 strings.
- `trees.applyEntriesToTree({ rootTreeOid, entries })` reuses the empty-tree OID constant (`GIT_EMPTY_TREE_OID = 4b825dc642cb6eb9a060e54bf8d69288fbee4904`) to skip uploading new-dir trees.
- Cold path: `worktree` miss does `git.switch(ref)` + recursive `add`.

## Draft / preview (`/api/tr33/*`)

These are handled by `createWildwoodRoute`'s own layer, **not** the H3 sub-routers. Behavior:

| Method | Path | Body / query | Effect |
|--------|------|--------------|--------|
| GET or POST | `/api/wildwood/draft?branch=<ref>` | `branch` required on enable | Enables `draftMode()`, sets canonical branch cookie `x-tr33-branch`. No global `revalidateTag` — preview is per-user bypass. Returns `{ draftMode:true, branch }`. |
| GET or POST | `/api/wildwood/draft?disable=1` | – | Disables draft, clears canonical + legacy cookies, returns `{ draftMode:false }`. |
| GET or POST | `/api/draft` | same | Legacy alias (still honored when the catch-all covers `/api`). |
| GET or POST | `/api/wildwood/preview` | – | Exit preview alias that clears cookie + disables draft. Used by Kit toolbar. Legacy `/preview/exit`. |

Non-Next fetch fallthrough: if `next/headers` is unavailable, the route factory degrades to `Set-Cookie` on `Response` headers (no `cookies()`/`draftMode()`), still parses `?branch=` and writes the canonical cookie via `activeRefSetCookieHeader`.

## VS Code routes (`/api/vscode/*`)

Mounted by `vscode-router` (proxies VS Code Web + FS provider bindings). Requests hit `POST /api/vscode/...` variants. CORS head injection comes from `vscode-embed-csp.ts` (`vscodeEmbedCorsHeaders`, `withVscodeEmbedCors`). The FS provider in Kit translates reads/writes to `/api/git/commit` patch flow.

## GitHub routes (`/api/github/*`)

Thin wrapper for GitHub endpoints not under `/git/pr` (e.g. `GET /api/github/accounts`, `GET /api/github/repos` for Playground listing). Protected by same `authorize` / session lookup if configured.

## Auth model in the handler

- Only `createWildwoodRoute({ auth: { authenticate, authorize } })` owns authz. `createClient({ provider })` is transport-only — no `authorize`/`authenticate` there.
- Route resolves session user via better-auth (lazy-loaded, reuses same Turso DB), then:
  1. `authenticate` gate — can this identity sign in at all? (allowlist). Enforced on `/api/auth/*` + on every git endpoint for already-signed-in sessions.
  2. `authorize(req, action)` gate — can this session do `{ type: "git.commit", ref, ... }` / `content.update`? Return `false` or `Response` to deny.
- H3 git handlers (`createGitServiceRouter`, `createGitHubAppManifestRouter`) accept an injected `authorize: (req, action) => Promise<Response|null>` from the route — they don't import auth or read `client._.provider._`.
- `isNativeRemoteNotImplementedError(e)` distinguishes "not implemented by native remote" from actual GitHub failures so PR endpoints can return a clear 405 / 501 rather than 500.
- On deny: `{ error: "Forbidden" }` or custom `Response` from `authorize`.

## Integration test strategy

Use `apps/play` or curl against the catch-all: since everything is over HTTP/JSON you can drive tests without Next, just hit the factory's `POST`s from Vitest with mocked `Request` + `getClient()`.

Next: [Kit toolbar](./kit.md) for the floating editor surface and channel sync.
