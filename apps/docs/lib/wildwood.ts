import { createClient as createLibsqlClient } from "@libsql/client";
import { draftMode } from "next/headers";
import { createClient, defineConfig, z } from "wildwood";
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

export const config = defineConfig({
  version: "1",
  collections: {
    authors,
    docs,
    nav,
  },
});

function createDatabase() {
  return createLibsqlClient({
    url: process.env.TURSO_DATABASE_URL || "file:./wildwood-docs.db",
    authToken: process.env.TURSO_AUTH_TOKEN || "",
  });
}

/**
 * Full client — provider + db. Used by the catch-all route (mutations) and the
 * Toolbar. Holds a non-serializable LibSQL client, so DO NOT reference it inside
 * a `"use cache"` function (Turbopack hashes the closure → "id must be string").
 */
export const wildwood = createClient({
  provider: {
    github: {
      type: "app",
      app: {
        appId: process.env.GITHUB_APP_ID,
        privateKey: process.env.GITHUB_PRIVATE_KEY,
        installationId: process.env.GITHUB_APP_INSTALLATION_ID,
      },
    },
  },
  config,
  database: createDatabase(),
});

/**
 * Read-only client for `"use cache"` queries. Reuses the shared `config` (no
 * schema duplication) but builds a fresh db-only client at call time, so the
 * cached function never closes over a non-serializable value. Reads never hit
 * Git — the index in Turso/LibSQL is the source.
 *
 * Call this INSIDE a cached function, not at module scope.
 */
export function createReadClient() {
  return createClient({ config, database: createDatabase() });
}

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
