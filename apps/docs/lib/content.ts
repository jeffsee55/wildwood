/**
 * Cached content loaders — the only place pages should read content.
 *
 * Lifecycle (see branching.md):
 * - All reads go through `"use cache"` + `cacheTag(WILDWOOD_CONTENT_TAG)`.
 * - `branch` and `isDraft` are resolved in the outer page/layout (dynamic APIs:
 *   `getBranch` → `cookies()`, `draftMode().isEnabled`) and passed as args so the
 *   cache key is `{branch, isDraft, tag, slug}` — no dynamic APIs inside the cached fn.
 * - Non-draft: shared Data Cache, TTL `hours`, revalidated by `revalidateTag` in the
 *   catch-all `api/[...path]` on commit/discard/merge/pull/create|switch-branch.
 * - Draft: `isDraft=true` (derived from `draftMode()` outside) still writes a separate
 *   cache entry per branch, but Next's per-user bypass via `__prerender_bypass` means
 *   a draft user never reads the production entry and enabling draft doesn't purge everyone.
 *   We keep it simple: branch-scoped keys + tag-based purge on real mutations.
 *
 * Why branch is an arg:
 * Next 16 disallows `cookies()`/`draftMode()` inside `"use cache"` (static analysis).
 * Moving them outside makes cache keys explicit and avoids the "id must be string" worker crash.
 */

import { createClient as createLibsqlClient } from "@libsql/client";
import { cacheLife, cacheTag } from "next/cache";
import { createClient, defineConfig, z } from "wildwood";
import { WILDWOOD_CONTENT_TAG, config as appConfig } from "./wildwood";

// IMPORTANT: `"use cache"` fns must not close over the shared `wildwood` client from
// `lib/wildwood.ts` because that client holds `LibsqlClient` (non-serializable) and
// Turbopack's build worker tries to hash it for the cache key → "id must be string".
// Instead each cached fn builds a tiny read-only client whose closure is only
// {config, collections}. The underlying LibSQL client is created from env at call time.
// Routes/mutations still use the singleton from `lib/wildwood.ts`.

function buildReadOnlyClient() {
  // Collections must mirror `lib/wildwood.ts` so cache read matches writes.
  // Tiny duplication is intentional — keeps cached module free of Toolbar/better-auth imports.
  const navShape = z.object({
    name: z.filter(z.string()),
    label: z.string(),
    children: z.array(z.lazy(() => z.connect(z.collection({ name: "docs", match: "", schema: z.json({}) })))), // shim, real connect resolved at index-time
  });

  const authors = z.collection({
    name: "authors",
    match: "content/authors/**/*.md",
    schema: z.markdown({
      name: z.filter(z.string()),
      avatar: z.string().optional(),
    }),
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

  const nav = z.collection({
    name: "nav",
    match: "content/nav/**/*.json",
    schema: z.json({
      name: z.filter(z.string()),
      label: z.string(),
      children: z.array(z.lazy(() => z.connect(docs))),
    }),
  });

  const cfg = defineConfig({
    version: appConfig.version,
    collections: { authors, docs, nav },
  });

  const db = createLibsqlClient({
    url: process.env.TURSO_DATABASE_URL || "file:./wildwood-docs.db",
    authToken: process.env.TURSO_AUTH_TOKEN || "",
  });

  // No provider needed for reads — Git is not hit when index exists (which it does in prod build).
  // In dev the first read may hit Turso/remote, but db-only client is fine.
  return createClient({ config: cfg, database: db });
}

// ---------------------------------------------------------------------------
// nav
// ---------------------------------------------------------------------------

export async function getCachedNav(opts: { branch: string; isDraft: boolean }) {
  "use cache";
  cacheLife("hours");
  cacheTag(WILDWOOD_CONTENT_TAG, `wildwood:branch:${opts.branch}`);

  const ww = buildReadOnlyClient();
  return ww.nav.findMany({
    ref: opts.branch,
    with: { children: true },
  });
}

export async function getCachedNavOrNull(opts: { branch: string; isDraft: boolean }) {
  const res = await getCachedNav(opts);
  return res.items[0] ?? null;
}

// ---------------------------------------------------------------------------
// docs list
// ---------------------------------------------------------------------------

export async function getCachedDocsList(opts: { branch: string; isDraft: boolean }) {
  "use cache";
  cacheLife("hours");
  cacheTag(WILDWOOD_CONTENT_TAG, `wildwood:branch:${opts.branch}`);

  const ww = buildReadOnlyClient();
  return ww.docs.findMany({ ref: opts.branch });
}

// ---------------------------------------------------------------------------
// single doc
// ---------------------------------------------------------------------------

export async function getCachedDoc(opts: { slug: string; branch: string; isDraft: boolean }) {
  "use cache";
  cacheLife("hours");
  cacheTag(WILDWOOD_CONTENT_TAG, `wildwood:branch:${opts.branch}`, `wildwood:doc:${opts.slug}`);

  const ww = buildReadOnlyClient();
  return ww.docs.findFirst({
    ref: opts.branch,
    where: { slug: opts.slug },
    with: { author: true },
  });
}
