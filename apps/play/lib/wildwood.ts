import { createClient as libsqlCreateClient } from "@libsql/client";
import { createClient, defineConfig, type WildwoodClient, type WildwoodProviderConfig, z } from "wildwood";

import { type PlaygroundConfig, parsePlaygroundConfig } from "./playground-config";

// Only envs that should exist (per cleanup):
// TURSO_DATABASE_URL / TURSO_AUTH_TOKEN (Turso integration)
// GITHUB_CLIENT_ID / SECRET + GITHUB_APP_ID/PRIVATE_KEY etc (same App)
// BETTER_AUTH_SECRET, ALLOWED_EMAILS (route authenticate)
const libsqlClient = libsqlCreateClient({
  url: process.env.TURSO_DATABASE_URL?.trim() || "file:./wildwood.db",
  authToken: process.env.TURSO_AUTH_TOKEN?.trim() || "",
});

function githubAppProvider(): WildwoodProviderConfig["github"] {
  if (!process.env.GITHUB_APP_ID || !process.env.GITHUB_PRIVATE_KEY) return { type: "default" };
  return {
    type: "app",
    app: {
      appId: process.env.GITHUB_APP_ID,
      privateKey: process.env.GITHUB_PRIVATE_KEY,
      installationId: process.env.GITHUB_APP_INSTALLATION_ID?.trim() || undefined,
    },
  };
}

export function buildPlaygroundWildwood(config: PlaygroundConfig): WildwoodClient {
  const page = z.collection({
    name: "page",
    match: config.match,
    schema: config.contentType === "md" ? z.markdown() : z.json({}),
  });

  const wildwoodConfig =
    config.source === "github"
      ? defineConfig({ org: config.org, repo: config.repo, ref: config.ref, version: "0", collections: { page } })
      : defineConfig({
          org: config.org,
          repo: config.repo,
          ref: config.ref,
          localPath: config.localPath?.trim() ? config.localPath.trim() : undefined,
          version: "0",
          collections: { page },
        });

  return createClient({
    provider: { github: githubAppProvider(), authorize: () => true },
    config: wildwoodConfig,
    database: libsqlClient,
  });
}

export function getPlaygroundWildwood(cookies: { get(name: string): { value: string } | undefined }): WildwoodClient {
  return buildPlaygroundWildwood(parsePlaygroundConfig(cookies));
}

/** @deprecated */
export const buildPlaygroundTr33 = buildPlaygroundWildwood;
/** @deprecated */
export const getPlaygroundTr33 = getPlaygroundWildwood;
