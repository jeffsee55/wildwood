/**
 * `wildwood/nextjs/auth` — private internal module.
 * Owned by `createWildwoodRoute`. Lazy, no static `better-auth` imports
 * at the top level that Turbopack can trace from `packages/wildwood/dist`.
 *
 * We use `new Function("s","return import(s)")` indirection so Turbopack
 * build of `apps/docs` doesn't try to resolve `better-auth` relative to
 * `packages/wildwood/`. At runtime on Vercel λ, node_modules has it.
 */

// Keep BetterAuthOptions import lazy — type is optional at build time.
// We mirror only what we need so missing `better-auth` doesn't break tsc during scaffolding.
// At runtime we dynamic-import it (see loadBetterAuthDeps).
type BetterAuthSocialProviders = Record<string, unknown>;
type BetterAuthOptions = {
  appName?: string;
  secret?: string;
  baseURL?: unknown;
  trustedOrigins?: unknown;
  database?: unknown;
  emailAndPassword?: { enabled: boolean };
  socialProviders?: BetterAuthSocialProviders;
  databaseHooks?: unknown;
  plugins?: unknown[];
};

// ── route-owned auth identity + action types ────────────────────────────
// These used to live in `client/auth.ts` but `provider` (client) is now
// transport-only — all `authenticate` / `authorize` lives on the route.
// Moving them here makes the ownership obvious and breaks the client→route
// import cycle.

/** Stable user shape surfaced from better-auth / custom getUser. */
export type WildwoodAuthUser = {
  id?: string;
  email?: string;
  name?: string;
  image?: string | null;
};

export type WildwoodAuthAction =
  | { type: "git.switchRef"; ref: string }
  | { type: "git.createBranch"; name: string; baseRef?: string }
  | { type: "git.add"; ref: string; paths: string[] }
  | { type: "git.patchWorktree"; ref: string; paths: string[] }
  | { type: "git.commit"; ref: string; message: string }
  | { type: "git.discard"; ref: string }
  | { type: "git.push"; ref: string }
  | { type: "git.pull"; ref: string }
  | { type: "git.merge"; ref: string; message?: string }
  | { type: "git.createPr"; ref: string; title?: string; body?: string }
  | { type: "content.update"; path: string }
  | { type: "content.delete"; path: string };

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
  action: WildwoodAuthAction;
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
  github?: boolean | { clientId?: string | undefined; clientSecret?: string | undefined } | undefined | null;
  socialProviders?: BetterAuthSocialProviders | undefined | null;
  emailAndPassword?: boolean | undefined;
};

export type WildwoodRouteAuthOptions = {
  /**
   * DB is intentionally NOT here — wildwood reuses the LibSQL client from
   * `createClient({ database })`. Auth tables live in the same Turso DB.
   */
  /** Optional — better-auth env fallback applies; set BETTER_AUTH_SECRET in prod. */
  secret?: string | undefined | null;
  /** Optional — autodetected from request when omitted. */
  baseURL?: WildwoodBaseURL | undefined | null;
  /** Optional — defaults to derived baseURL origin. */
  trustedOrigins?: WildwoodTrustedOrigins | undefined | null;
  appName?: string | undefined | null;

  // Providers — all optional, may be omitted, null, or false to disable.
  github?: WildwoodAuthProviders["github"] | undefined | null;
  providers?: WildwoodAuthProviders | undefined | null;

  /** Who may sign in at all. All optional — omit for open sign-in. */
  authenticate?: WildwoodAuthenticateFn | undefined | null;

  /** What an authenticated user may do — optional. */
  authorize?: WildwoodAuthorizeFn | undefined | null;

  // ── legacy compat (still tolerated at type level) ──
  /** @deprecated use `authenticate` callback instead */
  allowedEmails?: string[] | undefined | null;
  /** @deprecated use `authenticate` callback instead */
  isAllowed?: ((ctx: { user: WildwoodAuthUser | null; request: Request }) => boolean | Promise<boolean>) | undefined | null;
  /** @deprecated DB now comes from createClient */
  database?: { url?: string | undefined | null; authToken?: string | undefined | null } | undefined | null;
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

export type WildwoodAuthDbInput =
  | LibsqlClientLike
  | { libsqlClient?: LibsqlClientLike | null | undefined; client?: LibsqlClientLike | null | undefined }
  | null
  | undefined;

function resolveLibsqlClient(db?: WildwoodAuthDbInput): LibsqlClientLike | null {
  if (!db) return null;
  // LibsqlDatabase has `_client` or `client`; apps pass raw libsql client too
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = db as any;
  return c.libsqlClient ?? c.client ?? c._client ?? (typeof c.execute === "function" ? c : null);
}

function normalizeGithubProvider(
  opts: WildwoodRouteAuthOptions,
): { clientId: string; clientSecret: string } | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyOpts = opts as any;
  const raw: unknown = anyOpts?.providers?.github ?? anyOpts?.github;
  if (!raw) return undefined;
  // `false` explicitly disables — check via `any` to allow false even if type is optional
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((raw as any) === false) return undefined;
  if (raw === true) {
    const cid = process.env.GITHUB_CLIENT_ID?.trim();
    const csec = process.env.GITHUB_CLIENT_SECRET?.trim();
    if (!cid || !csec) return undefined;
    return { clientId: cid, clientSecret: csec };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = raw as { clientId?: string | undefined; clientSecret?: string | undefined };
  if (!r?.clientId || !r?.clientSecret) return undefined;
  return { clientId: r.clientId, clientSecret: r.clientSecret };
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
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
 * Internal factory — all fields optional. DB may be null/undefined at type level;
 * runtime throws only if we actually need auth and no client is present.
 */
export async function getOrCreateAuth(opts: {
  auth: WildwoodRouteAuthOptions | undefined | null;
  db: WildwoodAuthDbInput;
}): Promise<{
  auth: WildwoodAuthInstance;
  ensureAuthSchema: () => Promise<void>;
}> {
  const authOpts: WildwoodRouteAuthOptions = (opts.auth ?? {}) as WildwoodRouteAuthOptions;
  const { db } = opts;
  // Resolve once, assert non-null after guard — tsc can't infer control-flow narrowing through function return | null
  const libsqlClientResolved = resolveLibsqlClient(db as never);
  if (!libsqlClientResolved) throw new Error("Wildwood auth requires a libsql client — pass createClient({ database }) and forward its db.");
  const libsqlClient: LibsqlClientLike = libsqlClientResolved as LibsqlClientLike;

  const key = cacheKey(authOpts);
  if (cachedAuth && cachedAuth.key === key) {
    // libsqlClient is stable — reuse cached ensuring same client; safe to capture here.
    const lc: LibsqlClientLike = libsqlClient;
    return {
      auth: cachedAuth.instance,
      ensureAuthSchema: () => {
        if (!cachedAuth!.ensurePromise) cachedAuth!.ensurePromise = ensureAuthTables(lc);
        return cachedAuth!.ensurePromise;
      },
    };
  }

  const { betterAuth, LibsqlDialect, nextCookies } = await loadBetterAuthDeps();

  const githubPair = normalizeGithubProvider(authOpts);
  const github = githubPair ? { github: githubPair } : undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawSocial = (authOpts as any)?.socialProviders as BetterAuthSocialProviders | undefined;
  const socialProviders = github || rawSocial ? ({ ...(rawSocial ?? {}), ...(github ?? {}) } as BetterAuthSocialProviders) : undefined;

  const emailAndPasswordEnabled = Boolean(
    authOpts.providers?.emailAndPassword ?? (authOpts as { emailAndPassword?: boolean }).emailAndPassword,
  );

  // Back-compat shim: allowedEmails / isAllowed → authenticate — all nullable.
  let authenticate: WildwoodAuthenticateFn | undefined | null = authOpts.authenticate ?? undefined;
  {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyOpts = authOpts as any;
    const legacyAllowed = anyOpts?.allowedEmails as string[] | undefined | null;
    const legacyIsAllowed = anyOpts?.isAllowed as
      | ((ctx: { user: WildwoodAuthUser | null; request: Request }) => boolean | Promise<boolean>)
      | undefined
      | null;
    if (!authenticate && (legacyAllowed || legacyIsAllowed)) {
      const allowedEmails = legacyAllowed;
      const isAllowed = legacyIsAllowed;
      authenticate = async ({ user, request }) => {
        if (isAllowed) {
          const r = await isAllowed({ user: user ?? null, request });
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
  }

  const databaseHooks = authenticate ? buildAuthenticateHook(authenticate as WildwoodAuthenticateFn) : undefined;

  // Guard already performed above; libsqlClient is non-null here.;
  const baOpts: BetterAuthOptions = {
    appName: (authOpts.appName ?? "Wildwood") as string,
    ...((authOpts as { secret?: string | undefined | null }).secret ? { secret: (authOpts as { secret?: string | undefined | null }).secret as string } : {}),
    ...(authOpts.baseURL ? { baseURL: authOpts.baseURL as BetterAuthOptions["baseURL"] } : {}),
    ...(authOpts.trustedOrigins ? { trustedOrigins: authOpts.trustedOrigins as BetterAuthOptions["trustedOrigins"] } : {}),
    database: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      dialect: new (LibsqlDialect as any)({ client: libsqlClient as NonNullable<typeof libsqlClient> }),
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

