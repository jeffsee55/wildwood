import { createClient as createLibsqlClient } from "@libsql/client";
import { createClient, defineConfig, type WildwoodProviderConfig, z } from "wildwood";

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

export const collections = { authors, docs, nav } as const;

function githubProvider(): WildwoodProviderConfig["github"] | undefined {
  const appId = process.env.GITHUB_APP_ID?.trim();
  const privateKey = process.env.GITHUB_PRIVATE_KEY?.trim();
  if (!appId || !privateKey) return undefined;
  return {
    type: "app",
    app: { appId, privateKey, installationId: process.env.GITHUB_APP_INSTALLATION_ID?.trim() || undefined },
  };
}

// On Vercel, org/repo from VERCEL_GIT_REPO_{OWNER,SLUG} — no WILDWOOD_GITHUB_* needed.
const config = defineConfig({ version: "1", collections });

const gh = githubProvider();

// Only envs that should exist per your Vercel cleanup:
// - TURSO_DATABASE_URL / TURSO_AUTH_TOKEN (from Turso integration)
// - GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET (OAuth, same App)
// - GITHUB_APP_ID / GITHUB_PRIVATE_KEY / GITHUB_APP_INSTALLATION_ID (git writes)
// - BETTER_AUTH_SECRET
// - ALLOWED_EMAILS (parsed in route's authenticate, not inside wildwood)
const database = createLibsqlClient({
  url: process.env.TURSO_DATABASE_URL?.trim() || "file:./wildwood-docs.db",
  authToken: process.env.TURSO_AUTH_TOKEN?.trim() || "",
});

export const wildwood = createClient({
  // `provider` is preferred — `auth` still works as deprecated alias.
  // When route has `auth: { github: true }`, it reuses the same App creds for OAuth.
  provider: gh ? { github: gh, authorize: () => true } : { authorize: () => true },
  config,
  database,
});

export type WildwoodClient = typeof wildwood;

/** @deprecated use `wildwood` */
export const tr33 = wildwood;
