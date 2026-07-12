# Wildwood

Git-native content layer for Next.js. Markdown + JSON in `content/`, typed with Zod, stored in Git. Database is a derived index.

```
content/authors/jeff.md  →  wildwood.authors.findMany()
content/docs/*.md        →  wildwood.docs.findMany({ with: { author: true } })
branches                 →  preview cookies (x-wildwood-branch)
```

No external CMS. Git is the CMS.

## Why

Most CMSs add a separate DB, auth, editor, and deploy for content. Wildwood collapses it:

- **Content lives in Git** — review, diff, revert, branch normally
- **DB is derived** — LibSQL/Turso index of filters + connections, rebuilt from Git if lost
- **Edits are Git ops** — write blobs, update trees, commit via local checkout or GitHub API
- **Preview is a branch** — `x-wildwood-branch` cookie → queries target ref. No preview infra.
- **Types from Zod** — `z.collection()`, `z.markdown()`, `z.json()`, `z.filter()`, `z.connect()`

## Quick start

```bash
pnpm add wildwood @libsql/client
```

```ts
// lib/wildwood.ts
import { createClient as libsql } from "@libsql/client";
import { createClient, defineConfig, z } from "wildwood";

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
  repo: "wildwood",
  ref: "main",
  version: "1",
  collections: { authors, docs },
});

const database = libsql({ url: "file:./wildwood.db" });
export const wildwood = createClient({ config, database });
```

```ts
// app/docs/[slug]/page.tsx
import { wildwood } from "@/lib/wildwood";

export default async function Page({ params }: { params: { slug: string } }) {
  const { items: [doc] } = await wildwood.docs.findMany({
    where: { slug: { eq: params.slug } },
    with: { author: true },
  });
  return <article>{doc.title} — {doc.author?.name}</article>;
}
```

## Next.js integration

```ts
// app/api/[...path]/route.ts
import { createWildwoodRoute } from "wildwood/nextjs/route";
import { wildwood } from "@/lib/wildwood";

export const { GET, POST, PATCH, DELETE } = createWildwoodRoute(() => wildwood);
```

This mounts:
- `/api/wildwood/query` — typed query
- `/api/wildwood/draft` + `/api/wildwood/preview` — draft mode + branch cookie
- `/api/git/*` + `/api/vscode/*` — worktree ops + VS Code web shell

```tsx
// app/layout.tsx
import { WildwoodKit } from "wildwood/nextjs/kit";
import { wildwood } from "@/lib/wildwood";

export default function Root({ children }: { children: React.ReactNode }) {
  return <html><body>{children}<WildwoodKit wildwood={wildwood} /></body></html>;
}
```

More in [`content/docs/*`](content/docs/intro.md) — this repo's own docs site dogfoods `content/docs/**/*.md`.

## Deploy

Local file for dev, Turso for prod. Preview is just `x-wildwood-branch`. No extra infra.

For the docs app's opinionated production setup (Turso + GitHub App), see [apps/docs – Production](apps/docs/README.md#production). The general pattern is documented in [content/docs/deploy.md](content/docs/deploy.md).

## License

MIT © [Jeff See](https://github.com/jeffsee55)
