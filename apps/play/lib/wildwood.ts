import { createClient as libsqlCreateClient } from "@libsql/client";
import { createClient, defineConfig, z } from "wildwood";

import { type PlaygroundConfig, parsePlaygroundConfig } from "./playground-config";

const libsqlClient = libsqlCreateClient({
  url: process.env.TURSO_DATABASE_URL || "file:./wildwood.db",
  authToken: process.env.TURSO_AUTH_TOKEN || "",
});

export function buildPlaygroundWildwood(pg: PlaygroundConfig) {
  const page = z.collection({
    name: "page",
    match: pg.match,
    schema: pg.contentType === "md" ? z.markdown() : z.json({}),
  });

  // No `.trim()` needed — `defineConfig` and provider normalizers trim internally.
  const wildwoodConfig =
    pg.source === "github"
      ? defineConfig({
          org: pg.org,
          repo: pg.repo,
          ref: pg.ref,
          version: "0",
          collections: { page },
        })
      : defineConfig({
          org: pg.org,
          repo: pg.repo,
          ref: pg.ref,
          localPath: pg.localPath,
          version: "0",
          collections: { page },
        });

  // Return inferred client type — preserves `OrmConfig<Mapped>` so `wildwood.page.findMany` keeps
  // full `FindTypes` inference for `with`/`where`. Avoid `WildwoodClient` structural cast which
  // would erase generics via `(args?: unknown)` index signature.
  return createClient({
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
    config: wildwoodConfig,
    database: libsqlClient,
  });
}

export type PlaygroundWildwoodClient = ReturnType<typeof buildPlaygroundWildwood>;

export function getPlaygroundWildwood(cookies: {
  get(name: string): { value: string } | undefined;
}): PlaygroundWildwoodClient {
  return buildPlaygroundWildwood(parsePlaygroundConfig(cookies));
}

/** @deprecated */
export const buildPlaygroundTr33 = buildPlaygroundWildwood;
/** @deprecated */
export const getPlaygroundTr33 = getPlaygroundWildwood;
