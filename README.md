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

## Packages

| Package | npm | Purpose |
|---------|-----|---------|
| `wildwood` | [![npm](https://img.shields.io/npm/v/wildwood)](https://npmjs.com/package/wildwood) | Core: config, client, parser, Git remotes, Next handlers, React components |
| `wildwood-kit` | [![npm](https://img.shields.io/npm/v/wildwood-kit)](https://npmjs.com/package/wildwood-kit) | Client UI kit: toolbar, branch switcher, editing surface (shadow DOM) |
| `wildwood-shared` | [![npm](https://img.shields.io/npm/v/wildwood-shared)](https://npmjs.com/package/wildwood-shared) | Shared constants (cookies, channels), branch name generator |
| `wildwood-store` | [![npm](https://img.shields.io/npm/v/wildwood-store)](https://npmjs.com/package/wildwood-store) | Git object store, tree walker, merge logic |
| `wildwood-ui` | [![npm](https://img.shields.io/npm/v/wildwood-ui)](https://npmjs.com/package/wildwood-ui) | Base shadcn/ui primitives for kit |
| `wildwood-vscode` | extension | Bundled VS Code web extension (opencode adapter) |

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

This gives you:
- `GET /api/wildwood/query` — typed query endpoint
- `POST /api/wildwood/draft` / `POST /api/wildwood/preview` — draft mode + preview cookie
- `GET /api/git/*` + `/api/vscode/*` — worktree ops + VS Code web assets

Toolbar (branch switching + editing):

```tsx
// app/layout.tsx
import { WildwoodKit } from "wildwood/nextjs/kit";
import { wildwood } from "@/lib/wildwood";

export default function Root({ children }: { children: React.ReactNode }) {
  return (
    <html>
      <body>
        {children}
        <WildwoodKit wildwood={wildwood} />
      </body>
    </html>
  );
}
```

More in `content/docs/*` — this repo's own docs site is a Wildwood app dogfooding `content/docs/**/*.md`.

## Monorepo structure

```
apps/
  docs/   — docs site (this README's longer form), Next 16
  play/   — playground / configurator (zero-config local & GitHub)
packages/
  wildwood/          — core (exports wildwood, wildwood/nextjs/*, wildwood/react/*)
  kit/               — client kit (shadow DOM editor surface)
  ui/                — shadcn primitives
  shared/            — constants, cookie/channel names
  store/             — git object store + merge
  extension/         — VS Code extension (bundled into wildwood/bundled-extension/)
```

## Develop

```bash
pnpm install
pnpm run dev:web         # play app + kit watch + extension watch
pnpm run dev:docs        # docs app instead of play

# tests
pnpm run test:wildwood
pnpm run test:wildwood:watch
```

Requires Node 20+, pnpm 10+.

## Deploy

LibSQL local file for dev; Turso or `@libsql/client` URL for prod. Preview is just setting `x-wildwood-branch` cookie via `/api/wildwood/preview`. No extra preview infrastructure.

See `content/docs/deploy.md`.

## License

MIT © [Jeff See](https://github.com/jeffsee55)
