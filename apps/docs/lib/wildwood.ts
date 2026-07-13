import { createClient as createLibsqlClient } from "@libsql/client";
import { createClient, defineConfig, z } from "wildwood";

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

const config = defineConfig({
  version: "1", collections: {
   authors, docs, nav
} });

const database = createLibsqlClient({
  url: process.env.TURSO_DATABASE_URL || "file:./wildwood-docs.db",
  authToken: process.env.TURSO_AUTH_TOKEN || "",
});

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
  database,
});
