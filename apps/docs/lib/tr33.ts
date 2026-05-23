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

export const githubOrg = process.env.TR33_GITHUB_ORG || "jeffsee55";
export const githubRepo = process.env.TR33_GITHUB_REPO || "tr33";

const docsVersion = "docs-0";

/** `next build` — prefetch index into LibSQL/Turso from the repo checkout. */
export function isDocsPrefetchBuild(): boolean {
  return process.env.NEXT_PHASE === "phase-production-build";
}

/**
 * Deployed production (Vercel SSR/API). No git — only reads a build-time index.
 * Dev (`next dev`) is not included.
 */
export function isDocsDeployedRuntime(): boolean {
  if (isDocsPrefetchBuild()) {
    return false;
  }
  if (process.env.TR33_DOCS_SOURCE === "local") {
    return false;
  }
  return process.env.NODE_ENV === "production";
}

/** GitHub App remote for /api edits when installation is configured. */
export function wantsGithubRemote(): boolean {
  if (isDocsDeployedRuntime()) {
    if (process.env.TR33_DOCS_SOURCE === "github") {
      return Boolean(process.env.GITHUB_APP_ID && process.env.GITHUB_PRIVATE_KEY);
    }
    return Boolean(
      process.env.GITHUB_APP_ID &&
        process.env.GITHUB_PRIVATE_KEY &&
        process.env.GITHUB_APP_INSTALLATION_ID?.trim(),
    );
  }
  if (process.env.TR33_DOCS_SOURCE === "local") {
    return false;
  }
  if (process.env.TR33_DOCS_SOURCE === "github") {
    return Boolean(process.env.GITHUB_APP_ID && process.env.GITHUB_PRIVATE_KEY);
  }
  return Boolean(
    process.env.GITHUB_APP_ID &&
      process.env.GITHUB_PRIVATE_KEY &&
      process.env.GITHUB_APP_INSTALLATION_ID?.trim(),
  );
}

/** Local git checkout for dev and build prefetch only. */
export function useLocalContentRoot(): boolean {
  if (isDocsDeployedRuntime()) {
    return false;
  }
  if (process.env.TR33_DOCS_SOURCE === "github") {
    return false;
  }
  if (process.env.TR33_DOCS_SOURCE === "local") {
    return true;
  }
  if (isDocsPrefetchBuild() || hasLocalDocsContent()) {
    return true;
  }
  return (
    process.env.NODE_ENV !== "production" &&
    !process.env.GITHUB_APP_ID &&
    !process.env.TR33_DOCS_USE_GITHUB
  );
}

/**
 * Ref key stored in `_refs` — must match between build prefetch and production reads.
 * On Vercel, defaults to the deployment commit so local git does not need `main`.
 */
export function resolveDocsIndexRef(): string {
  const configured = process.env.TR33_DOCS_REF?.trim();
  if (configured) {
    return configured;
  }
  const vercelSha = process.env.VERCEL_GIT_COMMIT_SHA?.trim();
  if (vercelSha) {
    return vercelSha;
  }
  return "main";
}

function githubAppAuthConfig(): Tr33AuthConfig["github"] | undefined {
  if (
    !wantsGithubRemote() ||
    !process.env.GITHUB_APP_ID ||
    !process.env.GITHUB_PRIVATE_KEY
  ) {
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

function createDocsClient(): Tr33Client {
  const local = useLocalContentRoot();
  const indexRef = resolveDocsIndexRef();

  const config = local
    ? defineConfig({
        org: githubOrg,
        repo: githubRepo,
        ref: indexRef,
        localPath: resolveDocsRepoRoot(),
        version: docsVersion,
        collections,
      })
    : defineConfig({
        org: githubOrg,
        repo: githubRepo,
        ref: indexRef,
        version: docsVersion,
        collections,
      });

  const githubAuth = githubAppAuthConfig();

  return createClient({
    auth: githubAuth
      ? {
          github: githubAuth,
          authorize: () => true,
        }
      : undefined,
    config,
    database,
  });
}

let docsClient: Tr33Client | null = null;

export function getDocsTr33(): Tr33Client {
  if (!docsClient) {
    docsClient = createDocsClient();
  }
  return docsClient;
}

export function githubInstallHint(): string {
  return (
    `Install the GitHub App on https://github.com/${githubOrg}/${githubRepo} ` +
    "(or set GITHUB_APP_INSTALLATION_ID)."
  );
}

export function docsIndexVersion(): string {
  return docsVersion;
}
