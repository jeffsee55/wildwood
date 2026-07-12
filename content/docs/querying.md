---
title: Querying
author: ../authors/jeff.md
description: "findMany, findFirst, with, where, references, variants, and how collection typing flows."
---

# Querying

Once collections are configured, queries go through the client returned by `createClient`. Types for `with` and `where` are inferred from the collections you pass to `defineConfig` — no codegen step.

## Client shape

```ts
const tr33 = createClient({ config, database, auth });

// One property per collection, named from collection name:
tr33.authors
tr33.docs
tr33.nav

// Internal:
tr33._.config
tr33._.db       // LibsqlDatabase
tr33._.git      // Git (remote, trees, caching)
tr33._.logger
```

Each collection has two entry points (both async):

```ts
tr33.docs.findMany(args?: {
  where?: Filters; with?: With; references?: References;
  limit?: number; offset?: number;
  orderBy?: Record<string, "asc"|"desc">;
  variant?: string; ref?: string;
}): Promise<{ collection, commitOid, items: Entry[] }>

tr33.docs.findFirst(args?: {
  where?: Filters; with?: With; references?: References;
  ref?: string;
}): Promise<{ org, repo, ref, version, name, commit, collection, value: Entry }>
```

Throws when `findFirst` finds nothing; `findMany` returns empty `items`.

## where

Every field marked `z.filter(T)` is queryable:

```ts
await tr33.docs.findMany({
  where: {
    title: { eq: "Introduction" },
    // operators: eq, ne, gt, gte, lt, lte, in, notIn,
    //           like, ilike, notLike, notIlike, isNull, isNotNull
  },
});
```

Compound:

```ts
where: {
  AND: [{ title: { like: "%config%" } }, { slug: { ne: "api" } }],
  OR:  [{ description: { isNull: true } }, { title: { ilike: "%intro%" } }],
}
```

System fields `path`, `slug`, and `ref` are always filterable even without `z.filter`:

```ts
await tr33.docs.findFirst({ where: { slug: "intro" } });
```

### Joined where (filter on connection target)

You can filter a collection by its related entries:

```ts
// "docs whose author.name equals Jeff"
await tr33.docs.findMany({
  where: { author: { name: { eq: "Jeff See" } } },
  with: { author: true },
});
```

This only works when `author` is a connection field (`z.connect(authors)` in the schema). The type layer validates this: disconnected fields don't appear in the joined `where` shape.

## with

Eager-loads connections:

```ts
const res = await tr33.docs.findFirst({
  where: { slug: "intro" },
  with: { author: true },
});
// res.value.author?.name — Resolved author entry, inferred
// via FindTypes + UnwrapCodec + OrmConfig

// Nested:
const nav = await tr33.nav.findMany({ with: { children: { with: { author: true } } } });
// nav.items enumerate, each child has optional author via inference
```

Invalid keys are a type error:

```ts
// @ts-expect-error — author2 does not exist on docs
await tr33.docs.findFirst({ with: { author2: true } });
```

Arrays: `with: { children: true }` resolves each entry in the array. The result type carries transient optional semantics from the underlying wrappers (`optional()` / `nullable()`).

### How types work (no codegen)

`FindTypes` walks the normalized collection schemas (after unwrapping lazy/optional/array/pipe/union/intersection/codec layers) to collect `{ type:"filter", path }` and `{ type:"connection", value, path, referencedAs? }` entries. Collections are mapped via `OrmConfig<Mapped>` (keyed by `Colls[K]["name"]`). `ConnArgs` / `WithShape` / `ResType` thread the `with` object through the output:

- `InferRes` preserves additionals from `@tr33/additions` if present.
- `EntrySystemFields` (`_meta`, `_collection`, `slug`, `path`) are always appended.
- Reverse references are layered in `ReverseRes`.

No build-time emit alters shape — `collection()` preserves the exact `Schema` generic, `config` captures it literally, and `createClient` forwards that literal via `Config<Colls>`. That's why `dist/index.d.mts` still carries the frontmatter fields.

## references (reverse connections)

When a connection has `referencedAs`, the target can query its back-links:

```ts
// schema
const docs = z.collection({
  schema: z.markdown({ author: z.connect(authors) }),
});

const authors = z.collection({
  schema: z.markdown({ /* ... */ }),
});
// connect options: { referencedAs: "written" }
docs.schema.author = z.connect(authors, { referencedAs: "written" });

// query reverse
const author = await tr33.authors.findFirst({
  where: { slug: "jeff" },
  references: { written: true },
});
// author.value.written — array of docs
// author.value.written[0].title — available via ReverseRes

// Nested with on reverse:
await tr33.authors.findFirst({
  references: { written: { with: { author: true } } },
});
```

Reverse source detection uses `ReverseSources<CM, Target, RA>` (matching on `value:Target` and `referencedAs:RA`). Only connections that declared `referencedAs` participate.

## Ref targeting

Override the ref per query (useful without cookies / preview):

```ts
const main = await tr33.docs.findMany({ ref: "main" });
const feat = await tr33.docs.findMany({ ref: "feature/word-count" });
```

In the docs app, the active ref is also supplied by cookie: see [Branching and preview](./branching.md).

## Variants

When `variants` is set on `config`, each query can request a variant axis:

```ts
await tr33.docs.findMany({ variant: "locale:fr|version:v2" });
```

See [Variants](./variants.md) for path modifier, selection, and scoring rules.

## Pagination and ordering

```ts
await tr33.docs.findMany({
  limit: 20,
  offset: 0,
  orderBy: { title: "asc" },
});
```

`orderBy` keys can be any column stored on `entries` (`slug`, `path`, filterable frontmatter fields).

## Infinite indexing (no manual `switch`)

`findMany`/`findFirst` self-heal on cold cache: if a ref's tables are empty (missing `refs` row + commit or emtpy `entries`), `Git.ensureRefInDb` fetches the commit from the remote if needed and `Git.switch` indexes the tree. In production without a checkout, cold cache fails fast with a helpful message telling you to build via `next build` (which has the checkout and populates Turso) rather than using a cryptic `Missing schema` error.

Next: [Branching and preview](./branching.md) for the cookie / draft boundary mechanics.
