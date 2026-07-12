import type { Client as LibsqlClient } from "@libsql/client";
import type { Tr33AuthConfig } from "@/client/auth";
import type { AnyCollections, Config } from "@/client/config";
import type { OrmConfig } from "@/client/types";
import { Git } from "@/git/git";
import { GitHubRemote } from "@/git/remote/github";
import { NativeRemote } from "@/git/remote/native";
import { Logger } from "@/git/util/logger";
import { LibsqlDatabase } from "@/sqlite/database";
import type { FindWorktreeEntriesArgs } from "@/types";

/**
 * `createClient` now captures `Colls` literally from `Config<Colls>` so that
 * `FindTypes` can infer connections / filters from `z.lazy(() => z.connect(...)).optional()`
 * without being erased by `dist` declaration emit. Previously `C extends Config<ConfigInput>`
 * where `ConfigInput["collections"]` was `Record<string, Collection>` with
 * `Collection["schema"] = ZodCodec<ZodString, ZodObject>` lost inner shape → `with` became `never`.
 */
export const createClient = <Colls extends AnyCollections>(args: {
  auth?: Tr33AuthConfig;
  config: Config<Colls>;
  database: LibsqlClient;
}) => {
  const { auth, config, database } = args;
  if (!database) {
    throw new Error(
      "createClient requires a LibSQL database client. Pass createClient({ config, database }).",
    );
  }
  const db = new LibsqlDatabase({ client: database, config: config as unknown as Config });
  // Prefer `resolvedLocalPath` (explicit `localPath` or auto-detected git root in dev)
  const useNative =
    typeof (config as { resolvedLocalPath?: string | undefined }).resolvedLocalPath === "string"
      ? Boolean((config as { resolvedLocalPath?: string | undefined }).resolvedLocalPath)
      : Boolean((config as { wantsLocal?: boolean }).wantsLocal ?? config.localPath);
  const remote = useNative
    ? new NativeRemote({ auth, config: config as unknown as Config })
    : new GitHubRemote({ auth, config: config as unknown as Config });
  const git = new Git({ config: config as unknown as Config, remote, db });

  type Mapped = {
    [K in keyof Colls as Colls[K]["name"] & string]: Colls[K];
  };

  const collections = {} as OrmConfig<Mapped>;
  for (const collection of Object.values(config.collections)) {
    (collections as Record<string, unknown>)[collection.name] = {
      findMany: (a: Omit<FindWorktreeEntriesArgs, "collection">) =>
        git.findMany({ ...a, collection: collection.name }),
      findFirst: (a: Omit<FindWorktreeEntriesArgs, "collection"> = {}) =>
        git.findFirst({ ...(a as FindWorktreeEntriesArgs), collection: collection.name }),
    };
  }
  return {
    ...collections,
    _: {
      config,
      auth,
      git,
      logger: new Logger({ name: "something" }),
      db,
    },
  };
};

/**
 * Structural type for `handle()` / `createHandler()` and anywhere you need to accept any `createClient()` result.
 * Uses `Record<string, any>` for collection keys so concrete ORM shapes assign without casts.
 */
export type Tr33Client = {
  _: {
    config: Config;
    auth?: Tr33AuthConfig;
    git: Git;
    logger: Logger;
    db: LibsqlDatabase;
  };
  // biome-ignore lint/suspicious/noExplicitAny: collection entries vary per app config
} & Record<string, any>;
