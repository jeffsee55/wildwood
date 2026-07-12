---
title: API reference
author: ../authors/jeff.md
description: The public surface — collections, client, queries, routes, Kit, and branch helpers with types.
---

# API reference

All public types come from `tr33`, `tr33/nextjs/*`, and `@tr33/shared` (for constants). Imports below are accurate to the codebase at this repo.

## Top-level (`tr33`)

```ts
import { createClient, defineConfig, z } from "tr33";
import type { Tr33Client, Tr33AuthConfig, Tr33AuthAction, Tr33AuthorizeContext } from "tr33";
```

- `defineConfig(input)` → `Config<Colls>` (generic-captures `Colls` literally for inference).
  - `{ org, repo, ref, version?, localPath?, collections, variants? }` (see [Configuration](./configuration.md)).
- `createClient({ config, database, auth? })` → client instance shape described under `createClient` section.
- `z` — re-exported `zod/v4` plus `z.collection`, `z.connect`, `z.filter`, `z.markdown`, `z.json`, `z.variant`.
- `GIT_EMPTY_TREE_OID` — empty tree constant `4b825dc642cb6eb9a060e54bf8d69288fbee4904`.

### Collections / macros

```ts
z.collection({ name: string; match: string; basePath?: string; schema: Schema }): typeof args
// name: identity used as tr33.[name]
// match: minimatch glob (normalized)
// basePath?: derives slug (else fixed prefix of match)
// schema: ZodType (often z.markdown/ z.json macro result)

z.markdown(shape?: LooseShape): ZodCodec<string, ZodObject<{ ...shape, body: Root }>>
// shape values: primitives, z.filter(T), z.connect(C), z.lazy(()=>...), arrays, etc.
// body is mdast Root plus raw/links/leafDirectives added by visitor; parse via js-yaml for frontmatter.

z.json(shape: LooseShape): ZodCodec<string, ZodObject<shape>>
// parse JSON body, index per same visitor (up to filters/connections in JSON too)

z.filter<T extends ZodType>(type: T): ZodCustom<T["_output"], { __internalFilter: T["_output"] }>
// marks field as queryable — writes Filter row; usable in where.

z.connect<C extends CollectionParams, RA?>(collection: C, { referencedAs?: RA }?)
// runtime marker with __tr33Connection = collection.name, referencedAs
// types as custom with UnresolvedConnectionOutput and resolved connection meta schema

z.variant<T extends ZodType>(schema: T): Union<Record<string,T>, T> with registry description "variant"

z.lazy, z.optional, z.array, etc — plain Zod passthrough, inferred through `FindTypes`.
```

## Client (`tr33` client)

```ts
import { createClient } from "tr33";
import { createClient as libsql } from "@libsql/client";

const database = libsql({ url, authToken });
const tr33 = createClient({ config, database, auth? });
```

- `tr33.[name].findMany(args?)` → `{ collection, commitOid, items: (Inferred & EntrySystemFields & ReverseRes)[] }`
- `tr33.[name].findFirst(args?)` → `{ org, repo, ref, version, name, commit, collection, value: ... }` (throws on missing).
- `args`: `{ where?, with?, references?, limit?, offset?, orderBy?, variant?, ref? }` where `with` is `ConnArgs<CM,FM,Name>` typed per collection and nested.
- `tr33._.config`, `.auth?`, `.git`, `.db`, `.logger`.

`Tr33Client` is structural — `Record<string, any>` with `_` namespace for internal (tag `NoExplicitAny` bypassed for collection shape).

## Types (query layer)

`packages/tr33/src/client/types.ts`:

- `FindTypes<T>` — walks Zod object/array/lazy/optional/nullable/default/pipe/union/intersection/custom wrappers to collect filter+connection markers from unwrapped inner type (`UnwrapCodec` unwraps `ZodCodec`/`ZodPipe`/def out recursively).
- `OptionsForColl<T>` = `FindTypes<UnwrapCodec<CollSchema<T>> & ZodType>` — the set of filter/connection entries for a collection.
- `ConnArgs<CM,FM,CName,D>` — `With` keys available at this collection (depth-gated at 4), values `boolean | WithShape<CM,FM,V, Inc<D>>`.
- `WithShape` — carries `where?, limit?, offset?, orderBy?, with?, references?` (forward `with` + reverse `references`).
- `Filters<FM,K,CM>` — `{ field?:op, system?, AND?:..., OR?:..., join?:... }`, join filters via `JoinFilters<CM,FM,K>` (connection path → `Filters<FM,target,CM>`).
- `OrmConfig<T>` — mapped per collection name to `{ findFirst< W extends ConnArgs<...>, R extends ReverseConns<...>>, findMany<...> }` promises with typed `InferRes` + `EntrySystemFields` + `ReverseRes`.
- `EntrySystemFields` — `_meta:{raw,oid,path,canonicalPath,slug}`, `_collection`, `slug`, `path`.
- Reverse: `ReverseConns`, `ReverseSources`, `ReverseEntries`, `ReverseRes`.

## Config (`client/config.ts`)

- `defineConfig<C extends AnyCollections>(input)` — constructs `Config<C>` storing `configInput` literally (to preserve shape), runtime-validates via `configInputSchema` / `configSchema` (version defaults to `"0"`).
- `Config` class:

```ts
class Config<Colls extends AnyCollections> {
  configObject: ConfigObject;  // runtime-validated
  configInput: DefineConfigInput<Colls>; // literal
  get org, repo, ref, localPath, version, collections, namespace, paths, resolvedLocalPath, wantsLocal
  matches(path: string): boolean
  getCollectionForPath(path: string): string|null
  maybeBuildCollectionForPath(path: string): { name,schema }|null
  slugForPath(filePath, collectionName?): string
  defaultVariant(): string   // combo of variant axes defaults or "__"
  get paths(): string[] // deepest fixed folders (overlap removed), sorted by length
  listVariants(): string[]
  findMostSpecificVariant(entries: string[], variant: string): string|undefined
  findMissingCombos(entries: string[]): { variant, path }[]
  index(args: { ref, oid, path, content }, cache: Cache): { indexed:true;collection }|{indexed:false}
}
```

- `deriveSlug(filePath, { basePath?, match })` — strips base or `fixedPrefixFromMatch(match)`, extension, `/index`.
- `fixedPrefixFromMatch(match)`.
- `resolveLocalGitRoot(start)` / `normalizeLocalPath` / `shouldAutoUseLocal` private helpers.

## Auth (`client/auth.ts`)

```ts
type Tr33AuthConfig = {
  github?: Tr33GitHubAuth;    // {type:"app",app:{appId,privateKey,installationId?}} | {type:"token",token} | {type:"default"}
  betterAuth?: Tr33BetterAuthLike; // { api:{ getSession(args:{headers:Headers}) } }
  getUser?: (req: Request)=>Promise<Tr33AuthUser|null>;
  authorize?: (ctx: Tr33AuthorizeContext) => boolean|void|Response|Promise<...>;
};

type Tr33AuthUser = { id?, email?, name?, image?: string|null };
type Tr33AuthAction = { type:"git.switchRef",ref } | { type:"git.createBranch",name,baseRef? } | { type:"git.add",ref,paths } | { type:"git.patchWorktree",ref,paths } | { type:"git.commit",ref,message } | { type:"git.discard",ref } | { type:"git.push",ref } | { type:"git.pull",ref } | { type:"git.merge",ref,message? } | { type:"git.createPr",ref,title?,body? };
type Tr33AuthorizeContext = { action: Tr33AuthAction; config: Config; request: Request; user: Tr33AuthUser|null };
```

- `getUser` wins over `betterAuth`; `userFromUnknownSession(session)` extracts `Tr33AuthUser` from `{ user?:... }`.

## Git (`git/git.ts`)

```ts
class Git implements Gitable {
  constructor({ config: Config, remote: Remote, db: LibsqlDatabase });
  config: Config; db: LibsqlDatabase; remote: Remote; blobStore: Map<oid,content>; trees: Trees;

  get paths(): string[]
  getTree(oid): Promise<TreeEntries|null>   // mem cache (Trees.treeStore), DB, remote→DB, then null
  getBlob(oid): { oid, content }|null         // DB then remote
  getCommit(oid: string | {ref}|{oid}): Promise<Commit|null>
  createBranch(args: { name, base }): Promise<void>   // ensureRefInDb(base), refs.updateCommit(name, base.commit), setTreeOid, copy versions
  ensureRefInDb(args:{ref}): Promise<void>            // when row missing or commit absent: remote.fetchCommit, db.commits.put, markPushed, updateRemoteCommit
  resolveWorktreeForApi(args:{ref}): { commit:{oid,treeOid}, rootTreeOid:string|null } // same ensure semantics for VFS read-only listing
  switch(args:{ref}): Promise<void>                    // if worktree.rootTree → writeEntries(tree traversal)+updateVersions, else fetch+markPushed then writeEntries+setTreeOid+versions
  add(args:{ref, files:Record<string,string|Uint8Array>, onProgress?}): {files:Record<string,oid>, rootTreeOid}
  patchWorktree(args:{ref, rootTreeOid, trees:{oid,entries}[], changedFiles:{path,oid,content}[]}): {rootTreeOid}
  indexChangedFiles(args:{ref, changedFiles}): Promise<void>
  findMany(args: FindWorktreeEntriesArgs, opts?): Promise<{collection, commitOid, items}>  // self-heals cold cache → switch → re-call once
  findFirst(args, opts?): Promise<...>     // throws when not found
  // plus query building bits via LibsqlDatabase + Trees helper
}
```

- `GitAddResult = { files:Record<string,oid>, rootTreeOid }`.
- `gitAddTimer(ref, onProgress?)` → `(step)=>log + onProgress`.
- `calculateBlobOid`, `calculateBlobOidFromBytes`, `calculateCommitOid`, `Trees`, `TreeEntries` from `tr33-store` (`packages/store`).

## Remotes (`git/remote/index.ts` + `native`/`github`)

```ts
abstract class Remote {
  constructor({ auth?: Tr33AuthConfig, config: Config })
  abstract listBranches(): Promise<string[]>
  abstract fetchCommit(args:{ref?}|{oid?}): Promise<Commit>
  abstract fetchBlobs({oids}): Promise<{oid,content}[]>
  abstract fetchTree({oid}): Promise<Record<string,{type,oid}>|null>
  abstract fetchBlobRaw({oid}): Promise<Buffer|null>
  abstract createBlob({content:Uint8Array}): {oid}
  abstract push(args:{ref, commits:Commit[], blobs:{oid,content}[], commitTrees:{treeOid,parentTreeOid,paths:{path,oid,type}[]}[]}): Promise<PushResult>
  abstract createPr, updatePr, findPr, createPrComment, mergePr, ... plus getRepoInstallationStatus etc (GithubRemote only)
}
class NativeRemote extends Remote // reads .git directly via simple-git + libgit2 bindings? Uses `config.resolvedLocalPath`
class GitHubRemote extends Remote // GitHub API (GraphQL for trees/commits, REST for PRs), app token flow
```

- `NativeRemote` listBranches uses local `git` resolution; `GitHubRemote` hits `GET /repos/{owner}/{repo}/branches`-style GraphQL.
- Errors from GitHub remotes include `getRepoInstallationStatus` states `not_installed` / `not_configured`.
- `isMissingSchemaError(e)` helper in `LibsqlDatabase` classifies index-missing errors.

## Handler / route factory

```ts
// pure fetch
import { handle, createHandler } from "tr33/nextjs/handler";
const api = handle(tr33);             // (req:Request)=>Promise<Response>
const app = createHandler(tr33);      // H3 app (mount /api sub-routers internally)
```

Handler mounts `/git`, `/vscode`, `/github` sub-routers. CORS applied per request (`vscodeEmbedCorsHeaders`/`withVscodeEmbedCors` for `/api/vscode/*`, else allow caller origin + credentials).

```ts
// Next.js wrapper
import { createTr33Route, TR33_BRANCH_COOKIE, TR33_CACHE_TAG } from "tr33/nextjs/route";
export const { GET, POST, HEAD, OPTIONS, PUT, PATCH, DELETE } =
  createTr33Route(() => tr33, { revalidateTagName?, branchCookieName?, legacyCookieNames?, mutationRe?, revalidateTagStore? });
```

`TR33_BRANCH_COOKIE`, `TR33_BRANCH_COOKIE_FALLBACKS`, `TR33_ACTIVE_REF_COOKIE`, `TR33_ACTIVE_REF_STORAGE_KEY`, `TR33_CACHE_TAG`, `ACTIVE_REF_MAX_AGE_SEC`, `TR33_SYNC_HOST_ACTIVE_REF_HEADER` re-exported from `@tr33/shared` via `tr33/nextjs/branch` and `tr33/nextjs/index.ts`. Route factory `handles()` details in [Branching](./branching.md) and [Editor routes](./editor-routes.md).

```
Standalone draft route:
import { createDraftRoute, type CreateDraftRouteOptions } from "tr33/nextjs/draft";
export const { GET, POST } = createDraftRoute({ branchCookieName?, legacyCookieNames? });
```

Legacy alias `resolveActiveRef` still re-exported from `tr33/nextjs/branch`/`resolve-active-ref`; preferred is `getBranch` / `resolveBranch`.

## Branch / cookie helpers

```ts
import {
  cookiesFromCookieHeader,
  resolveBranch,
  getBranch,
  getActiveBranch, // alias of getBranch
  getActiveRef,    // alias of getBranch
  activeRefSetCookieHeader,
  clearBranchCookieHeader,
  branchCookieOptions,
  allBranchCookieNames,
  TR33_BRANCH_COOKIE,
  TR33_BRANCH_COOKIE_FALLBACKS,
  TR33_ACTIVE_REF_COOKIE,        // legacy alias = "tr33-active-ref"
  TR33_ACTIVE_REF_STORAGE_KEY,   // "tr33.activeRef"
  TR33_CACHE_TAG,                 // "tr33"
} from "tr33/nextjs/branch";

type Tr33RequestCookies = { get(name:string): { value:string }|undefined };
function cookiesFromCookieHeader(cookie: string|null|undefined): Tr33RequestCookies;
function resolveBranch(args:{
  tr33: {_: {config:{ref:string}}};
  cookies: Tr33RequestCookies;
  cookieName?: string;
  fallbackCookieNames?: readonly string[];
  draftModeEnabled?: boolean;
}): string;

async function getBranch(
  tr33, opts?:{ cookies?, cookieName?, fallbackCookieNames?, cookieHeader?:string|null, draftModeEnabled?:boolean }
): Promise<string>;
```

`resolveBranch` search: canonical cookie `cookieName` then fallbacks; fallback to `config.ref`. `getBranch` auto-imports `next/headers` when `cookies` not supplied, degrades gracefully to `config.ref` outside Next.

## Kit

```ts
import { Tr33Kit, Toolbar, type ToolbarProps, type Tr33KitProps, type KitAuthConfig } from "tr33/nextjs/kit";
```

- `ToolbarProps` = `Tr33KitProps & { fallback?: ReactNode }`.
- `Tr33KitProps = { tr33: Tr33KitHostClient (_:config.ref read), apiBase?:string (default "/api"), theme?:Theme(default "system"), auth?:KitAuthConfig, activeRef?:string|null, cookieName?:string, vscodeCommit?:string }`. `Tr33KitHostClient` structural `Tr33ForActiveRef`.
- `KitAuthConfig` (UI only) public bits: `{ enabled?, enforceInProduction?, userEmail?, githubOAuthEnabled?, githubApp?:{ appSlug?, name?, origin? } }`. `Toolbar` without `auth` derives from `GITHUB_APP_SLUG` / `GITHUB_APP_NAME`. Private signing stays in `createClient({auth:{github}})`. Auth merge in Server Component shallow + `githubApp` merge.
- `Theme = "light"|"dark"|"system"`, `ResolvedTheme = "light"|"dark"` exposed from `ThemeProvider` (`@tr33/kit` package doc). Kit listens to `matchMedia("(prefers-color-scheme: dark)")`, writes `.dark` on shadow container/documentElement, sets `colorScheme`, `data-kit-theme`, disable transitions.
- FAB, auth panel, editor open sequence, branch channels constants — see [Kit](./kit.md).

## Shared (`@tr33/shared`)

Re-exported via `tr33/nextjs/index.ts` legacy compat too, but source is `packages/shared`:

```ts
TR33_BRANCH_COOKIE = "x-tr33-branch"
TR33_BRANCH_COOKIE_FALLBACKS = ["x-content-branch","tr33-active-ref"]
TR33_ACTIVE_REF_COOKIE = "tr33-active-ref"   // legacy alias same string as one fallback (kept for compat)
TR33_ACTIVE_REF_STORAGE_KEY = "tr33.activeRef"
TR33_CACHE_TAG = "tr33"
ACTIVE_REF_MAX_AGE_SEC = 604800 (7d)
GIT_EMPTY_TREE_OID = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
BRANCH_CITIES: const array of cities
generateBranchName(): `${city}-${suffix4}`  // suffix base36
activeRefSetCookieHeader(ref, cookieName?): string   // encodes ref, Path=/; HttpOnly; SameSite=Lax; Max-Age=...
clearBranchCookieHeader(cookieName?): string
allBranchCookieNames(): string[]
branchCookieOptions(ref, cookieName?): { name,value,path,httpOnly,sameSite,maxAge }
Kit channels: TR33_KIT_HOST_REF_CHANNEL="tr33-kit-host-ref", TR33_EXTENSION_TO_HOST_REF_CHANNEL, TR33_EXTENSION_WORKSPACE_CHANGED_CHANNEL, TR33_KIT_CLOSE_MESSAGE, TR33_KIT_BRANCH_CHANGED_MESSAGE, TR33_KIT_WORKSPACE_CHANGED_MESSAGE
```

## Markdown render

```ts
import { Markdown } from "tr33/react/markdown";
<Markdown root={doc.body} components={{ a:({href,children,...})=> <Link href={...}/> } } />
```

`doc.body` is mdast `Root` (with `raw`, `links`, `leafDirectives` appended). `Markdown` recursively renders via `hast`? Actually owns rendering loop — no dependency on `prose`. `typeset` owns spacing rhythm, not Markdown.

## Internals you probably shouldn't import

- `sqlite/query-builder.ts` — query engine for LibSQL (where/with/join). Public via `_.db`.
- `zod/visitor.ts` — walked by `Config.index`.
- `nextjs/handlers/git-service.ts` — sub-router owning `/git/*` — `createGitServiceRouter(client): H3`.
- `nextjs/handlers/github-router.ts`, `vscode-router.ts` — other sub-routers.

All of above documented as INTERNAL_RISK in this repo but still part of API for dogfooding; the public barrel is narrower.

Next: [Configuration](./configuration.md) for configuration options, then [Branching](./branching.md) for the preview cookie story.
