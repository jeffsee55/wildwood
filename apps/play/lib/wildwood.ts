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

function githubAppProvider(): WildwoodProviderConfig["github"] | undefined {
  const appId = process.env.GITHUB_APP_ID?.trim();
  const privateKey = process.env.GITHUB_PRIVATE_KEY?.trim();
  // undefined = not configured → remote falls back to default (gh CLI in dev, error in prod)
  if (!appId || !privateKey) return undefined;
  return {
    type: "app",
    app: {
      appId,
      privateKey,
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

  // All optional config surfaces — defineConfig tolerates missing org/repo during scaffolding/typecheck
  const wildwoodConfig =
    config.source === "github"
      ? defineConfig({
          org: config.org as string | undefined,
          repo: config.repo as string | undefined,
          ref: (config as { ref?: string | undefined }).ref,
          version: "0",
          collections: { page },
        } as never)
      : defineConfig({
          org: config.org as string | undefined,
          repo: config.repo as string | undefined,
          ref: (config as { ref?: string | undefined }).ref,
          localPath: (config as { localPath?: string | undefined }).localPath?.trim() ? (config as { localPath: string }).localPath.trim() : undefined,
          version: "0",
          collections: { page },
        } as never);

  const gh = githubAppProvider();

  return createClient({
    // provider = transport only. `undefined` inside means not configured — no ternary needed.
    // route's `auth.authenticate` / `auth.authorize` owns all authz.
    provider: { github: gh as never },
    config: wildwoodConfig as never,
    database: libsqlClient as never,
  });
}

export function getPlaygroundWildwood(cookies: { get(name: string): { value: string } | undefined }): WildwoodClient {
  return buildPlaygroundWildwood(parsePlaygroundConfig(cookies));
}

/** @deprecated */
export const buildPlaygroundTr33 = buildPlaygroundWildwood;
/** @deprecated */
export const getPlaygroundTr33 = getPlaygroundWildwood;
