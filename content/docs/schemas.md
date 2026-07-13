---
title: Schemas
author: ../authors/jeff.md
description: "Collections, z.markdown, z.json, filters, connections, and the visitor that turns frontmatter into index rows."
---

# Schemas

Every file under `content/` is selected by a collection's `match`, parsed by its `schema`, and then indexed through `Config.index` (driven by `zodVisitor`). This page explains each piece.

## Collections

```ts
z.collection({
  name: "docs",
  match: "content/docs/**/*.md",
  basePath: "content/docs",       // optional — influences slug derivation
  schema: z.markdown({ /* frontmatter shape */ }),
});
```

- `match` — glob (uses `minimatch`). Supports `**`, arrays of globs are not yet supported at the collection level (use multiple collections instead).
- `basePath` — stripped when deriving a slug. If omitted, tr33 uses `fixedPrefixFromMatch(match)` (the literal prefix before the first glob character). So `content/docs/**/*.md` has implied base `content/docs`.
- `name` — identity in queries and in `EntrySystemFields._collection`. Convention: matches the import key (`collections.docs`).

## z.markdown

Wraps a frontmatter shape (Zod loose shape) and adds `body: Root` (mdast `Root` AST):

```ts
const docs = z.collection({
  name: "docs",
  match: "content/docs/**/*.md",
  schema: z.markdown({
    title: z.filter(z.string()),
    description: z.string().optional(),
    author: z.lazy(() => z.connect(authors)).optional(),
  }),
});
```

Runtime: `z.codec(z.string(), z.object({ ...shape, body: Root }))`. `decode` parses frontmatter via `js-yaml`, slices the `yaml` node off the mdast, collects `links` / `leafDirectives` via `unist-util-visit`, and materializes `ast.raw`. `encode` is a no-op (markdown serialization is handled by the commit path).

Result shape from `findMany` includes every frontmatter field (typed via original `shape`) plus:

```ts
{
  title: string;
  description?: string;
  author?: AuthorsEntry; // when with:{author:true}
  body: Root & { raw: string; links: { url, position }[]; leafDirectives: unknown[] };
  _meta: { raw, oid, path, canonicalPath, slug };
  _collection: string; slug: string; path: string;
}
```

## z.json

```ts
const nav = z.collection({
  name: "nav",
  match: "content/nav/**/*.json",
  schema: z.json({
    name: z.filter(z.string()),
    label: z.string(),
    children: z.array(z.lazy(() => z.connect(docs))),
  }),
});
```

Runtime: `z.codec(z.string(), z.object(shape))`. `decode` calls `JSON.parse`. Errors parse-fail to `indexed: false` (file is skipped).

## z.filter

```ts
z.filter(z.string())
```

Marks a field as filterable. Runtime it is `T.pipe(z.custom(val=>val,{params:{__wildwoodFilter:true}}))` typed so it exposes `{ __internalFilter: T }` for `FindTypes` inference. `zodVisitor` walks the parsed value; when its schema carries `__wildwoodFilter`, it calls `onFilter` which writes a row to the `filters` table (`ref, path, field, value`). `where: { title: { eq: "…" } }` then filters on that table.

`z.filter` inside `z.array`, `z.optional`, `z.lazy`, `z.pipe`, etc is discovered by the visitor unwrapping those wrappers.

## z.connect

```ts
z.connect(authors)
z.connect(authors, { referencedAs: "authors" })
z.lazy(() => z.connect(authors)).optional()
```

Declares a relation to another collection. Runtime it is `z.custom(()=>true,{params:{__wildwoodConnection,name,referencedAs?}})`. The output type carries `{\_collection, \_meta:{resolved:false;value:string}} & (referencedAs?). The input is always the frontmatter string (relative path to the target), not an id.

Indexing: when the visitor encounters a connection marker, it records the raw string. Later `config.index` canonicalizes:

- `./x` or paths starting with `./` → treated as repo-root-relative.
- Otherwise relative to `dirname(filePath)`.
- Verifies the canonical target exists in the same ref and matches a collection.
- Writes a row to `connections` (`ref, path, field, key, to, literal, collection, referencedAs`).

`key` is the field path with `/` separators (e.g. `author`, `children/0`). `to` is the canonical target path. `referencedAs` powers reverse joins via `references`.

### Lazy / optional / array wrappers

`z.lazy(() => z.connect(...))` is needed when collections reference each other (cycles via laziness). `FindTypes` unwraps `ZodLazy`, `ZodOptional`, `ZodArray`, `ZodDefault`, `ZodNullable`, `ZodPipe`, `ZodUnion`, `ZodIntersection`, and `ZodCodec` layers, so `with: { author: true }` and `where: { author: { name: { eq } } }` both work through `optional()` and `lazy()`.

## z.variant

Not yet needed for this docs app, but present in the crate:

```ts
z.variant(inner) // union of Record<string, inner> | inner
```

Registers with a Zod registry described as `"variant"`; used for localized shapes.

## Visitor details

`zodVisitor` is the indexing pass. Given `{ schema, value, variant, onFilter, onConnection }`, it unwraps into `{ ZodObject, ZodArray, ZodCustom (filter/connection), ZodUnion (with variant search + discriminant path logic), ZodPipe, ZodOptional, ZodLazy, ZodNullable }`. Connections can return a replacement value (e.g. rewrite the reference to a canonical form) which mutates the object unless `skipMutations: true`.

## Slug / canonical

`Config.deriveSlug(filePath,{ basePath, match })` strips `basePath` (or `fixedPrefixFromMatch(match)`) from `filePath`, removes the extension, collapses `/index` to `""`. Variants further strip via `pathModifier` (`extensionPrefix` like `.fr.` or `folder` like `fr/`). Slug and `path`/`canonicalPath` are stored in `_meta` and available for `where: { slug, path }` system filters and for deriving `generateStaticParams`.

Next: [Querying](./querying.md) for `findMany` / `findFirst` / `with` / `where` / `references`.
