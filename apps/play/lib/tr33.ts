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
 *
 * Zero-config local: an empty `localPath` now means "auto-detect from cwd" in dev,
 * because `tr33` core's `resolveLocalGitRoot` walks up from `process.cwd()` to `.git`.
 * An explicit non-empty `localPath` (absolute or cwd-relative) still wins when set.
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
      : defineConfig({
          org: config.org,
          repo: config.repo,
          ref: config.ref,
          // Empty => auto-detect via core. Non-empty => explicit path (core handles relative-to-cwd normalization).
          localPath: config.localPath?.trim() ? config.localPath.trim() : undefined,
          version: "0",
          collections: { page },
        });

  return createClient({
    auth: {
      github: githubAppAuthConfig(),
      betterAuth: auth,
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
