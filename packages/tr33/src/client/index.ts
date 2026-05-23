import type { Client as LibsqlClient } from "@libsql/client";
import type { Tr33AuthConfig } from "@/client/auth";
import type { Config, ConfigInput } from "@/client/config";
import type { OrmConfig } from "@/client/types";
import { Git } from "@/git/git";
import { GitHubRemote } from "@/git/remote/github";
import { NativeRemote } from "@/git/remote/native";
import { Logger } from "@/git/util/logger";
import { LibsqlDatabase } from "@/sqlite/database";
import type { FindWorktreeEntriesArgs } from "@/types";

export const createClient = <C extends Config<ConfigInput>>(args: {
  auth?: Tr33AuthConfig;
  config: C;
  database: LibsqlClient;
}) => {
  const { auth, config, database } = args;
  if (!database) {
    throw new Error(
      "createClient requires a LibSQL database client. Pass createClient({ config, database }).",
    );
  }
  const db = new LibsqlDatabase({ client: database, config });
  const remote = config.localPath
    ? new NativeRemote({ auth, config })
    : new GitHubRemote({ auth, config });
  // const git = new Git({ config, remote, db });
  const git = new Git({ config, remote, db });
  const collections = {} as OrmConfig<{
    [K in keyof C["configInput"]["collections"] as C["configInput"]["collections"][K]["name"]]: C["configInput"]["collections"][K];
  }>;
  for (const collection of Object.values(config.collections)) {
    (collections as Record<string, unknown>)[collection.name] = {
      findMany: (args: Omit<FindWorktreeEntriesArgs, "collection">) =>
        git.findMany({ ...args, collection: collection.name }),
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
    config: Config<ConfigInput>;
    auth?: Tr33AuthConfig;
    git: Git;
    logger: Logger;
    db: LibsqlDatabase;
  };
  // biome-ignore lint/suspicious/noExplicitAny: collection entries vary per app config
} & Record<string, any>;
