import { draftMode } from "next/headers";
import { wildwood as createWildwood, z } from "wildwood";
import { getBranch } from "wildwood/nextjs/branch";

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
 * The one client. `wildwood()` returns a read client whose live handles (LibSQL,
 * Octokit) are built lazily on first query — so this module-scope value is safe
 * to reference inside `"use cache"` (no non-serializable closure, no separate
 * read-only client). The catch-all route layers writes/auth via `createCMS`.
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
  database: {
    url: process.env.TURSO_DATABASE_URL || "file:./wildwood-docs.db",
    authToken: process.env.TURSO_AUTH_TOKEN,
  },
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
  let isDraft = false;
  try {
    isDraft = (await draftMode()).isEnabled;
  } catch {}

  const branch = await getBranch(wildwood, { draftModeEnabled: isDraft });
  return { branch, isDraft };
}
