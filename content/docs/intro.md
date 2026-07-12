---
title: Introduction
author: ../authors/jeff.md
description: Git as your content store — typed, versioned, branchable. This site is this repo's content/ folder rendered through Tr33.
---

# Introduction

Tr33 treats your Git repo as the CMS. Markdown and JSON files in `content/` are indexed into a typed collection API; edits go through a shared H3/HTTP surface that powers both Kit's floating editor and your own API routes.

This docs app is the canonical example. The source is `jeffsee55/tr33`, `content/docs/**/*.md` — the same repo you are browsing.

## Surface

```ts
import { createClient, defineConfig, z } from "tr33";
import { createClient as libsql } from "@libsql/client";

const docs = z.collection({
  name: "docs",
  match: "content/docs/**/*.md",
  schema: z.markdown({
    title: z.filter(z.string()),
    description: z.string().optional(),
    author: z.lazy(() => z.connect(authors)).optional(),
  }),
});

const config = defineConfig({
  org: "jeffsee55",
  repo: "tr33",
  ref: "main",
  // localPath points at this repo in dev / build prefetch.
  localPath: process.cwd(),
  version: "docs-0",
  collections: { docs },
});

const database = libsql({ url: "file:./tr33-docs.db" });
const tr33 = createClient({ config, database });

// Works against any ref (branch). `ref` falls back to config.ref.
const all = await tr33.docs.findMany({});
const byTitle = await tr33.docs.findMany({
  where: { title: { eq: "Introduction" } },
});
```

## API handler (framework-agnostic)

`handle()` is a pure Fetch handler. It never imports `next/*`. The host owns cookies and `revalidateTag`:

```ts
// apps/docs/app/api/[...path]/route.ts
import { handle, activeRefSetCookieHeader } from "tr33/nextjs";

const api = handle(getDocsTr33());

export const GET  = (req: Request) => api(req);
export const POST = async (req: Request) => {
  const res = await api(req);
  // set tr33-active-ref cookie on branch create/switch, clear on preview exit
  // call revalidateTag("docs-content") after mutations — host-owned
  return res;
};
```

## Branch preview

Switching branches or creating a branch sets a `tr33-active-ref` cookie. The docs app reads it on the server (`resolveActiveRef`) and feeds it to `Toolbar`:

```ts
import { cookies } from "next/headers";
import { resolveActiveRef, Toolbar } from "tr33/nextjs";

const cookieStore = await cookies();
const activeRef = resolveActiveRef({ tr33, cookies: cookieStore });

<Toolbar tr33={tr33} activeRef={activeRef} apiBase="/api" />
```

This is the full loop we dogfood: local repo as source, typed queries, H3 API, Kit toolbar — no hidden Next wrapper in the library.

See also: [API](./api.md) and [Guides](./guides.md).
