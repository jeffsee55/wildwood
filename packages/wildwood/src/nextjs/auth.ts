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

export type WildwoodAuthProviders = {
  github?:
    | boolean
    | false
    | { clientId?: string | undefined; clientSecret?: string | undefined }
    | undefined;
  socialProviders?: BetterAuthSocialProviders | undefined;
  emailAndPassword?: boolean | undefined;
};

export type WildwoodRouteAuthOptions = {
  /** Optional — trimmed internally; pass `process.env.X` directly. */
  secret?: string | undefined;
  baseURL?: WildwoodBaseURL | undefined;
  trustedOrigins?: WildwoodTrustedOrigins | undefined;
  appName?: string | undefined;

  github?: WildwoodAuthProviders["github"] | false | undefined;
  providers?: WildwoodAuthProviders | undefined;

  authenticate?: WildwoodAuthenticateFn | undefined;
  authorize?: WildwoodAuthorizeFn | undefined;

  /** @deprecated use `authenticate` */
  allowedEmails?: string[] | undefined;
  /** @deprecated use `authenticate` */
  isAllowed?:
    | ((ctx: { user: WildwoodAuthUser | null; request: Request }) => boolean | Promise<boolean>)
    | undefined;
  /** @deprecated DB now comes from createClient */
  database?: { url?: string | undefined; authToken?: string | undefined } | undefined;
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

type LibsqlClientLike = { execute(s: string): Promise<unknown>; close?(): void };

export type WildwoodAuthDbInput =
  | LibsqlClientLike
  | { libsqlClient?: LibsqlClientLike | undefined; client?: LibsqlClientLike | undefined; _client?: LibsqlClientLike | undefined }
  | undefined;

function resolveLibsqlClient(db: WildwoodAuthDbInput | undefined): LibsqlClientLike | null {
  if (!db) return null;
  if (typeof (db as LibsqlClientLike).execute === "function") return db as LibsqlClientLike;
  const holder = db as { libsqlClient?: LibsqlClientLike; client?: LibsqlClientLike; _client?: LibsqlClientLike };
  return holder.libsqlClient ?? holder.client ?? holder._client ?? null;
}

function envTrim(name: string): string | undefined {
  const v = process.env[name];
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t : undefined;
}
function normalizeGithubProvider(
  opts: WildwoodRouteAuthOptions,
): { clientId: string; clientSecret: string } | undefined {
  // `opts` fields already normalized by callers via `normalizeProviderConfig`-like pattern,
  // but we still tolerate raw shapes here without casts.
  // Types now include `false` union for `github`, so narrowing is safe without `as any`.
  const providers = opts.providers;
  const topLevel = opts.github;

  // `false` disables
  if (providers?.github === false || topLevel === false) return undefined;

  const raw = providers?.github ?? topLevel;
  if (!raw) return undefined;
  if (raw === true) {
    const cid = envTrim("GITHUB_CLIENT_ID");
    const csec = envTrim("GITHUB_CLIENT_SECRET");
    if (!cid || !csec) return undefined;
    return { clientId: cid, clientSecret: csec };
  }
  // `raw` is { clientId?, clientSecret? } — trim internally so caller doesn't need `.trim()`
  const clientId = typeof raw.clientId === "string" ? raw.clientId.trim() || undefined : undefined;
  const clientSecret = typeof raw.clientSecret === "string" ? raw.clientSecret.trim() || undefined : undefined;
  if (!clientId || !clientSecret) return undefined;
  return { clientId, clientSecret };
}

let cachedAuth: { key: string; instance: WildwoodAuthInstance; ensurePromise: Promise<void> | null } | null = null;

function cacheKey(opts: WildwoodRouteAuthOptions): string {
  const g = normalizeGithubProvider(opts);
  const secretPreview = typeof opts.secret === "string" ? opts.secret.trim().slice(0, 8) : "no-secret";
  const baseLabel =
    typeof opts.baseURL === "string"
      ? opts.baseURL.trim()
      : opts.baseURL
        ? JSON.stringify(opts.baseURL).slice(0, 120)
        : "auto-base";
  const trustedLabel =
    typeof opts.trustedOrigins === "function"
      ? "fn-trusted"
      : Array.isArray(opts.trustedOrigins)
        ? opts.trustedOrigins.join("|").slice(0, 80)
        : opts.trustedOrigins
          ? JSON.stringify(opts.trustedOrigins).slice(0, 80)
          : "auto-trusted";
  return [
    secretPreview,
    g?.clientId ?? "no-github",
    baseLabel,
    trustedLabel,
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

export async function getOrCreateAuth(opts: {
  auth: WildwoodRouteAuthOptions | undefined;
  db: WildwoodAuthDbInput | undefined;
}): Promise<{
  auth: WildwoodAuthInstance;
  ensureAuthSchema: () => Promise<void>;
}> {
  const authOpts: WildwoodRouteAuthOptions = opts.auth ?? {};
  const maybeClient = resolveLibsqlClient(opts.db);
  if (!maybeClient) throw new Error("Wildwood auth requires a libsql client — pass createClient({ database }) and forward its db.");
  const libsqlClient: LibsqlClientLike = maybeClient;

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

  const rawSocial = authOpts.providers?.socialProviders;
  const socialProviders = github || rawSocial
    ? ({ ...(rawSocial ?? {}), ...(github ?? {}) } as BetterAuthSocialProviders)
    : undefined;

  const emailAndPasswordEnabled = Boolean(authOpts.providers?.emailAndPassword);

  let authenticate = authOpts.authenticate;
  {
    const legacyAllowed = authOpts.allowedEmails;
    const legacyIsAllowed = authOpts.isAllowed;
    if (!authenticate && (legacyAllowed || legacyIsAllowed)) {
      const allowedEmails = legacyAllowed
        ? legacyAllowed.map((e) => e.trim().toLowerCase()).filter(Boolean)
        : undefined;
      authenticate = async ({ user, request }) => {
        if (legacyIsAllowed) {
          const ok = await legacyIsAllowed({ user: user ?? null, request });
          if (!ok) return false;
        }
        if (allowedEmails) {
          const lower = user.email?.trim().toLowerCase() ?? "";
          if (!lower) return false;
          if (allowedEmails.length === 0) return true;
          return allowedEmails.includes(lower);
        }
        return true;
      };
    }
  }

  const databaseHooks = authenticate ? buildAuthenticateHook(authenticate) : undefined;

  const appNameTrimmed = authOpts.appName?.trim() || "Wildwood";
  const secretTrimmed = authOpts.secret?.trim() || undefined;

  const baOpts: BetterAuthOptions = {
    appName: appNameTrimmed,
    ...(secretTrimmed ? { secret: secretTrimmed } : {}),
    ...(authOpts.baseURL ? { baseURL: authOpts.baseURL as BetterAuthOptions["baseURL"] } : {}),
    ...(authOpts.trustedOrigins ? { trustedOrigins: authOpts.trustedOrigins as BetterAuthOptions["trustedOrigins"] } : {}),
    database: {
      dialect: new (LibsqlDialect as unknown as { new (a: unknown): unknown })({ client: libsqlClient }),
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

