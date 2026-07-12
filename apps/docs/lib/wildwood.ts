import { createClient as createLibsqlClient } from "@libsql/client";
import { createClient, defineConfig, type WildwoodAuthConfig, z } from "wildwood";

// Docs app dogfoods this repo. Source is content/. Zero-config in dev (git remote)
// and on Vercel (VERCEL_GIT_REPO_OWNER/SLUG/REF system envs). No WILDWOOD_GITHUB_*
// env vars required — but they still win when set.
//
// `org`/`repo`/`ref`/`origin` are intentionally omitted: `defineConfig` now
// auto-resolves from:
//   1. explicit args (if you pass them)
//   2. WILDWOOD_* overrides
//   3. VERCEL_GIT_* system envs (zero-config on Vercel, when "Enable access to
//      System Environment Variables" is checked in project settings)
//   4. local git remote (zero-config in dev)
// `ref` also falls back to VERCEL_GIT_COMMIT_SHA for immutable deploys.

const VERSION = "docs-1" as const;

// ── collections ──────────────────────────────────────────────────────
// `docs` first so nav can lazily connect to it without TDZ.

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

// ── client (top-level singleton) ─────────────────────────────────────
// Why not memoized inside `wildwood` package? `createClient` receives an already-
// constructed LibSQL client; memoizing on outside-built objects would require
// stable keying of (config, database instance, auth) and hide env edges that
// differ per process (Vercel build vs runtime, WILDWOOD_DOCS_DATABASE_URL switch).
// Simpler: the docs app owns the one singleton. Next reuses the module across
// requests; cold-cache self-heals via findMany -> switch -> index.
//
// Intentionally exported as a value, not a getDocsWildwood() getter — callers just
// `import { wildwood } from "@/lib/wildwood"` with no ceremony.

const config = defineConfig({
  // org/repo/ref intentionally omitted — auto-resolved from Vercel system envs
  // or git remote. See env.ts for priority: explicit > WILDWOOD_* > VERCEL_GIT_* > git remote.
  version: VERSION,
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
