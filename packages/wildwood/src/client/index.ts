import type { Client as LibsqlClient } from "@libsql/client";
import { normalizeProviderConfig, type WildwoodProviderConfig } from "@/client/auth";
import { Config, type AnyCollections } from "@/client/config";
import type { OrmConfig } from "@/client/types";
import { Git } from "@/git/git";
import { GitHubRemote } from "@/git/remote/github";
import { NativeRemote } from "@/git/remote/native";
import { Logger } from "@/git/util/logger";
import { LibsqlDatabase } from "@/sqlite/database";
import type { FindWorktreeEntriesArgs } from "@/types";

/**
 * `createClient` captures `Colls` literally from `Config<Colls>` so `FindTypes`
 * can infer connections/filters. All fields optional where possible — no
 * required fields that block scaffolding. Provider is git transport only.
 * All `authenticate`/`authorize` lives on `createWildwoodRoute({ auth })`.
 *
 * Internally we trim / normalize so callers can pass `process.env.X` directly.
 */
export type WildwoodCreateClientArgs<Colls extends AnyCollections> = {
  provider?: WildwoodProviderConfig | undefined;
  config?: Config<Colls> | undefined;
  database?: LibsqlClient | undefined;
};

function emptyConfigStub<Colls extends AnyCollections>(): Config<Colls> {
  // Minimal object that satisfies Config shape without getters colliding.
  // Use a plain class instance via Object.create so property descriptors don't clash.
  const proto = Config.prototype as unknown as Record<string, unknown>;
  const inst = Object.create(proto) as Config<Colls>;

  // Backing fields
  const backing = {
    org: "",
    repo: "",
    ref: "main",
    version: "0",
    localPath: undefined as string | undefined,
    origin: undefined as string | undefined,
    resolvedLocalPath: undefined as string | undefined,
  };

  Object.assign(inst as unknown as Record<string, unknown>, {
    configObject: {
      org: backing.org,
      repo: backing.repo,
      ref: backing.ref,
      version: backing.version,
      localPath: backing.localPath,
      origin: backing.origin,
      collections: {} as AnyCollections,
      variants: undefined,
    },
    configInput: { collections: {} as Colls },
    _autoLocalPath: null as string | null,
  });

  // Getters delegate to configObject — matches real Config class behavior.
  // Avoid redefining if prototype already has them.
  if (!Object.getOwnPropertyDescriptor(proto, "org")) {
    Object.defineProperties(inst as unknown as Record<string, unknown>, {
      org: { get: () => backing.org },
      repo: { get: () => backing.repo },
      ref: { get: () => backing.ref },
      version: { get: () => backing.version },
      localPath: { get: () => backing.localPath },
      origin: { get: () => backing.origin },
      resolvedLocalPath: { get: () => backing.resolvedLocalPath },
      wantsLocal: { get: () => false },
      namespace: { get: () => ({ orgName: "", repoName: "", version: "0" }) },
      collections: { get: () => [] as unknown },
      paths: { get: () => [] as unknown },
    });
  }

  (inst as unknown as { getCollectionForPath: () => null }).getCollectionForPath = () => null;
  (inst as unknown as { slugForPath: () => string }).slugForPath = () => "";
  (inst as unknown as { matches: () => boolean }).matches = () => false;
  (inst as unknown as { defaultVariant: () => string }).defaultVariant = () => "__";

  return inst;
}

export const createClient = <Colls extends AnyCollections = AnyCollections>(
  args: WildwoodCreateClientArgs<Colls> = {},
) => {
  const normalizedProvider = normalizeProviderConfig(args.provider);

  const config = args.config ?? null;
  const database = args.database ?? null;

  const effectiveConfig: Config<Colls> = config ?? emptyConfigStub<Colls>();

  let db: LibsqlDatabase | null = null;
  if (database) {
    db = new LibsqlDatabase({ client: database, config: effectiveConfig as Config });
  }

  const useNative = config
    ? typeof config.resolvedLocalPath === "string"
      ? Boolean(config.resolvedLocalPath)
      : Boolean(config.wantsLocal ?? config.localPath)
    : false;

  const remote = useNative
    ? new NativeRemote({ provider: normalizedProvider, config: effectiveConfig as Config })
    : new GitHubRemote({ provider: normalizedProvider, config: effectiveConfig as Config });

  const git: Git = db
    ? new Git({ config: effectiveConfig as Config, remote, db })
    : // scaffold stub — satisfies Git interface at runtime via Error throws; typed as unknown first
      ({
        findMany: async () => {
          throw new Error("wildwood: database not configured. Pass createClient({ database }).");
        },
        findFirst: async () => {
          throw new Error("wildwood: database not configured. Pass createClient({ database }).");
        },
      } as unknown as Git);

  type Mapped = {
    [K in keyof Colls as Colls[K]["name"] & string]: Colls[K];
  };

  const collections = {} as OrmConfig<Mapped>;

  if (config) {
    // Config.collections is array of collection metas (not record) in real class.
    const colls = config.collections as unknown as
      | Array<{ name: string }>
      | Record<string, { name: string }>;
    const list: Array<{ name: string }> = Array.isArray(colls) ? colls : Object.values(colls ?? {});
    for (const col of list) {
      if (!col?.name) continue;
      (collections as Record<string, unknown>)[col.name] = {
        findMany: (a: Omit<FindWorktreeEntriesArgs, "collection">) =>
          git.findMany({ ...a, collection: col.name }),
        findFirst: (a: Omit<FindWorktreeEntriesArgs, "collection"> = {}) =>
          git.findFirst({ ...(a as FindWorktreeEntriesArgs), collection: col.name }),
      };
    }
  }

  return {
    ...collections,
    _: {
      config: effectiveConfig,
      provider: normalizedProvider,
      git,
      logger: new Logger({ name: "wildwood" }),
      db: db as LibsqlDatabase,
    },
  };
};

// `WildwoodClient` must be compatible with `createClient()` return which is `OrmConfig<Mapped> & {_:...}`.
// Using `Record<string, unknown>` for index avoids contravariance clash with generic `findMany<W>`.
export type WildwoodClient = {
  _: {
    config: Config;
    provider?: WildwoodProviderConfig | undefined;
    git: Git;
    logger: Logger;
    db: LibsqlDatabase;
  };
  // biome-ignore lint/suspicious/noExplicitAny: collection entries vary per app; must accept any OrmConfig shape
} & Record<string, any>;
