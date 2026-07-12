---
title: Introduction
author: ../authors/jeff.md
description: "What tr33 is, how it stores content in Git, and the minimal setup to go from content/ files to a typed client."
---

# Introduction

tr33 is a Git-native content layer. You write Markdown and JSON files in `content/`, declare their shapes with Zod, and query them with a fully typed client. Git is the source of truth — branches are content branches, commits are content publishes, and the database is a derived index that can always be rebuilt.

This site is itself a tr33 app. Its source is `content/docs/**/*.md` in this repository, indexed and served through tr33's own API.

## Why Git as the CMS?

Most CMSs introduce a separate database, auth system, editor, and deploy pipeline for content. tr33 collapses that stack:

- **Content lives in Git.** Review, diff, revert, and branch with the tools you already use.
- **The database is derived.** LibSQL (local or Turso) holds an index of filters, entries, and connections. If it's missing or stale, tr33 rebuilds it from Git.
- **Edits are just Git operations.** The editor writes blobs, updates trees, and commits through the same remote abstraction (local checkout or GitHub API) the CLI would use.
- **Preview is a branch.** Switching branches sets a cookie (`x-tr33-branch`). The app reads it and queries the target ref. No separate preview infrastructure.

## Core concepts

### Collections

A collection maps a glob pattern to a schema:

```ts
import { z } from "tr33";

const docs = z.collection({
  name: "docs",
  match: "content/docs/**/*.md",
  schema: z.markdown({
    title: z.filter(z.string()),
    description: z.string().optional(),
  }),
});
```

- `name` — the collection's identity in queries (`tr33.docs`).
- `match` — glob that selects files. `z.json` collections use the same.
- `schema` — `z.markdown()` for `.md` files (frontmatter + `body` AST), `z.json()` for JSON files.
- `z.filter(T)` — marks a field as queryable in `where`. Unmarked fields still exist in results but can't be filtered on without joining.

### Connections

Collections relate through file-path references:

```ts
const authors = z.collection({
  name: "authors",
  match: "content/authors/**/*.md",
  schema: z.markdown({ name: z.filter(z.string()) }),
});

const docs = z.collection({
  name: "docs",
  match: "content/docs/**/*.md",
  schema: z.markdown({
    title: z.filter(z.string()),
    author: z.lazy(() => z.connect(authors)).optional(),
  }),
});
```

A doc's frontmatter `author: ../authors/jeff.md` (relative) or `../authors/jeff.md` resolved against the doc's directory becomes a link. The indexer canonicalizes the path, verifies it matches the target collection, and records a connection row. At query time, `with: { author: true }` joins it.

Arrays of connections work too:

```ts
const nav = z.collection({
  name: "nav",
  match: "content/nav/**/*.json",
  schema: z.json({
    label: z.string(),
    children: z.array(z.lazy(() => z.connect(docs))),
  }),
});
```

### Client

`createClient` takes a config and a LibSQL client. The returned object has one property per collection named after the collection, each with `findMany` and `findFirst`. An internal `_.` namespace holds `config`, `git`, `db`, and `logger`.

In development, tr33 auto-detects a local Git checkout by walking up from `cwd` to `.git`. In production it uses the GitHub remote or a remote Turso database. See [Configuration](./configuration.md).

## Minimal example

```ts
// lib/tr33.ts
import { createClient as libsql } from "@libsql/client";
import { createClient, defineConfig, z } from "tr33";

const authors = z.collection({
  name: "authors",
  match: "content/authors/**/*.md",
  schema: z.markdown({ name: z.filter(z.string()) }),
});

const docs = z.collection({
  name: "docs",
  match: "content/docs/**/*.md",
  schema: z.markdown({
    title: z.filter(z.string()),
    description: z.string().optional(),
    author: z.lazy(() => z.connect(authors)).optional(),
  }),
});

export const config = defineConfig({
  org: "jeffsee55",
  repo: "tr33",
  ref: "main",
  version: "1",
  collections: { authors, docs },
});

const database = libsql({ url: "file:./tr33.db" });
export const tr33 = createClient({ config, database });
```

```ts
// anywhere in your app
const { items } = await tr33.docs.findMany({
  where: { title: { eq: "Introduction" } },
  with: { author: true },
});
// items[0].author.name — fully typed, inferred from collections
```

Next: [Configuration](./configuration.md) to wire env and remotes, then [Querying](./querying.md) for the full query API.
