# Wildwood core v2

The supported content engine, built around immutable content, sparse snapshots, and SQL queries. It has no dependency on Next.js, auth, React, or an embedded editor.

SQLite/LibSQL is the implemented query dialect. `wildwood-web` supplies request authorization, MCP, preview, review, and publication. The docs site deploys both on Vercel. PostgreSQL and Git push ingestion are not implemented.

## Try it

```sh
pnpm --filter wildwood-core build
node packages/core/examples/quickstart.mjs
pnpm --filter wildwood-core test
```

The example prints different main/draft titles while the pinned snapshot retains the original title.

## Content API

```ts
import { createClient } from '@libsql/client';
import { z } from 'zod';
import { collection, createContent, libsql, markdown } from 'wildwood-core';

const content = createContent({
  repository: 'acme/docs',
  version: '1',
  database: libsql(createClient({ url: 'file:content.db' })),
  variants: {
    locale: { options: ['en', 'fr'], default: 'en', path: 'suffix' },
  },
  collections: {
    pages: collection({
      match: 'content/**/*.md',
      parse: markdown(z.object({
        title: z.string(),
        category: z.string().optional(),
        body: z.string(),
      })),
      filters: ['title', 'category'],
    }),
  },
});

// First-time repository setup. Existing names produce a conflict.
await content.branch('main');
const draft = await content.branch('feature', { ref: 'main' });
const saved = await content.apply({
  ref: draft.name,
  expectedRevision: draft.revision,
  idempotencyKey: crypto.randomUUID(),
  changes: [{
    path: 'content/hello.md',
    content: '---\ntitle: Hello\ncategory: news\n---\nContent.',
  }],
});

const result = await content.query('pages', {
  snapshot: saved.snapshot, // or ref: 'feature'
  variant: { locale: 'fr' },
  where: { field: 'category', eq: 'news' },
  orderBy: { field: 'title' },
  limit: 20,
});
```

Collection parser outputs retain their TypeScript types. Filter/reference field names currently receive runtime validation; fully inferred query field types are not implemented yet. Query documents include `snapshot`, `version`, `variant`, `projection`, `path`, `canonical`, and `value`.

This API is a **trusted server API**. Possessing a snapshot ID is not authorization. Do not expose its methods directly over HTTP; a request adapter must verify repository/ref/snapshot authority first.

## References

Declare `references: { author: 'authors' }` on a collection. File contents use relative paths (relative to the physical source file) or root-relative `/authors/alice.json`. References are canonicalized and resolved in the selected snapshot and variant.

```ts
await content.query('pages', {
  ref: 'feature',
  where: { reference: 'author', where: { field: 'country', eq: 'France' } },
  orderBy: { reference: 'author', field: 'name' },
});

await content.resolveReference(document, 'author');
```

A missing target resolves to null and fails positive referenced predicates. `validateReferences(snapshot)` checks references in each declared variant context; the web publication path requires it. Validation currently supports up to 256 variant combinations. Reference arrays and reverse references are also future query features. Direct filters support scalar equality and greater-than; predicates compose with `and`/`or`. Sorting supports a direct field or one reference hop, with canonical path as a stable tie-breaker. Pagination currently uses bounded limit/offset.

## Storage behavior

- Branch creation inserts one ref pointing at an existing snapshot. No file memberships or projections are copied.
- An edit stores changed bytes and immutable projections, then appends one snapshot and one change row per affected path. Deletions are tombstones.
- Publication checks the expected ref revision and records the idempotent command result in the same transaction as the pointer update.
- Validation failures leave the ref untouched. Unreachable staging objects/snapshots may remain; garbage collection is not yet implemented.
- Queries use recursive SQL ancestry resolution, then variant ranking, then predicates and reference joins, and finally ordering/pagination. No query-result emptiness heuristic exists.
- `checkpoint(snapshot)` records a full, rebuildable membership checkpoint atomically. It stops ancestor traversal at that snapshot without changing results. Scheduling/automatic thresholds are not implemented.
- A new schema version prepares projections lazily without copying content or snapshot memberships. Preparation currently walks all effective files and checks their projection caches; mutation latency is intentionally not optimized.
- Generation state is `building`, `ready`, or `failed`; failures retain diagnostics. Old engine instances continue querying their original generation. Use `prepare(snapshot)` at deployment time to avoid first-reader preparation latency.
- Reuse the version only while interpretation stays identical. A signature detects declarative changes, but cannot inspect captured state inside arbitrary parser functions; bump the version when parser/schema behavior changes.
- The initial physical schema is created automatically. Physical initialization uses idempotent DDL, batched atomically by the LibSQL adapter. There is no general ALTER migration runner; a content generation bump is not a physical schema migration.

Variant defaults, explicit compatibility, matching-default scores, explicit specificity, and declared-axis precedence are preserved. Variant options use unambiguous path tokens; overlapping tokens across axes are currently rejected. Only explicit files are indexed: no Cartesian fallback rows are created. Queries resolve requested variants before filtering, sorting, and reference traversal. Folder and suffix path modifiers are supported.

SQL blobs are the zero-configuration default. Supply a `BlobStore` with immutable `put(id, bytes)` and `get(id)` for object storage. File contents use SHA-256 identities independent of Git. The engine verifies returned bytes before parsing/export. A built-in local filesystem adapter is available:

```ts
import { fileBlobs } from 'wildwood-core/filesystem';
// Pass blobs: fileBlobs('/persistent/wildwood/objects') to createContent().
```

Blob storage is authoritative, not a cache. Back it up alongside SQL. Custom adapters must complete durable writes before resolving `put`; incomplete writes must not become readable. All access to a native LibSQL client should use the supplied adapter while it is operating: the adapter serializes local transactions, including in-memory databases. Remote LibSQL uses the driver's transaction API; remote integration testing remains outstanding.

## Git import, commit, and server

The optional Node adapter requires a native `git` executable. Ordinary saves create no Git blobs or trees. Import preserves file bytes/modes and packs the original reachable history into the blob store. Export hydrates a bare repository and creates a commit only when needed.

```ts
import { importGit, exportGit, createGitHandler } from 'wildwood-core/git';

const imported = await importGit(content, {
  directory: '/checkout', ref: 'main', targetRef: 'imported',
});

const exported = await exportGit(content, {
  snapshot: imported.snapshot,
  directory: '/persistent/git/content.git',
  branch: 'main',
  message: 'Publish content\n',
  author: { name: 'Editor', email: 'editor@example.com' },
});

const handleGit = createGitHandler({
  directory: exported.directory,
  authorize: async request => verifyRepositoryReadAccess(request),
});
// Mount this Request -> Response handler at /git/content.git/*.
```

`verifyRepositoryReadAccess` is an application-supplied verifier, not a library function. This handler exposes a real smart HTTP Git server for clone/fetch. Access must cover the whole served repository and its reachable history; a content-ref grant is insufficient. Responses are private/no-store. Push and dumb HTTP object access are denied.

Imported snapshots re-export with the original commit ID. Edited snapshots export as children of the nearest recorded Git ancestor. One snapshot gets one recorded Git commit; repeated exports reuse it. Exported ref updates use Git compare-and-swap. Export is a trusted administrative operation, not yet a durable workflow command.

Current Git adapter limits: UTF-8 paths, SHA-1 repositories, regular/executable files and symlinks (collection documents cannot be symlinks), no submodule ingestion, buffered packs capped at 256 MiB, full ancestry packs rather than incremental pack storage. It is an interoperability reference implementation, not the eventual large-repository server. The clone/fetch HTTP handler requires persistent local storage and is not a Vercel serverless handler; merge computation uses disposable temporary storage. A blob-native streaming pack transport can replace it without changing content snapshots.

Receive-pack will need quarantined objects, per-ref authorization, expected-head checks, validation/preparation, atomic multi-ref publication, and recovery after interrupted responses. It intentionally does not mutate Git refs independently of the content engine.

## Verification

The tests exercise snapshot isolation, sparse writes, stale-filter removal, reference changes across branches, variant-aware filtering and hydration, schema-generation isolation, validation failure, idempotency, concurrent mutations, checkpoints, and path/mode validation. Git tests use real repositories, strict `git fsck`, binary/mode round-trips, parent preservation, and an actual authenticated HTTP clone.

Performance at millions of documents is not established. The recursive/window-based SQL is a correctness baseline; native indexes, query compilation, checkpoints, and a future optimized engine can evolve under the same semantics.

## Agent-oriented operations

Built-in `markdown` and `json` codecs retain an input JSON Schema and a safe top-level field patcher. `describe()` exposes collection patterns, schema, indexed fields, references, and variants. `collectionFor(path)` requires exactly one declared collection. Custom callable parsers remain supported but do not automatically gain structured field editing.

`query` supports literal substring search over JSON string values after locale selection, canonical-path lookup, filters, ordering, and bounded pagination. This is SQL substring search, not a relevance-ranked full-text or vector index.

`validateChanges` checks a proposed batch without writing snapshots or advancing refs. `apply` validates the complete staged snapshot before atomically publishing its draft ref. Every successful apply/ref move records an audit event in the same transaction as its command result. Web publication checks references and checkpoints the snapshot before moving the live ref.

`audit: { actor, source }` is trusted server metadata, never accepted directly from an MCP caller. Failed schema validation can leave unreachable staged immutable data; automatic garbage collection is not implemented.

## Native Git reconciliation

`planGitMerge(engine, { base, ours, theirs })` checkpoints the three snapshots into Git and runs `git merge-tree --write-tree`. The plan, merged tree, conflict stages, messages, and full ancestry packs are durable in the configured database/blob store. No working directory is durable. This uses Git’s merge engine, not a custom file or line merger.

`readGitConflict(engine, planId, path)` reads the original, draft, published, and Git-produced conflict-marker text (bounded to 128 KiB per version). `resolveGitMerge(engine, planId, resolutions, confirmConflicts)` requires a choice for every staged conflict and explicit confirmation of Git’s conflict messages, then returns content changes plus the two-parent commit and archive. It does not advance a branch. Hosts must authorize the plan and atomically save its commit mapping with the content ref and base metadata. The web package supplies this transaction, stale-plan checks, and retry handling.

Native Git 2.38+ is required. `WILDWOOD_GIT_EXECUTABLE` can select a trusted executable; repository content cannot set it. SHA-1 and the existing Git adapter limits apply. Merge plans currently retain full packs; automatic pruning and incremental packs are not implemented.
