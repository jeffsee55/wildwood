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

function isNextProductionBuild(): boolean {
  return process.env.NEXT_PHASE === "phase-production-build";
}

/** GitHub App remote only when installation is known (or explicitly forced). */
export function wantsGithubRemote(): boolean {
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

/** Use the git checkout under `content/` instead of the GitHub API. */
export function useLocalContentRoot(): boolean {
  if (process.env.TR33_DOCS_SOURCE === "local") {
    return true;
  }
  if (process.env.TR33_DOCS_SOURCE === "github") {
    return false;
  }
  if (!wantsGithubRemote()) {
    if (hasLocalDocsContent()) {
      return true;
    }
    if (isNextProductionBuild() || (process.env.VERCEL === "1" && process.env.CI === "1")) {
      return true;
    }
  }
  return (
    process.env.NODE_ENV !== "production" &&
    !process.env.GITHUB_APP_ID &&
    !process.env.TR33_DOCS_USE_GITHUB
  );
}

function resolveLocalDocsRef(): string {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA?.trim();
  if (sha) {
    return sha;
  }
  const configured = process.env.TR33_DOCS_LOCAL_REF?.trim();
  if (configured) {
    return configured;
  }
  return "HEAD";
}

function resolveDocsRef(local: boolean): string {
  if (local) {
    return resolveLocalDocsRef();
  }
  return process.env.TR33_DOCS_REF || "main";
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
const version = "docs-0";

function createDocsClient(): Tr33Client {
  const local = useLocalContentRoot();
  const ref = resolveDocsRef(local);
  const config = local
    ? defineConfig({
        org: githubOrg,
        repo: githubRepo,
        ref,
        localPath: resolveDocsRepoRoot(),
        version,
        collections,
      })
    : defineConfig({
        org: githubOrg,
        repo: githubRepo,
        ref,
        version,
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
    "(or set GITHUB_APP_INSTALLATION_ID / TR33_DOCS_SOURCE=local)."
  );
}
