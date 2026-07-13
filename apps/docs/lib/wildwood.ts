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

/**
 * GitHub Auth: single credential set happy path.
 * The manifest flow returns GITHUB_APP_ID, GITHUB_PRIVATE_KEY, GITHUB_CLIENT_ID,
 * GITHUB_CLIENT_SECRET, GITHUB_APP_SLUG from ONE conversion. The App's own
 * client_id/client_secret doubles as the OAuth app credentials — no second
 * OAuth App needed. Additional OAuth providers (Google, etc) remain
 * configurable via host's Better Auth config via oauth.providers.
 *
 * Here we only wire the GitHub App for git writes; the OAuth credential reuse
 * for Better Auth happens in createWildwoodPlayAuth / host auth route that
 * reads the same GITHUB_CLIENT_ID/_SECRET env (same 5-var set).
 */
export const wildwood = createClient({
  auth: gh
    ? {
        github: gh,
        // The same GITHUB_CLIENT_ID/_SECRET from the App manifest can be used
        // by Better Auth's github provider for user sign-in — no separate OAuth App.
        betterAuth: undefined,
        authorize: () => true,
      }
    : undefined,
  config,
  database,
});

export type WildwoodClient = typeof wildwood;

// Back-compat alias
/** @deprecated use `wildwood` */
export const tr33 = wildwood;
