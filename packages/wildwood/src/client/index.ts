import type { Client as LibsqlClient } from "@libsql/client";
import type { WildwoodProviderConfig } from "@/client/auth";
import type { AnyCollections, Config } from "@/client/config";
import type { OrmConfig } from "@/client/types";
import { Git } from "@/git/git";
import { GitHubRemote } from "@/git/remote/github";
import { NativeRemote } from "@/git/remote/native";
import { Logger } from "@/git/util/logger";
import { LibsqlDatabase } from "@/sqlite/database";
import type { FindWorktreeEntriesArgs } from "@/types";

/**
 * `createClient` captures `Colls` literally from `Config<Colls>` so `FindTypes`
 * can infer connections/filters. Everything optional where possible — no required
 * fields that block scaffolding. `provider` is git transport only — no authz.
 * All `authenticate`/`authorize` lives on `createWildwoodRoute({ auth })`.
 */
export type WildwoodCreateClientArgs<Colls extends AnyCollections> = {
  provider?: WildwoodProviderConfig | undefined | null;
  /** Optional — `defineConfig` output. When omitted we use an empty collections shell. */
  config?: Config<Colls> | undefined | null;
  /** Optional — libsql client. When omitted, DB-backed reads are unavailable until client is provided. */
  database?: LibsqlClient | undefined | null;
};

export const createClient = <Colls extends AnyCollections = AnyCollections>(
  args: WildwoodCreateClientArgs<Colls> = {},
) => {
  const provider = args.provider ?? undefined;
  const config = (args.config ?? null) as Config<Colls> | null;
  const database = (args.database ?? null) as LibsqlClient | null;

  // config may be omitted during scaffolding / typecheck — use resilient fallback.
  const effectiveConfig = (config ??
    ({
      collections: [],
      org: "",
      repo: "",
      ref: "main",
      version: "0",
      resolvedLocalPath: undefined,
      localPath: undefined,
      wantsLocal: false,
      getCollectionForPath: () => null,
      slugForPath: () => "",
      paths: [],
      matches: () => false,
      namespace: { orgName: "", repoName: "", version: "0" },
      defaultVariant: () => "__",
    } as unknown as Config<Colls>)) as Config<Colls>;

  let db: LibsqlDatabase | null = null;
  if (database) {
    db = new LibsqlDatabase({ client: database, config: effectiveConfig as unknown as Config });
  }

  const useNative = config
    ? typeof (config as { resolvedLocalPath?: string | undefined }).resolvedLocalPath === "string"
      ? Boolean((config as { resolvedLocalPath?: string | undefined }).resolvedLocalPath)
      : Boolean((config as { wantsLocal?: boolean }).wantsLocal ?? config.localPath)
    : false;

  const remote = useNative
    ? new NativeRemote({ provider: provider as never, config: effectiveConfig as unknown as Config })
    : new GitHubRemote({ provider: provider as never, config: effectiveConfig as unknown as Config });

  const git = db
    ? new Git({ config: effectiveConfig as unknown as Config, remote, db })
    : // Lazy stub — real Git ops throw at call time if DB missing, but typecheck/construction succeeds.
      ({
        findMany: async () => {
          throw new Error("wildwood: database not configured. Pass createClient({ database }).");
        },
        findFirst: async () => {
          throw new Error("wildwood: database not configured. Pass createClient({ database }).");
        },
        // spread-safe for other Git fields accessed via `any`
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any as Git);

  type Mapped = {
    [K in keyof Colls as Colls[K]["name"] & string]: Colls[K];
  };

  const collections = {} as OrmConfig<Mapped>;
  if (config?.collections) {
    for (const collection of Object.values(config.collections)) {
      (collections as Record<string, unknown>)[collection.name] = {
        findMany: (a: Omit<FindWorktreeEntriesArgs, "collection">) =>
          git.findMany({ ...a, collection: collection.name }),
        findFirst: (a: Omit<FindWorktreeEntriesArgs, "collection"> = {}) =>
          git.findFirst({ ...(a as FindWorktreeEntriesArgs), collection: collection.name }),
      };
    }
  }

  return {
    ...collections,
    _: {
      config: effectiveConfig,
      provider: provider as WildwoodProviderConfig | undefined,
      git,
      logger: new Logger({ name: "something" }),
      // db may be null when `database` omitted — route/auth gracefully handles it at request time.
      db: db as unknown as LibsqlDatabase,
    },
  };
};

/**
 * Structural type for `handle()` / `createHandler()` and anywhere you need to accept any `createClient()` result.
 * Uses `Record<string, any>` for collection keys so concrete ORM shapes assign without casts.
 */
export type WildwoodClient = {
  _: {
    config: Config;
    provider?: WildwoodProviderConfig;
    git: Git;
    logger: Logger;
    db: LibsqlDatabase;
  };
  // biome-ignore lint/suspicious/noExplicitAny: collection entries vary per app config
} & Record<string, any>;
