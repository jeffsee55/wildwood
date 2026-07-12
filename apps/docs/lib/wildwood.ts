import { createClient as createLibsqlClient } from "@libsql/client";
import { createClient, defineConfig, type WildwoodAuthConfig, z } from "wildwood";

// Docs app dogfoods this repo. Source is content/. No manual repo-root plumbing:
// `wildwood` auto-detects the git checkout from cwd in dev/build (via resolvedLocalPath).

const ORG = process.env.WILDWOOD_GITHUB_ORG || "jeffsee55";
const REPO = process.env.WILDWOOD_GITHUB_REPO || "wildwood";
const VERSION = "docs-1" as const;
const REF =
  process.env.WILDWOOD_DOCS_REF?.trim() ||
  process.env.VERCEL_GIT_COMMIT_SHA?.trim() ||
  "main";

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
  org: ORG,
  repo: REPO,
  ref: REF,
  version: VERSION,
  collections,
});

const gh = githubAuth();

const database = createLibsqlClient({
  url: process.env.WILDWOOD_DOCS_DATABASE_URL || "file:./wildwood-docs.db",
  authToken: process.env.WILDWOOD_DOCS_DATABASE_AUTH_TOKEN || "",
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
