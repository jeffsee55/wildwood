/**
 * `wildwood/nextjs/auth` — private internal module.
 * Owned by `createWildwoodRoute`. Lazy, no static `better-auth` imports
 * at the top level that Turbopack can trace from `packages/wildwood/dist`.
 *
 * We use `new Function("s","return import(s)")` indirection so Turbopack
 * build of `apps/docs` doesn't try to resolve `better-auth` relative to
 * `packages/wildwood/`. At runtime on Vercel λ, node_modules has it.
 */

import type { WildwoodAuthUser } from "@/client/auth";
// Keep BetterAuthOptions import lazy via dynamic import type to avoid static dep in dist
// but we need the type for our option shape. Local type only — not re-exported as BetterAuthOptions.
import type { BetterAuthOptions as BetterAuthOptionsType } from "better-auth";
type BetterAuthOptions = BetterAuthOptionsType;

// Inlined schema — avoids fs at runtime, no NFT file.
const BETTER_AUTH_SCHEMA_SQL = `
create table "user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" integer not null, "image" text, "createdAt" date not null, "updatedAt" date not null);
create table "session" ("id" text not null primary key, "expiresAt" date not null, "token" text not null unique, "createdAt" date not null, "updatedAt" date not null, "ipAddress" text, "userAgent" text, "userId" text not null references "user" ("id") on delete cascade);
create table "account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" date, "refreshTokenExpiresAt" date, "scope" text, "password" text, "createdAt" date not null, "updatedAt" date not null);
create table "verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" date not null, "createdAt" date not null, "updatedAt" date not null);
create index "session_userId_idx" on "session" ("userId");
create index "account_userId_idx" on "account" ("userId");
create index "verification_identifier_idx" on "verification" ("identifier");
`.trim();

function splitSqlStatements(sql: string): string[] {
  return sql.split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter((s) => s && !s.startsWith("--"));
}

// ── public types ────────────────────────────────────────────────────────────

/** Sign-in / sign-up gate. Return false to reject creation of a session. */
export type WildwoodAuthenticateContext = {
  user: WildwoodAuthUser;
  request: Request;
  /** OAuth provider id that just authenticated, e.g. "github", if available */
  provider?: string;
};

export type WildwoodAuthenticateFn = (
  ctx: WildwoodAuthenticateContext,
) => boolean | void | Response | Promise<boolean | void | Response>;

export type WildwoodAuthorizeContext = {
  user: WildwoodAuthUser | null;
  action: import("@/client/auth").WildwoodAuthAction | { type: "content.update"; path: string };
  request: Request;
};

export type WildwoodAuthorizeFn = (
  ctx: WildwoodAuthorizeContext,
) => boolean | void | Response | Promise<boolean | void | Response>;

/** Optional autodetected baseURL; omit for zero-config. */
export type WildwoodBaseURL =
  | string
  | {
      allowedHosts: string[];
      fallback?: string;
      protocol?: "http" | "https" | "auto";
    };

/** Optional trustedOrigins; defaults to derived origin when omitted. */
export type WildwoodTrustedOrigins =
  | string[]
  | ((request?: Request) => string[] | Promise<string[]>);

/**
 * The provider config — what identity providers are enabled for sign-in.
 * `true` enables the provider, using creds from the github remote config
 * (GITHUB_CLIENT_ID/SECRET from the same GitHub App). Pass explicit
 * `{ clientId, clientSecret }` only if sign-in creds differ from git creds.
 * Future: `gitlab`, `google`, etc.
 */
export type WildwoodAuthProviders = {
  github?: boolean | { clientId: string; clientSecret: string };
  socialProviders?: BetterAuthOptions["socialProviders"];
  emailAndPassword?: boolean;
};

export type WildwoodRouteAuthOptions = {
  /**
   * DB is intentionally NOT here — wildwood reuses the LibSQL client from
   * `createClient({ database })`. Auth tables live in the same Turso DB.
   * We accept the already-constructed client / dialect at runtime via `getOrCreateAuth`.
   */
  /** If omitted, better-auth env fallback applies; in prod you should set BETTER_AUTH_SECRET. */
  secret?: string;
  /**
   * Optional — autodetected from request when omitted.
   * Omit for zero-config: works on localhost, Vercel preview (*.vercel.app), custom domains.
   * Only set explicitly if you need a fixed callback origin.
   * Accepts string or better-auth's dynamic form `{ allowedHosts, fallback?, protocol? }`.
   */
  baseURL?: WildwoodBaseURL | undefined;
  /**
   * Optional — defaults to derived baseURL origin.
   * Accepts static string[] or async function `(request?) => string[]` for userland mapping.
   * No fallbacks inside wildwood — if you need cross-domain origins, map them here.
   */
  trustedOrigins?: WildwoodTrustedOrigins | undefined;
  appName?: string;

  // Providers — current convenience keys (preferred is `providers.github`)
  github?: WildwoodAuthProviders["github"];
  providers?: WildwoodAuthProviders;

  /**
   * Who may sign in / sign up at all. Runs after the OAuth / credential user
   * is resolved but before the session is treated as authenticated.
   *
   * Return `false` to deny, `true`/void to allow, or a `Response` to customize.
   * Use this instead of an `allowedEmails` array.
   *
   * Example:
   * ```ts
   * authenticate: async ({ user }) =>
   *   ["you@example.com"].includes(user.email?.toLowerCase() ?? "")
   * ```
   *
   * Not confusing with `authorize`:
   *  - `authenticate` = can this identity create a session? (sign-in/sign-up gate)
   *  - `authorize`    = can this (already authenticated) session perform this action?
   */
  authenticate?: WildwoodAuthenticateFn;

  /**
   * What an authenticated user may do — git, content gates.
   */
  authorize?: WildwoodAuthorizeFn;

  // ── legacy compat (removed surface; still accepted as deprecated for one minor) ──
  /** @deprecated use `authenticate` callback instead */
  allowedEmails?: string[];
  /** @deprecated use `authenticate` callback instead */
  isAllowed?: (ctx: { user: WildwoodAuthUser | null; request: Request }) => boolean | Promise<boolean>;
  /** @deprecated DB now comes from createClient — not configured here */
  database?: { url: string; authToken?: string };
};

// ── internal ────────────────────────────────────────────────────────────────

export type WildwoodAuthInstance = { api: { getSession(a: { headers: Headers }): Promise<unknown> } };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dynamicImport = new Function("s", "return import(s)") as (s: string) => Promise<any>;

async function loadBetterAuthDeps() {
  const [{ betterAuth }, { LibsqlDialect }, { nextCookies }] = await Promise.all([
    dynamicImport("better-auth") as Promise<{
      betterAuth: (o: BetterAuthOptions) => WildwoodAuthInstance;
    }>,
    dynamicImport("@libsql/kysely-libsql") as Promise<{ LibsqlDialect: new (a: unknown) => unknown }>,
    dynamicImport("better-auth/next-js") as Promise<{ nextCookies: () => unknown }>,
  ]);
  return { betterAuth, LibsqlDialect, nextCookies };
}

// ---------------------------------------------------------------------------
// DB handling — we reuse the client's libsql client, no separate database field.
// better-auth needs a Kysely dialect, libsql/kysely-libsql accepts either
// { client: LibsqlClient } or { url, authToken }. We support both.
// ---------------------------------------------------------------------------

type LibsqlClientLike = { execute(s: string): Promise<unknown>; close?(): void };

function resolveLibsqlClient(
  db?: { libsqlClient?: LibsqlClientLike; client?: LibsqlClientLike },
): LibsqlClientLike | null {
  if (!db) return null;
  // LibsqlDatabase has `_client` or `client`; apps pass raw libsql client too
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = db as any;
  return c.libsqlClient ?? c.client ?? c._client ?? (typeof c.execute === "function" ? c : null);
}

function normalizeGithubProvider(
  opts: WildwoodRouteAuthOptions,
): { clientId: string; clientSecret: string } | undefined {
  // precedence: providers.github > top-level github
  const raw = opts.providers?.github ?? opts.github;
  if (!raw || raw === false) return undefined;
  if (raw === true) {
    // true => reuse from same GitHub App creds used for git.
    // Host is expected to have GITHUB_CLIENT_ID/SECRET from app manifest.
    // If host hasn't mapped them explicitly we fall back to env here as last resort
    // only for the OAuth client pair (not for DB). This keeps `github: true`
    // working zero-config on Vercel.
    const cid = process.env.GITHUB_CLIENT_ID?.trim();
    const csec = process.env.GITHUB_CLIENT_SECRET?.trim();
    if (!cid || !csec) return undefined;
    return { clientId: cid, clientSecret: csec };
  }
  return { clientId: raw.clientId, clientSecret: raw.clientSecret };
}

let cachedAuth: { key: string; instance: WildwoodAuthInstance; ensurePromise: Promise<void> | null } | null = null;

function cacheKey(opts: WildwoodRouteAuthOptions): string {
  const g = normalizeGithubProvider(opts);
  return [
    opts.secret?.slice(0, 8) ?? "no-secret",
    g?.clientId ?? "no-github",
    typeof opts.baseURL === "string" ? opts.baseURL : opts.baseURL ? JSON.stringify(opts.baseURL) : "auto-base",
    typeof opts.trustedOrigins === "function" ? "fn-trusted" : opts.trustedOrigins ? opts.trustedOrigins.join("|").slice(0, 80) : "auto-trusted",
    opts.providers?.emailAndPassword ? "email+pwd" : "no-email",
  ].join("::");
}

async function ensureAuthTables(client: LibsqlClientLike): Promise<void> {
  for (const stmt of splitSqlStatements(BETTER_AUTH_SCHEMA_SQL)) {
    try {
      await client.execute(stmt);
    } catch (e) {
      if (!(e instanceof Error) || !/already exists/i.test(e.message)) throw e;
    }
  }
}

function buildAuthenticateHook(
  authenticate: WildwoodAuthenticateFn,
): NonNullable<BetterAuthOptions["databaseHooks"]>["user"] {
  const wrap =
    (providerFromCtx: (ctx: unknown) => string | undefined) =>
    async (rawUser: unknown, ctx: unknown): Promise<false | void | { data: unknown }> => {
      const rec = (rawUser ?? {}) as Record<string, unknown>;
      const user: WildwoodAuthUser = {
        id: typeof rec.id === "string" ? rec.id : undefined,
        email: typeof rec.email === "string" ? rec.email : undefined,
        name: typeof rec.name === "string" ? rec.name : undefined,
        image: typeof rec.image === "string" ? rec.image : null,
      };
      const genericCtx = ctx as { request?: Request; context?: { request?: Request } } | null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const request: Request =
        (genericCtx as any)?.request ?? (genericCtx as any)?.context?.request ?? new Request("http://localhost");
      const provider = providerFromCtx(ctx);
      const result = await authenticate({ user, request, provider });
      if (result instanceof Response) {
        const status = result.status;
        if (status >= 200 && status < 400) return;
        return false;
      }
      if (result === false) return false;
      return;
    };

  return {
    create: {
      before: wrap((genericCtx) => {
        try {
          const ep = (genericCtx as { context?: { request?: Request }; path?: string; request?: { url?: string } }) ?? {};
          const urlStr =
            (ep as { request?: Request })?.request?.url ??
            (ep as { context?: { request?: Request } })?.context?.request?.url ??
            "";
          if (urlStr.includes("github")) return "github";
        } catch {}
        return undefined;
      }),
    },
  };
}

/**
 * Internal factory.
 * - DB is supplied by caller (client._.db / raw libsql client) — no `opts.database`.
 * - baseURL: optional — autodetected from Request when omitted.
 * - github: boolean | { clientId, clientSecret } where `true` reuses App creds.
 */
export async function getOrCreateAuth(opts: {
  auth: WildwoodRouteAuthOptions;
  db: { libsqlClient?: LibsqlClientLike; client?: LibsqlClientLike } | LibsqlClientLike;
}): Promise<{
  auth: WildwoodAuthInstance;
  ensureAuthSchema: () => Promise<void>;
}> {
  const { auth: authOpts, db } = opts;
  const libsqlClient = resolveLibsqlClient(db as never);
  if (!libsqlClient) throw new Error("Wildwood auth requires a libsql client — pass createClient({ database }) and forward its db.");

  const key = cacheKey(authOpts);
  if (cachedAuth && cachedAuth.key === key) {
    return {
      auth: cachedAuth.instance,
      ensureAuthSchema: () => {
        if (!cachedAuth!.ensurePromise) cachedAuth!.ensurePromise = ensureAuthTables(libsqlClient);
        return cachedAuth!.ensurePromise;
      },
    };
  }

  const { betterAuth, LibsqlDialect, nextCookies } = await loadBetterAuthDeps();

  const githubPair = normalizeGithubProvider(authOpts);
  const github = githubPair ? { github: githubPair } : undefined;
  const providersFromOpts = authOpts.providers?.socialProviders ?? authOpts.providers ?? {};
  // socialProviders kept as escape hatch, but `github` shorthand wins for github key
  const rawSocial = (authOpts as { socialProviders?: BetterAuthOptions["socialProviders"] }).socialProviders;
  const socialProviders = github || rawSocial ? { ...(rawSocial ?? {}), ...(github ?? {}) } : undefined;

  const emailAndPasswordEnabled = Boolean(
    authOpts.providers?.emailAndPassword ?? (authOpts as { emailAndPassword?: boolean }).emailAndPassword,
  );

  // Back-compat shim: allowedEmails / isAllowed → authenticate.
  let authenticate = authOpts.authenticate;
  if (!authenticate && (authOpts.allowedEmails || authOpts.isAllowed)) {
    const allowedEmails = authOpts.allowedEmails;
    const isAllowed = authOpts.isAllowed;
    authenticate = async ({ user, request }) => {
      if (isAllowed) {
        const r = await isAllowed({ user, request });
        if (!r) return false;
      }
      if (allowedEmails) {
        const lower = user.email?.toLowerCase() ?? "";
        if (!lower) return false;
        if (allowedEmails.length === 0) return true;
        return allowedEmails.some((e) => e.toLowerCase() === lower);
      }
      return true;
    };
  }

  const databaseHooks = authenticate ? buildAuthenticateHook(authenticate) : undefined;

  // LibsqlDialect accepts either { url, authToken } OR { client }.
  // Since we already have the client, prefer { client } — one connection, no double config.
  // The `kysely-libsql` type `LibsqlDialectConfig = { client } | Config` — see
  // node_modules/@libsql/kysely-libsql/lib-esm/index.d.ts.
  const baOpts: BetterAuthOptions = {
    appName: authOpts.appName ?? "Wildwood",
    ...(authOpts.secret ? { secret: authOpts.secret } : {}),
    ...(authOpts.baseURL ? { baseURL: authOpts.baseURL as BetterAuthOptions["baseURL"] } : {}),
    ...(authOpts.trustedOrigins ? { trustedOrigins: authOpts.trustedOrigins as BetterAuthOptions["trustedOrigins"] } : {}),
    database: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      dialect: new (LibsqlDialect as any)({ client: libsqlClient }),
      type: "sqlite" as const,
    },
    emailAndPassword: emailAndPasswordEnabled ? { enabled: true } : { enabled: false },
    ...(socialProviders ? { socialProviders } : {}),
    ...(databaseHooks ? { databaseHooks: { user: databaseHooks } as BetterAuthOptions["databaseHooks"] } : {}),
    plugins: [nextCookies()],
  };

  const instance = betterAuth(baOpts);

  let ensurePromise: Promise<void> | null = null;
  function ensureAuthSchema(): Promise<void> {
    if (!ensurePromise) ensurePromise = ensureAuthTables(libsqlClient);
    return ensurePromise;
  }

  cachedAuth = { key, instance, ensurePromise };
  return { auth: instance, ensureAuthSchema };
}

export function userFromSession(session: unknown): WildwoodAuthUser | null {
  if (!session || typeof session !== "object") return null;
  const maybe = session as { user?: unknown };
  const u = maybe.user;
  if (!u || typeof u !== "object") return null;
  const rec = u as Record<string, unknown>;
  return {
    id: typeof rec.id === "string" ? rec.id : undefined,
    email: typeof rec.email === "string" ? rec.email : undefined,
    name: typeof rec.name === "string" ? rec.name : undefined,
    image: typeof rec.image === "string" ? rec.image : null,
  };
}

export async function getSessionUser(
  auth: WildwoodAuthInstance,
  headers: Headers,
): Promise<{ session: unknown; user: WildwoodAuthUser | null } | null> {
  const s = await (auth as { api: { getSession(a: { headers: Headers }): Promise<unknown> } }).api.getSession({ headers });
  if (!s) return null;
  return { session: s, user: userFromSession(s) };
}

/** @deprecated use `authenticate` instead */
export function isAllowedByEmailList(user: WildwoodAuthUser | null, allowedEmails: string[] | undefined): boolean {
  if (!allowedEmails) {
    if (process.env.NODE_ENV === "production") return false;
    return !!user;
  }
  if (allowedEmails.length === 0) return true;
  if (!user?.email) return false;
  const lower = user.email.toLowerCase();
  return allowedEmails.some((e) => e.toLowerCase() === lower);
}

/**
 * Evaluate `authenticate` at request time for existing sessions.
 * Used by route.ts to gate already-signed-in users whose creation was before
 * `authenticate` was configured, and to enforce dynamic rules.
 */
export async function evaluateAuthenticate(
  authenticate: WildwoodAuthenticateFn | undefined,
  user: WildwoodAuthUser | null,
  request: Request,
  provider?: string,
): Promise<Response | false | null> {
  if (!authenticate) return null;
  if (!user?.email && !user?.id) return new Response("Authentication required", { status: 401 });
  const result = await authenticate({ user: user as WildwoodAuthUser, request, provider });
  if (result instanceof Response) return result;
  if (result === false) return new Response("Forbidden", { status: 403 });
  return null;
}

