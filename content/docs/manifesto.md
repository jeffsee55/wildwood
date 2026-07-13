---
title: Manifesto
author: ../authors/jeff.md
description: "Philosophy, invariants, and agent rules — why the DB is ephemeral, Git is source of truth, variants are missing from CMS, and references are king."
---

# Wildwood Manifesto

> For agents, editors, and humans who build with content.
> Read this before you touch the code.

Wildwood is not a CMS that happens to use Git. It is Git, with a CMS layer on top.

Content lives in `content/` as Markdown + JSON. It is typed with Zod, stored as Git blobs, addressed by OID, indexed into LibSQL only so we can query it fast. Everything else is derived.

---

### 1. The database is ephemeral. Git is the source of truth.

`wildwood.db`, `wildwood-docs.db`, Turso — all derived indexes. You can delete them. `findMany` will rebuild them lazily via `ensureRefInDb` → `switch` → `trees.entriesFromTree` → `config.index` → `writeCache`.

- If the DB is missing: `isMissingSchemaError` → `db.init()` → `schema.json` replays.
- If the DB is stale or empty but claims to be indexed: `findMany` self-heals — `rootMissing || versionMismatch || entries==0` triggers reindex.
- Never add state to the DB that you cannot reconstruct from Git + `defineConfig`. If you add a column, add a rebuild path.

Implication for agents: never treat the DB as durable. Never write migrations as ALTER TABLE. Treat it like a cache you can warm, drop, and rebuild.

### 2. Git primitives are king. Lean on idempotency, accept hashing cost.

We use content-addressable storage on purpose:

- `calculateBlobOid`, `calculateBlobOidFromBytes`, `calculateTreeOid`, `GIT_EMPTY_TREE_OID = 4b825dc642cb6eb9a060e54bf8d69288fbee4904`
- `Trees` (`wildwood-store`) with `applyEntriesToTree`, `entriesFromTree`, `treeStore` memory layer
- `mergeOrt` — ORT-style merge with `diff3` content merge, `newBlobs` output, conflict types `add-add | modify-delete | content`

Trees are rewritten by re-hashing. We do it often. We intentionally trade CPU for correctness.

Rules:

- Always compare OIDs before writing. `if (rootTreeOid === prevRoot) append version else invalidate`.
- `ensureTrees(ref, trees, appendVersion?)` semantics: root unchanged = idempotent switch → `appendVersion`; root changed = real save → `versions=[current]`, other versions lazily reindex.
- `createBranch` must never copy `versions`. New branch starts empty, lazy indexes on first query. Copying versions caused ghost-empty results in 8b08535.
- When unsure, re-index. Never leave a `versions` claim without entries.

### 3. Migrations are version bumps.

`config.version: "1"` is not semver for marketing. It namespaces the index.

When filter shape changes, connection changes, variant axes change, or schema table shape changes:

- bump `version`
- tables self-heal — `onConflictDoUpdate` / `onConflictDoNothing`, `dedupeRefVersions`, `splitSqlStatements` + ignorable `already exists`
- reader self-heals — version mismatch triggers `switch`

No `drizzle/migrations` folder to babysit. `database.ts` `writeCache` and `refs.versions` are the migration system.

Future: a K/V cache API will follow the same rule — namespaced by version, rebuilt from Git, never manually migrated.

### 4. No CLI. Code-first.

`defineConfig({ org, repo, ref, version, collections, variants?, localPath? })` in your own file is the config. `z.collection`, `z.markdown`, `z.json`, `z.filter`, `z.connect`, `z.variant`, `z.lazy` are code.

Why:

- Types flow without codegen: `collection()` preserves literal `Schema` generic → `Config<Colls>` captures it → `createClient` → `OrmConfig<Mapped>` → `FindTypes<UnwrapCodec<...>>` infers `with`/`where` end-to-end even through emitted `.d.mts`. One generic break ruins inference for every app.
- Glob matching is `minimatch` + `deriveSlug` + `fixedPrefixFromMatch`, not a hidden YAML config.
- `resolvedLocalPath` auto-walks `cwd → .git` (12 depth) in dev; production forces remote/DB-only. No CLI flag needed.

If we add a CLI later, it will be a thin wrapper over these primitives, not a new source of truth.

### 5. Variants are first-class, not an afterthought.

Most CMSs bolt locale/version on later. Wildwood treats variants as orthogonal axes:

```ts
variants: {
  locale: { options: ["en","fr"], default:"en", pathModifier:{type:"extensionPrefix"} },
  version:{ options:["v1","v2"], default:"v1", pathModifier:{type:"folder"} }
}
```

- `getPathVariantInfo`, `parseVariantCombo`, `listVariants`, `findMissingCombos`, `findMostSpecificVariant`
- Path modifiers: `extensionPrefix` (`intro.fr.md`) and `folder` (`fr/intro.md`) collapse to canonical.
- Resolution: default path always allowed; explicit path allowed only if all explicit axes match request; scoring = `countMatch` then `countExplicitMatch` then declaration-order tie-break.
- Entry storage: `entries.canonical`, `entries.variant`, `entries.path`, `entries.slug` are real columns, not computed at query time.
- Copy-on-write sibling fallback: after `writeCache`, `findMissingCombos` → `entries.copy({variant, path, ref})` fills absent combos by copying the best available — scoped by target ref, not `config.ref`.

If you add a variant axis, you add a dimension that every entry implicitly has, with a default. That's the missing mental model.

### 6. References are king. Links should almost never be URLs.

`z.connect(authors)` means frontmatter `author: ../authors/jeff.md` is a file-path relation, canonicalized, validated against the target collection's match, stored in `connections` with `field`, `key`, `to`, `literal`, `referencedAs`.

Querying:

- `with: { author: true }` → eager `toConnections` join → `toEntry` typed via `ConnArgs` → `ResType`
- `with: { author: { with: { avatar: true } } }` — nested
- `where: { author: { name: { eq:"Jeff" } } }` — joined where via `toDrizzleWhereClause` translating nested shape into `toConnections.AND → toEntry.filters`
- `references: { written: true }` — reverse via `referencedAs`, `ReverseSources<CM,Target,RA>` only includes connections that declared it

Today: markdown `links` and `leafDirectives` are parsed (`fromMarkdown` → `visit("link")` / `visit("leafDirective")`) but not yet promoted to `z.connect`. That's a known gap.

Future: every inline link to another page on this domain should be a reference, not a string URL. `leafDirectives` (`:component{prop=ref}`) will become reference sites. `mdast` `Root` (`body`) will carry resolved reference nodes with OIDs, not raw URLs — so renames propagate via canonical, not find-replace.

Rule for agents: if you are about to emit `<a href="/docs/intro">`, stop. Model it as `z.connect(docs)` and query it with `with`.

### 7. It’s just Git. Expose more Git, not less.

Current seams:

- `Remote` abstraction: `NativeRemote` (reads `.git` directly, auto-detected) vs `GitHubRemote` (GitHub API + App auth)
- `Git` is `Gitable`: `getTree`, `getBlob`, `getCommit` — DB first, then remote
- Writes: `git.add`, `git.commit`, `git.push`, `git.createBranch`, `git.switch`, `git.merge`, `git.pull`, `git.discard`
- `patchWorktree` — client-computed worktree: client builds new tree OIDs locally, sends only new trees + changed files, server `batchPut` blobs/trees, `setTreeOid`, `updateVersions`, `indexChangedFiles`. This is how the embedded editor saves without round-tripping full repo.

We will eventually expose more Git-friendly APIs from the bundled route:

- `/api/git/log?path=content/docs/intro.md` → history for a file
- blame, diff, `show`, file at ref
- status matrix without full checkout, for agents to reason about working tree
- KV cache API `wildwood.cache.get/set` namespaced by `ref+version` — still git-addressable if we back it with `refs/wildwood/cache/*` or just LibSQL, TBD

If you add a feature and you have a choice between a new table vs a new Git primitive, pick the Git primitive.

### 8. No form system. Agents edit, humans review.

We have no Sanity-style form builder. No schema-to-input widget mapper. Intentional.

- Humans write Markdown/JSON in `content/` or use VS Code Web embedded via `wildwood/nextjs/kit` + `wildwood-vscode` extension (served from `wildwood/nextjs/vscode-router` + `bundled-extension` bytes, no CDN CORS headaches).
- Agents write blobs via `git.add` + `commit` or `patchWorktree`.
- The editor saves via `client-computed patch-worktree with incremental indexing` — not a custom save endpoint that invents its own format.

We may expose MCP in the bundled routes (`createWildwoodRoute` already owns `/api/wildwood/*`, `/api/git/*`, `/api/vscode/*`, `/api/github/*`). An MCP surface would expose `findMany`, `findFirst`, `getBlob`, `add`, `commit`, `createBranch`, `switch` as tools, with `authorize(ctx)` gating.

Until then: the client is the API. `wildwood.docs.findMany` typed from config is the form system.

### 9. Preview is a branch. Cookie, not infrastructure.

- Cookie canonical: `WILDWOOD_BRANCH_COOKIE = "x-wildwood-branch"`, `ACTIVE_REF_MAX_AGE_SEC = 604800`
- Fallbacks still read: `x-tr33-branch`, `x-content-branch`, `wildwood-active-ref`, `tr33-active-ref` — cleared on exit
- Resolution order: `resolveBranch({ cookieName, fallbackCookieNames, wildwood._ })` → `cookiesFromCookieHeader` (framework-agnostic) or `next/headers` wrapper `getBranch(wildwood)`
- `createWildwoodRoute(() => wildwood, { revalidateTagName, branchCookieName, legacyCookieNames, mutationRe })`
  - owns setting cookie on `POST /api/git/{create,switch}-branch`
  - owns clearing all branch cookies on `POST /api/wildwood/preview` or `GET .../draft?disable=1`
  - calls `revalidateTag(WILDWOOD_CACHE_TAG, store)` only on real mutations, never on draft enter/exit — draft uses `draftMode().enable()` which per-user bypasses `"use cache"` via `__prerender_bypass`, preventing global purge
- `cacheTag(WILDWOOD_CACHE_TAG)` + `cacheLife("hours")` inside components; queries target `ref` from cookie

No preview deploys. No separate env. Branch = preview. Closing preview = clear cookie + `router.refresh()`.

### 10. Dogfood and bring your own infra.

- `apps/docs` and `apps/play` dogfood the library. Their `content/docs/**/*.md` is the library's own docs. Their `lib/wildwood.ts` `defineConfig` is the canonical example.
- Build prefetch: `next build` has the checkout, so it indexes into LibSQL (local file or Turso). Runtime (Vercel) has no checkout, serves from Turso only. Cold cache fails fast with a message saying “re-run next build” rather than “no such table”.
- `createClient({ config, database })` accepts any `@libsql/client` driver — `file:`, `libsql://`, edge.
- Handler is H3 (`wildwood/nextjs/handler`) → framework-agnostic `Request→Response`. Next wrapper adds cookies/revalidation. So wildwood can live in H3, Cloudflare, Bun, not just Next.

### 11. For agents — how to be useful here

1. **Read `MANIFESTO.md` + `content/docs/{intro,configuration,querying,variants,branching,deploy,api}.md` before writing code.**
2. **Never edit generated DB files.** `*.db` is ignored by `**/wildwood-docs.db`. Never commit them.
3. **Preserve literal generics.** Do not change `collection()` to rebuild shape via `_zod.def.shape`. That collapses `FindTypes` to `never` and breaks `with` in downstream apps.
4. **Test core via `packages/wildwood/src/tests/*.test.ts`.** Core suite: `pnpm --filter wildwood exec vitest run 3-add 8-switch 6-query 5-variants 1-switch 2-merge 4-commit` + `version-bump` regression. Docs build must stay green.
5. \*\*When touching `ensureTrees` / `versions` / `createBranch` / `findMany`, run `version-bump.test.ts`. It guards the hardest invariant.
6. **Treat `z.filter` as intent.** If a field should be queryable, it needs `z.filter(...)`. If not, it shouldn't be.
7. **Prefer references over strings.** When modeling new content, reach for `z.connect` and `referencedAs` before URLs.
8. **Branches are cheap. Make one.** `generateBranchName()` (`BRANCH_CITIES`) exists. Use it for agent edits, set cookie, never mutate `main` directly in preview flows.
9. **Log with context.** Use `[wildwood:git-add]`, `[wildwood:patch-worktree]` shape with ref, file list, ms timings. Silence via `WILDWOOD_GIT_API_LOG=0` if noisy.
10. **Self-heal > error.** If your new feature could leave a partially claimed index, add a recovery path in `findMany` and an `ensureRefInDb`-style guard, with a single retry, not a loop.

---

Wildwood's bet: the next decade of CMS work is not a better dashboard. It's agents and humans co-editing plain files in Git, with typed queries, reference integrity, variant coverage, and preview branches that cost nothing. The DB is a view. Git is the truth. References are the graph. Variants are the axes. The rest is tooling that gets out of the way.
