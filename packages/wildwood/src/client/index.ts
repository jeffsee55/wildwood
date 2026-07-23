import type { Client as LibsqlClient } from "@libsql/client";
import type { WildwoodGitHubAuth } from "@/client/auth";
import { normalizeProviderConfig, type WildwoodProviderConfig } from "@/client/auth";
import { Config, type AnyCollections, type DefineConfigInput } from "@/client/config";
import type { OrmConfig } from "@/client/types";
import { Git } from "@/git/git";
import { GitHubRemote } from "@/git/remote/github";
import { NativeRemote } from "@/git/remote/native";
import { Logger } from "@/git/util/logger";
import { LibsqlDatabase } from "@/sqlite/database";
import type { FindWorktreeEntriesArgs } from "@/types";

/**
 * The database driver, supplied from userland. Wildwood does NOT construct or
 * bundle a driver — you pass an already-constructed client (today: a LibSQL /
 * Turso `@libsql/client` instance). This keeps the native driver out of
 * Wildwood's dependency graph and lets hosts own the connection.
 *
 * Passing a live client is safe at module scope: Wildwood never touches it until
 * the first query, so importing the module stays inert (safe inside
 * `"use cache"` and Next's build-worker module evaluation). Just don't perform
 * the driver's own connection work at module scope if your driver connects
 * eagerly.
 */
export type WildwoodDatabaseInput = LibsqlClient;

/**
 * `createClient` captures `Colls` literally from `Config<Colls>` so `FindTypes`
 * can infer connections/filters. All fields optional where possible — no
 * required fields that block scaffolding. Provider is git transport only.
 * All `authenticate`/`authorize` lives on `createCMS({ auth })`.
 *
 * Internally we trim / normalize so callers can pass `process.env.X` directly.
 */
export type WildwoodCreateClientArgs<Colls extends AnyCollections> = {
  provider?: WildwoodProviderConfig | undefined;
  config?: Config<Colls> | undefined;
  database?: WildwoodDatabaseInput | undefined;
};

function isLibsqlClient(input: WildwoodDatabaseInput): input is LibsqlClient {
  return typeof input === "object" && input !== null && typeof (input as LibsqlClient).execute === "function";
}

/**
 * Wildwood takes the driver as-is from userland — no construction. Returns the
 * client (or null when none was passed). The client is only *used* on the first
 * query, so holding it here at module scope is inert.
 */
function resolveDatabaseFactory(
  input: WildwoodDatabaseInput | undefined,
): (() => LibsqlClient) | null {
  if (input == null) return null;
  if (isLibsqlClient(input)) {
    return () => input;
  }
  throw new Error(
    "wildwood: `database` must be a constructed client instance (e.g. `@libsql/client`'s createClient(...)). " +
      "Passing a connection string or `{ url, authToken }` is no longer supported — construct the driver in userland and pass it in.",
  );
}

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

/** Internal `_` bag shared by every client. Named so the dts emitter references it. */
export type WildwoodClientInternals = {
  config: Config;
  provider?: WildwoodProviderConfig | undefined;
  git: Git;
  logger: Logger;
  db: LibsqlDatabase;
};

/**
 * Explicit return type for `createClient`/`wildwood`, keyed on the literal
 * collections.
 *
 * IMPORTANT: this MUST be an explicit named alias with `OrmConfig<...>` left
 * unresolved (generic). Without it, the return type is *inferred*, and
 * `rolldown-plugin-dts` eagerly expands `OrmConfig`'s default type args
 * (`Opts`/`CM`/`FM`) while bundling `.d.mts`. That expansion overruns the
 * emitter's depth limit and gets replaced with `/*elided* / any`, which is why
 * `findFirst()`/`findMany()` degraded to `value: any` for consumers reading the
 * built types (source-based consumers were unaffected). Referencing `OrmConfig`
 * by name keeps it lazy in the emitted declarations.
 */
export type WildwoodClientFor<Colls extends AnyCollections> = OrmConfig<{
  [K in keyof Colls as Colls[K]["name"] & string]: Colls[K];
}> & { _: WildwoodClientInternals };

export const createClient = <Colls extends AnyCollections = AnyCollections>(
  args: WildwoodCreateClientArgs<Colls> = {},
): WildwoodClientFor<Colls> => {
  const normalizedProvider = normalizeProviderConfig(args.provider);

  const config = args.config ?? null;
  const databaseFactory = resolveDatabaseFactory(args.database);

  const effectiveConfig: Config<Colls> = config ?? emptyConfigStub<Colls>();

  const useNative = config
    ? typeof config.resolvedLocalPath === "string"
      ? Boolean(config.resolvedLocalPath)
      : Boolean(config.wantsLocal ?? config.localPath)
    : false;

  // --- Lazy live handles ---------------------------------------------------
  // Nothing below is constructed until the first query call. This keeps the
  // module-scope client inert (safe to import into `"use cache"`) and keeps
  // the LibSQL/Octokit handles out of Next's build-worker module graph.
  let dbInstance: LibsqlDatabase | null = null;
  let remoteInstance: GitHubRemote | NativeRemote | null = null;
  let gitInstance: Git | null = null;

  function getDb(): LibsqlDatabase | null {
    if (dbInstance) return dbInstance;
    if (!databaseFactory) return null;
    dbInstance = new LibsqlDatabase({
      client: databaseFactory(),
      config: effectiveConfig as Config,
    });
    return dbInstance;
  }

  function getRemote(): GitHubRemote | NativeRemote {
    if (remoteInstance) return remoteInstance;
    remoteInstance = useNative
      ? new NativeRemote({ provider: normalizedProvider, config: effectiveConfig as Config })
      : new GitHubRemote({ provider: normalizedProvider, config: effectiveConfig as Config });
    return remoteInstance;
  }

  function getGit(): Git {
    if (gitInstance) return gitInstance;
    const db = getDb();
    if (!db) {
      throw new Error(
        "wildwood: database not configured. Pass a database to wildwood({ database }).",
      );
    }
    gitInstance = new Git({ config: effectiveConfig as Config, remote: getRemote(), db });
    return gitInstance;
  }

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
          getGit().findMany({ ...a, collection: col.name }),
        findFirst: (a: Omit<FindWorktreeEntriesArgs, "collection"> = {}) =>
          getGit().findFirst({ ...(a as FindWorktreeEntriesArgs), collection: col.name }),
      };
    }
  }

  // `_` uses lazy getters so consumers (branch/toolbar/route) can read config
  // and provider without triggering handle construction, while `git`/`db`
  // still materialize on demand for mutations.
  const internals = {
    config: effectiveConfig,
    provider: normalizedProvider,
    get git(): Git {
      return getGit();
    },
    logger: new Logger({ name: "wildwood" }),
    get db(): LibsqlDatabase {
      return getDb() as LibsqlDatabase;
    },
  };

  return {
    ...collections,
    _: internals,
  } as unknown as WildwoodClientFor<Colls>;
};

/**
 * Flat, composable entry point. `wildwood({...})` returns the read client.
 * The CMS layer wraps it: `createCMS(ww, { ...options })`.
 *
 * Everything is one flat bag — identity, collections, database and the single
 * GitHub credential object — so there is no separate `defineConfig` step
 * required (though `defineConfig` is still exported for advanced use).
 *
 * Bring your own driver — construct the DB client in userland and pass it in:
 *
 *   import { createClient as createLibsql } from "@libsql/client";
 *
 *   const db = createLibsql({
 *     url: process.env.TURSO_DATABASE_URL!,
 *     authToken: process.env.TURSO_AUTH_TOKEN,
 *   });
 *
 *   export const ww = wildwood({
 *     org: process.env.MY_ORG,
 *     repo: process.env.MY_REPO,
 *     collections: { docs },
 *     database: db,
 *     github: {
 *       appId: process.env.GITHUB_APP_ID,
 *       privateKey: process.env.GITHUB_PRIVATE_KEY,
 *       installationId: process.env.GITHUB_APP_INSTALLATION_ID,
 *       clientId: process.env.GITHUB_CLIENT_ID,
 *       clientSecret: process.env.GITHUB_CLIENT_SECRET,
 *     },
 *   });
 */
export type WildwoodInput<Colls extends AnyCollections> = DefineConfigInput<Colls> & {
  /** The DB driver, constructed in userland (e.g. a `@libsql/client` instance). */
  database?: WildwoodDatabaseInput | undefined;
  /** The single GitHub credential object — reused by git transport and CMS sign-in. */
  github?: WildwoodGitHubAuth | undefined;
};

export const wildwood = <const Colls extends AnyCollections>(
  input: WildwoodInput<Colls>,
): WildwoodClientFor<Colls> => {
  const { database, github, ...configInput } = input;
  const config = new Config<Colls>(configInput as DefineConfigInput<Colls>);
  return createClient<Colls>({
    config,
    database,
    provider: github ? { github } : undefined,
  });
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
