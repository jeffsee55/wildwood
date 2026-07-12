# Contributing

## Requirements

- Node 20+
- pnpm 10+ (`corepack enable` if needed)
- Git

## Setup

```bash
pnpm install
```

## Monorepo layout

```
apps/
  docs/   — docs site (Next 16), eats own content/docs/**/*.md
  play/   — playground / configurator, zero-config local & GitHub remote
packages/
  wildwood/           — core: config, client, parser, git remotes, Next handlers, React
  kit/                — client UI kit (shadow DOM, toolbar, branch switcher)
  ui/                 — shadcn/ui primitives used by kit
  shared/             — constants: cookies, broadcast channels, branch name generator
  store/              — git object store, tree walker, merge
  extension/          — VS Code extension source, built & bundled into wildwood/bundled-extension/
  wildwood/bundled-extension/ — generated, committed artifact for Editor CDN
```

## Dev scripts (from repo root)

```bash
pnpm run dev:web         # play app + kit watch + extension watch + studio:play
pnpm run dev:docs        # docs app instead of play (same watchers)
pnpm run dev:vscode-playground  # wildwood core playground.ts + studio
pnpm run dev:web-play    # alias for dev:web

pnpm run test:wildwood
pnpm run test:wildwood:watch

pnpm run studio:wildwood # drizzle-kit studio for wildwood core
pnpm run studio:web-db   # studio for play app DB (apps/play/wildwood.db)

pnpm build               # turbo build all
pnpm lint                # turbo lint
```

### Package-level

Each package also has its own scripts:

- `packages/wildwood`: `pnpm run dev` (tsdown watch), `pnpm run build`, `vitest run`, playground `srvx ./playground.ts`
- `packages/kit`: `vite` dev server, `tsdown` lib build (bundles tailwind inline)
- `packages/ui`: tsdown build, vite playground at `packages/ui/playground/`
- `packages/extension`: `tsdown` + `build.mjs` bundles extension.js into `public/`
- `packages/store`, `packages/shared`: tsdown

## Architecture notes

- Content lives in Git. DB (LibSQL/Turso) is a derived index of filters, entries, connections. Rebuildable.
- `z.collection({ name, match, schema })` — `name` is identity in `wildwood.[name]`, `match` is minimatch glob, schema is `z.markdown()` or `z.json()`.
- `z.filter()` marks queryable fields, `z.connect()` declares file-path relations (canonicalized, indexed).
- Query types are inferred — no codegen. `FindTypes` walks Zod wrappers (lazy/optional/array/pipe/union/codec) to collect filters + connections.
- Git remotes: `NativeRemote` (local checkout, `.git` direct) in dev/build, GitHub App remote (`@octokit/rest`, `@octokit/graphql`) in prod for reads+writes.
- Next integration: `createWildwoodRoute(() => wildwood)` mounts H3 handler. Route factory owns `x-wildwood-branch` cookie + `revalidateTag(WILDWOOD_CACHE_TAG)` on mutations. `draftMode()` bypasses `"use cache"` per-user.
- Kit toolbar is an async Server Component → `ClientKitBoundary` (`ssr:false` + shadow DOM portal) to avoid `useRef of null` RSC crash.
- Broadcast channels (`@wildwood/shared`) sync branch between Kit page, extension host iframe, and embedded VS Code web shell.

## Tests

```bash
pnpm --filter wildwood run test              # vitest run, ~12 suites
pnpm --filter wildwood run test:watch        # watch mode
```

- `_git-test-helper.ts` / `_github-test-helper.ts` scaffold temp repos / GitHub test remotes.
- Fixtures in `packages/wildwood/src/tests/fixtures/` are snapshots of indexed content (safe to ignore for rebrand).
- `tr33-mono` strings in test package.json mocks are legacy; safe to migrate to `wildwood-mono` in bulk.

## DB / indexing

```bash
pnpm --filter wildwood run export    # drizzle-kit export → scripts/sql-to-json
pnpm --filter wildwood run studio    # drizzle studio default config (sqlite)
```

- `drizzle.sqlite.ts`, `drizzle.app.ts`, `drizzle.play.ts` target different DBs.
- Local DB lives at `wildwood.db` (root) or `apps/docs/wildwood-docs.db` / `apps/play/wildwood.db`. `.gitignore`d.

## Convention

- Use `pnpm` everywhere. No npm/yarn.
- `type: module` — ESM only.
- Zod v4 (`zod@4.1.1`). `defineConfig` captures `Colls` literal for inference — don't widen collections.
- Internal markers: prefer `__wildwoodFilter` / `__wildwoodConnection`. Legacy `__tr33*` still accepted for compat decode — keep dual until 1.0.
- Cookie/channel constants live in `packages/shared/src/index.ts`. All packages should import from there, not hardcode.
- Never import `wildwood/nextjs/play-auth` or `better-sqlite3` inside a `'use client'` chunk boundary — Turbopack will merge it and emit `node:module` errors. Keep `playground-json-client.tsx` pure client.

## Releasing

`wildwood` currently `0.1.0` across all publishable packages (workspace `*`). Publishing uses:

```bash
pnpm publish -r # or per-package with npm provenance, via `publishConfig: { access: public }`
```

Until `1.0`, breaking changes to internal marker names / cookie fallbacks are okay if `@deprecated` aliases remain.

## PR / Commit

- Conventional commits preferred (`feat:`, `fix:`, `docs:`, `chore:`).
- Keep docs changes in `content/docs/*.md` — docs site auto-indexes them.
- If you change collection shape, bump `version` in `defineConfig` in affected app so index rebuilds.
