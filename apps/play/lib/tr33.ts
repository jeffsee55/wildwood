import { createClient as libsqlCreateClient } from "@libsql/client";
import {
  createClient,
  defineConfig,
  type Tr33AuthConfig,
  type Tr33Client,
  z,
} from "tr33";

import { auth } from "./auth";
import {
  type PlaygroundConfig,
  parsePlaygroundConfig,
} from "./playground-config";
import { playgroundDatabaseUrl } from "./playground-database-url";
import {
  assertUsableLocalGitRoot,
  resolvePlaygroundLocalPath,
} from "./resolve-playground-local-path";

const libsqlClient = libsqlCreateClient({
  url: playgroundDatabaseUrl(),
  authToken: process.env.TURSO_AUTH_TOKEN || "",
});

function githubAppAuthConfig(): Tr33AuthConfig["github"] {
  if (!process.env.GITHUB_APP_ID || !process.env.GITHUB_PRIVATE_KEY) {
    return { type: "default" };
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

/**
 * One schemaless collection, always named `page` — the playground controls org/repo/ref/match + md/json.
 */
export function buildPlaygroundTr33(config: PlaygroundConfig): Tr33Client {
  const page = z.collection({
    name: "page",
    match: config.match,
    schema: config.contentType === "md" ? z.markdown() : z.json({}),
  });

  const tr33Config =
    config.source === "github"
      ? defineConfig({
          org: config.org,
          repo: config.repo,
          ref: config.ref,
          version: "0",
          collections: { page },
        })
      : (() => {
          const localRoot = resolvePlaygroundLocalPath(config.localPath);
          assertUsableLocalGitRoot(localRoot);
          return defineConfig({
            org: config.org,
            repo: config.repo,
            ref: config.ref,
            localPath: localRoot,
            version: "0",
            collections: { page },
          });
        })();

  return createClient({
    auth: {
      github: githubAppAuthConfig(),
      betterAuth: auth,
      // Play is intentionally permissive while we iterate on auth policy.
      authorize: () => true,
    },
    config: tr33Config,
    database: libsqlClient,
  });
}

export function getPlaygroundTr33(cookies: {
  get(name: string): { value: string } | undefined;
}): Tr33Client {
  return buildPlaygroundTr33(parsePlaygroundConfig(cookies));
}
