import { createClient as createLibsqlClient } from "@libsql/client";
import {
  createClient,
  defineConfig,
  z,
} from "wildwood";

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

const config = defineConfig({ version: "1", collections });

const database = createLibsqlClient({
  url: process.env.TURSO_DATABASE_URL?.trim() || "file:./wildwood-docs.db",
  authToken: process.env.TURSO_AUTH_TOKEN?.trim() || "",
});

// All optional — `createClient` accepts `any` here so docs scaffold typechecks
// even when env vars are absent. Runtime still enforces when actually needed for git ops.
const _wildwoodClient: any = (createClient as unknown as (a: unknown) => unknown)({
  provider: {
    github: {
      type: "app" as const,
      app: {
        appId: process.env.GITHUB_APP_ID?.trim() || undefined,
        privateKey: process.env.GITHUB_PRIVATE_KEY?.trim() || undefined,
        installationId: process.env.GITHUB_APP_INSTALLATION_ID?.trim() || undefined,
      },
    },
  },
  config: config as unknown as never,
  database: database as unknown as never,
});

export const wildwood: any = _wildwoodClient;

export type WildwoodClient = typeof wildwood;

/** @deprecated use `wildwood` */
export const tr33 = wildwood;
