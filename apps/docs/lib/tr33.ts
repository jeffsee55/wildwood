import {
  createClient,
  defineConfig,
  type Tr33AuthConfig,
  type Tr33Client,
  z,
} from "tr33";
import { createClient as createLibsqlClient } from "@libsql/client";

import { hasLocalDocsContent, resolveDocsRepoRoot } from "./docs-repo-root";

const database = createLibsqlClient({
  url: process.env.TR33_DOCS_DATABASE_URL || "file:./tr33-docs.db",
  authToken: process.env.TR33_DOCS_DATABASE_AUTH_TOKEN || "",
});

const githubOrg = process.env.TR33_GITHUB_ORG || "jeffsee55";
const githubRepo = process.env.TR33_GITHUB_REPO || "tr33";
const docsRef = process.env.TR33_DOCS_REF || "main";

function isNextProductionBuild(): boolean {
  return process.env.NEXT_PHASE === "phase-production-build";
}

/**
 * Local git checkout: dev, `next build` (content is in the repo), and Vercel build.
 * GitHub App remote: production runtime on Vercel when app credentials are set.
 */
export function useLocalContentRoot(): boolean {
  if (process.env.TR33_DOCS_SOURCE === "local") {
    return true;
  }
  if (process.env.TR33_DOCS_SOURCE === "github") {
    return false;
  }
  if (isNextProductionBuild() && hasLocalDocsContent()) {
    return true;
  }
  return (
    process.env.NODE_ENV !== "production" &&
    !process.env.GITHUB_APP_ID &&
    !process.env.TR33_DOCS_USE_GITHUB
  );
}

function githubAppAuthConfig(): Tr33AuthConfig["github"] | undefined {
  if (useLocalContentRoot() || !process.env.GITHUB_APP_ID || !process.env.GITHUB_PRIVATE_KEY) {
    return undefined;
  }
  return {
    type: "app",
    app: {
      appId: process.env.GITHUB_APP_ID,
      privateKey: process.env.GITHUB_PRIVATE_KEY,
      installationId: process.env.GITHUB_APP_INSTALLATION_ID,
    },
  };
}

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
    children: z.array(z.string()),
  }),
});

const collections = { authors, docs, nav };
const version = "docs-0";

const config = useLocalContentRoot()
  ? defineConfig({
      org: githubOrg,
      repo: githubRepo,
      ref: docsRef,
      localPath: resolveDocsRepoRoot(),
      version,
      collections,
    })
  : defineConfig({
      org: githubOrg,
      repo: githubRepo,
      ref: docsRef,
      version,
      collections,
    });

const githubAuth = githubAppAuthConfig();

export const tr33 = createClient({
  auth: githubAuth
    ? {
        github: githubAuth,
        authorize: () => true,
      }
    : undefined,
  config,
  database,
}) satisfies Tr33Client;

export function getDocsTr33(): Tr33Client {
  return tr33;
}
