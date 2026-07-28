import { createClient as createLibsql } from "@libsql/client";
import { draftMode } from "next/headers";
import { wildwood as createWildwood, z } from "wildwood";
import { getBranch } from "wildwood/nextjs/branch";
import { ensureDraftModeFromBranchCookie } from "wildwood/nextjs/draft";

export const WILDWOOD_CONTENT_TAG = "wildwood:docs-content" as const;

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

/**
 * The one client. Bring your own DB driver — we construct the `@libsql/client`
 * here and hand it to `wildwood()`. On the production `libsql://` (Turso) path,
 * `createLibsql()` is lazy: construction does zero I/O and the connection opens
 * on first query, so this value is inert at module scope. On the local `file:`
 * fallback, `createLibsql()` opens the native handle eagerly at construction —
 * but that's build-safe: verified `next build` with `cacheComponents` from a
 * clean slate (deleted db) generates all static pages without touching the DB
 * at prerender time, because Wildwood's content is server-streamed (Partial
 * Prerender), not resolved into build-time HTML. The catch-all route layers
 * writes/auth via `createCMS`.
 *
 * Env vars stay explicit here. The single `github` object feeds both git
 * transport (blob fallback / on-the-fly builds) and CMS sign-in.
 */
export const wildwood = createWildwood({
  version: "1",
  collections: {
    authors,
    docs,
    nav,
  },
  database: createLibsql({
    url: process.env.TURSO_DATABASE_URL || "file:./wildwood-docs.db",
    ...(process.env.TURSO_AUTH_TOKEN ? { authToken: process.env.TURSO_AUTH_TOKEN } : {}),
  }),
  github: {
    type: "app",
    appId: process.env.GITHUB_APP_ID,
    privateKey: process.env.GITHUB_PRIVATE_KEY,
    installationId: process.env.GITHUB_APP_INSTALLATION_ID,
    clientId: process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET,
  },
});

export type RequestContext = { branch: string; isDraft: boolean };

/**
 * Request-scoped branch + draft state. Dynamic (reads cookies + draftMode), so
 * call it outside `"use cache"` and pass `{branch, isDraft}` into cached queries
 * as explicit args — that keeps the cache key branch-aware without pulling
 * dynamic APIs into the cached function.
 */
export async function getContext(): Promise<RequestContext> {
  // Re-enable draft mode if the branch cookie exists but draft mode was lost
  // (e.g. after a redeploy). The branch cookie is the source of truth.
  const fromBranchCookie = await ensureDraftModeFromBranchCookie(wildwood);

  let isDraft = false;
  try {
    isDraft = (await draftMode()).isEnabled;
  } catch {}

  // If draft mode is off but the branch cookie says we're in preview, trust
  // the branch cookie. This keeps the editing session sticky across redeploys.
  if (!isDraft && fromBranchCookie) {
    isDraft = true;
  }

  const branch = await getBranch(wildwood, { draftModeEnabled: isDraft });
  return { branch, isDraft };
}
