import { createClient as createLibsqlClient } from "@libsql/client";
import { createClient, defineConfig, type WildwoodAuthConfig, z } from "wildwood";

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
    // Real relation: nav.children are docs. JSON is string[] paths on disk;
    // the visitor canonicalizes to content/docs/<slug>.md and relation resolves.
    children: z.array(z.lazy(() => z.connect(docs))),
  }),
});

export const collections = { authors, docs, nav } as const;

function githubAuth(): WildwoodAuthConfig["github"] | undefined {
  const appId = process.env.GITHUB_APP_ID?.trim();
  const privateKey = process.env.GITHUB_PRIVATE_KEY?.trim();
  if (!appId || !privateKey) return undefined;
  return {
    type: "app",
    app: {
      appId,
      privateKey,
      installationId: process.env.GITHUB_APP_INSTALLATION_ID?.trim(),
    },
  };
}

const config = defineConfig({
  version: '1',
  collections,
});

const gh = githubAuth();

function resolveDatabaseUrl(): string {
  return (
    process.env.WILDWOOD_DOCS_DATABASE_URL?.trim() ||
    process.env.TURSO_DATABASE_URL?.trim() ||
    process.env.LIBSQL_URL?.trim() ||
    "file:./wildwood-docs.db"
  );
}
function resolveAuthToken(): string {
  return (
    process.env.WILDWOOD_DOCS_DATABASE_AUTH_TOKEN?.trim() ||
    process.env.TURSO_AUTH_TOKEN?.trim() ||
    process.env.LIBSQL_AUTH_TOKEN?.trim() ||
    ""
  );
}

const database = createLibsqlClient({
  url: resolveDatabaseUrl(),
  authToken: resolveAuthToken(),
});

export const wildwood = createClient({
  auth: gh ? { github: gh, authorize: () => true } : undefined,
  config,
  database,
});

export type WildwoodClient = typeof wildwood;

// Back-compat alias
/** @deprecated use `wildwood` */
export const tr33 = wildwood;
