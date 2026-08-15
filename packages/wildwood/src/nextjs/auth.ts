/**
 * `wildwood/nextjs/auth` — private internal module.
 * Owned by `createWildwoodRoute`.
 *
 * `better-auth` (+ subpaths) and the libsql dialect are bundled into
 * `wildwood/dist` (tsdown `noExternal`). `@libsql/client` (the DB driver)
 * stays external — it's provided by the host app via `createClient({ database })`.
 */

import { betterAuth } from "better-auth";
import { anonymous, deviceAuthorization, jwt } from "better-auth/plugins";
import { nextCookies, toNextJsHandler } from "better-auth/next-js";
import { oauthProvider } from "@better-auth/oauth-provider";
import { cimd } from "@better-auth/cimd";
// `mcpHandler` moved out of `@better-auth/oauth-provider` into `@better-auth/mcp`
// in better-auth 1.7. It's re-exported below so `route.ts` still imports the
// MCP guard through this single bundled boundary.
import { mcpHandler } from "@better-auth/mcp";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import type { WildwoodBootstrapConfig } from "./access";
import sqlSchema from "@/sqlite/schema.json" with { type: "json" };

// Re-export so `route.ts` builds the Next handler without importing
// `better-auth/next-js` itself — one bundling boundary, owned here.
export { toNextJsHandler };

// Re-export the MCP guard through this bundled boundary so `route.ts` never
// imports `@better-auth/mcp` directly. `mcpHandler` verifies the OAuth 2.1
// bearer token and, when absent/invalid, returns the 401 + `WWW-Authenticate`
// discovery response MCP clients follow.
export { mcpHandler };

// Minimal structural type — we only touch a handful of better-auth options.
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
  /** True for the Better Auth identity backing an anonymous preview session. */
  isAnonymous?: boolean;
  /** Internal managed-authority subject selected after credential verification. */
  managedSubjectType?: "user" | "agent" | "anonymous";
};

export type WildwoodAuthAction =
  | { type: "content.read"; ref: string }
  | { type: "git.switchRef"; ref: string }
  | { type: "git.createBranch"; name: string; baseRef?: string }
  | { type: "git.add"; ref: string; paths: string[] }
  | { type: "git.patchWorktree"; ref: string; paths: string[] }
  | { type: "git.commit"; ref: string; message: string }
  | { type: "git.discard"; ref: string }
  | { type: "git.push"; ref: string }
  | { type: "git.pull"; ref: string }
  | { type: "git.merge"; ref: string; message?: string; sourceCommit?: string }
  | { type: "git.createPr"; ref: string; title?: string; body?: string }
  | { type: "branch.share"; ref: string }
  | { type: "content.update"; ref: string; path: string }
  | { type: "content.delete"; ref: string; path: string };

// Generated from the Drizzle schema modules and bundled as JSON so runtime
// initialization never reads schema files from disk.
const WILDWOOD_SCHEMA_SQL = sqlSchema.raw;

function splitSqlStatements(sql: string): string[] {
  return sql
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("--"));
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
  /** Enables convention-first persisted authorization and seeds the first owner. */
  bootstrap?: WildwoodBootstrapConfig | undefined;
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

export type WildwoodAuthInstance = {
  api: { getSession(a: { headers: Headers }): Promise<unknown> };
};

type LibsqlClientLike = {
  execute(s: string | { sql: string; args: unknown[] }): Promise<unknown>;
  close?(): void;
};

export type WildwoodAuthDbInput =
  | LibsqlClientLike
  | {
      libsqlClient?: LibsqlClientLike | undefined;
      client?: LibsqlClientLike | undefined;
      _client?: LibsqlClientLike | undefined;
    }
  | undefined;

function resolveLibsqlClient(db: WildwoodAuthDbInput | undefined): LibsqlClientLike | null {
  if (!db) return null;
  if (typeof (db as LibsqlClientLike).execute === "function") return db as LibsqlClientLike;
  const holder = db as {
    libsqlClient?: LibsqlClientLike;
    client?: LibsqlClientLike;
    _client?: LibsqlClientLike;
  };
  return holder.libsqlClient ?? holder.client ?? holder._client ?? null;
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
  // `createCMS()` resolves `true` from the client's explicit GitHub config.
  // Auth never reaches into process.env for credentials.
  if (raw === true) return undefined;
  // `raw` is { clientId?, clientSecret? } — trim internally so caller doesn't need `.trim()`
  const clientId = typeof raw.clientId === "string" ? raw.clientId.trim() || undefined : undefined;
  const clientSecret =
    typeof raw.clientSecret === "string" ? raw.clientSecret.trim() || undefined : undefined;
  if (!clientId || !clientSecret) return undefined;
  return { clientId, clientSecret };
}

let cachedAuth: {
  key: string;
  client: LibsqlClientLike;
  instance: WildwoodAuthInstance;
  ensurePromise: Promise<void> | null;
} | null = null;

function cacheKey(opts: WildwoodRouteAuthOptions): string {
  const g = normalizeGithubProvider(opts);
  const secretPreview =
    typeof opts.secret === "string" ? opts.secret.trim().slice(0, 8) : "no-secret";
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

/**
 * Parse a `create table "name" (...)` statement into its table name and the
 * list of column definitions (only real columns — table-level constraint
 * clauses like `foreign key`/`primary key (...)` are skipped). Used to
 * reconcile pre-existing tables that were created by an older better-auth
 * schema and are missing columns the current plugin version expects.
 */
function parseCreateTable(
  stmt: string,
): { table: string; columns: { name: string; def: string }[] } | null {
  const m = stmt.match(/^create\s+table\s+[`"]([^`"]+)[`"]\s*\(([\s\S]*)\)\s*$/i);
  if (!m) return null;
  const table = m[1]!;
  const body = m[2]!;
  // Split on top-level commas (depth 0 relative to parentheses in column defs
  // such as `references "user" ("id")`).
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of body) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur);
  const columns: { name: string; def: string }[] = [];
  for (const raw of parts) {
    const def = raw.trim();
    const cm = def.match(/^[`"]([^`"]+)[`"]\s+(.+)$/);
    if (!cm) continue; // table-level constraint, not a column
    columns.push({ name: cm[1]!, def });
  }
  return { table, columns };
}

/** Existing column names for a table, or null if the table doesn't exist. */
async function existingColumns(
  client: LibsqlClientLike,
  table: string,
): Promise<Set<string> | null> {
  try {
    const res = (await client.execute(`PRAGMA table_info("${table}")`)) as {
      rows?: Array<Record<string, unknown>> | unknown[];
    };
    const rows = (res?.rows ?? []) as Array<Record<string, unknown>>;
    if (rows.length === 0) return null;
    const names = new Set<string>();
    for (const row of rows) {
      const name = (row as { name?: unknown }).name;
      if (typeof name === "string") names.add(name);
    }
    return names;
  } catch {
    return null;
  }
}

async function ensureWildwoodTables(client: LibsqlClientLike): Promise<void> {
  for (const stmt of splitSqlStatements(WILDWOOD_SCHEMA_SQL)) {
    try {
      await client.execute(stmt);
    } catch (e) {
      if (!(e instanceof Error) || !/already exists/i.test(e.message)) throw e;
      // Table already exists from an older schema version — reconcile it by
      // adding any columns the generated Drizzle schema expects but the live
      // table is missing. SQLite `ADD COLUMN` is a cheap metadata-only op and
      // can't add UNIQUE/PRIMARY KEY, so we strip those tokens from the def.
      const parsed = parseCreateTable(stmt);
      if (!parsed) continue;
      const have = await existingColumns(client, parsed.table);
      if (!have) continue;
      for (const col of parsed.columns) {
        if (have.has(col.name)) continue;
        const addable = col.def
          .replace(/\bprimary key\b/gi, "")
          .replace(/\bunique\b/gi, "")
          .replace(/\s+/g, " ")
          .trim();
        try {
          await client.execute(`ALTER TABLE "${parsed.table}" ADD COLUMN ${addable}`);
        } catch (addErr) {
          if (!(addErr instanceof Error) || !/duplicate column/i.test(addErr.message)) throw addErr;
        }
      }
    }
  }
}

function randomSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function getOrCreatePersistedSecret(client: LibsqlClientLike): Promise<string> {
  const key = "better-auth.secret";
  const now = new Date().toISOString();
  const candidate = randomSecret();
  await client.execute({
    sql: `insert or ignore into "wildwood_auth_setting"
      ("key", "value", "created_at", "updated_at") values (?, ?, ?, ?)`,
    args: [key, candidate, now, now],
  });
  const result = (await client.execute({
    sql: `select "value" from "wildwood_auth_setting" where "key" = ? limit 1`,
    args: [key],
  })) as { rows?: Array<Record<string, unknown>> };
  const value = result.rows?.[0]?.value;
  if (typeof value !== "string" || !value) {
    throw new Error("Wildwood could not initialize its persisted Better Auth secret.");
  }
  return value;
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
        (genericCtx as any)?.request ??
        (genericCtx as any)?.context?.request ??
        new Request("http://localhost");
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
          const ep =
            (genericCtx as {
              context?: { request?: Request };
              path?: string;
              request?: { url?: string };
            }) ?? {};
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
 * Compute the absolute RFC 8707 resource identifier for the MCP endpoint.
 *
 * MCP clients read the protected-resource discovery doc (`resource:
 * ${origin}${mcpPath}`) and send that exact string as the `resource` param on
 * the OAuth authorize/token requests. The oauth-provider rejects any `resource`
 * that isn't a seeded `oauthResource` row (`invalid_target`), so we must seed
 * the same absolute URL here.
 *
 * Only the string form of `baseURL` yields a known origin at boot. When
 * `baseURL` is autodetected (object form / omitted), we can't know the origin
 * until a request arrives, so we skip static seeding — configure a string
 * `baseURL` to enable MCP OAuth in that deployment.
 */
function resolveMcpResourceIdentifier(
  baseURL: WildwoodBaseURL | undefined,
  mcpPath: string | undefined,
): string | undefined {
  if (!mcpPath) return undefined;
  const base = typeof baseURL === "string" ? baseURL.trim() : "";
  if (!base) return undefined;
  const origin = base.replace(/\/+$/, "");
  const path = mcpPath.startsWith("/") ? mcpPath : `/${mcpPath}`;
  return `${origin}${path}`;
}

export async function getOrCreateAuth(opts: {
  auth: WildwoodRouteAuthOptions | undefined;
  db: WildwoodAuthDbInput | undefined;
  /** Resolved MCP endpoint path (e.g. `/api/wildwood/mcp`) to seed as an OAuth resource. */
  mcpPath?: string | undefined;
}): Promise<{
  auth: WildwoodAuthInstance;
  ensureAuthSchema: () => Promise<void>;
}> {
  const authOpts: WildwoodRouteAuthOptions = opts.auth ?? {};
  const maybeClient = resolveLibsqlClient(opts.db);
  if (!maybeClient)
    throw new Error(
      "Wildwood auth requires a libsql client — pass createClient({ database }) and forward its db.",
    );
  const libsqlClient: LibsqlClientLike = maybeClient;

  const key = cacheKey(authOpts);
  if (cachedAuth && cachedAuth.key === key && cachedAuth.client === libsqlClient) {
    // libsqlClient is stable — reuse cached ensuring same client; safe to capture here.
    const lc: LibsqlClientLike = libsqlClient;
    return {
      auth: cachedAuth.instance,
      ensureAuthSchema: () => {
        if (!cachedAuth!.ensurePromise) cachedAuth!.ensurePromise = ensureWildwoodTables(lc);
        return cachedAuth!.ensurePromise;
      },
    };
  }

  const githubPair = normalizeGithubProvider(authOpts);
  const github = githubPair ? { github: githubPair } : undefined;

  const rawSocial = authOpts.providers?.socialProviders;
  const socialProviders =
    github || rawSocial
      ? ({ ...(rawSocial ?? {}), ...(github ?? {}) } as BetterAuthSocialProviders)
      : undefined;

  const emailAndPasswordEnabled = Boolean(authOpts.providers?.emailAndPassword);

  // Open (unauthenticated) Dynamic Client Registration — RFC 7591. MCP clients
  // like fx present only a URL: they hit `POST /oauth2/register` with no session
  // and no initial access token, so the oauth-provider's default gate rejects
  // them with 401 "Authentication required for client registration". Enabling
  // this lets those clients self-register; token issuance is still gated behind
  // the login + consent pages, so open registration only creates a client row.
  // Dev-only: production keeps CIMD / session-backed registration as the path,
  // so the prod server never accepts anonymous client records.
  const allowOpenClientRegistration = process.env.NODE_ENV !== "production";

  // RFC 8707 resource: the MCP endpoint must be a known `oauthResource` or the
  // authorize/token endpoints reject the `resource` param MCP clients send
  // (`invalid_target`). Seed it from the same origin+path the protected-resource
  // discovery doc advertises.
  const mcpResourceIdentifier = resolveMcpResourceIdentifier(authOpts.baseURL, opts.mcpPath);

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

  // The convention-first CMS does not require a host secret. Generate one once
  // and persist it beside the auth tables so sessions remain valid across deploys.
  await ensureWildwoodTables(libsqlClient);
  const appNameTrimmed = authOpts.appName?.trim() || "Wildwood";
  const secretTrimmed = authOpts.secret?.trim() || (await getOrCreatePersistedSecret(libsqlClient));

  const baOpts: BetterAuthOptions = {
    appName: appNameTrimmed,
    ...(secretTrimmed ? { secret: secretTrimmed } : {}),
    ...(authOpts.baseURL ? { baseURL: authOpts.baseURL as BetterAuthOptions["baseURL"] } : {}),
    ...(authOpts.trustedOrigins
      ? { trustedOrigins: authOpts.trustedOrigins as BetterAuthOptions["trustedOrigins"] }
      : {}),
    database: {
      dialect: new (LibsqlDialect as unknown as { new (a: unknown): unknown })({
        client: libsqlClient,
      }),
      type: "sqlite" as const,
    },
    emailAndPassword: emailAndPasswordEnabled ? { enabled: true } : { enabled: false },
    ...(socialProviders ? { socialProviders } : {}),
    ...(databaseHooks
      ? { databaseHooks: { user: databaseHooks } as BetterAuthOptions["databaseHooks"] }
      : {}),
    // NOTE: hardcoded device-authorization spike (RFC 8628). Endpoints are
    // auto-served by handleAuth at /api/auth/device/{code,token,approve,deny}.
    //
    // `oauthProvider` (OAuth 2.1) turns this app into an authorization server so
    // MCP clients can self-register (RFC 7591 dynamic client registration) and
    // obtain scoped, JWKS-signed access tokens with only a URL — no static
    // credentials. It requires `jwt` for the signing keys (`jwks` table + `/jwks`
    // endpoint). Discovery + `/oauth2/*` endpoints are auto-served under
    // `/api/auth/*`; the MCP endpoint itself lives at `/api/wildwood/mcp` and is
    // guarded by `mcpHandler` (see handlers/mcp-router.ts).
    //
    // `loginPage`/`consentPage` reuse the library's own device-auth router pages
    // so nothing bleeds into userland. `nextCookies()` must stay last per
    // better-auth guidance.
    plugins: [
      anonymous(),
      deviceAuthorization({ verificationUri: "/api/wildwood/device" }),
      jwt(),
      oauthProvider({
        loginPage: "/api/wildwood/device/signin",
        consentPage: "/api/wildwood/device/consent",
        // Kept as a fallback for MCP clients that can't yet present a URL
        // `client_id`. CIMD (below) is the preferred path; DCR may create
        // duplicate client rows for the same logical client.
        allowDynamicClientRegistration: true,
        // In dev, allow URL-only MCP clients (e.g. fx) to self-register without
        // a session or initial access token. Off in production — see above.
        allowUnauthenticatedClientRegistration: allowOpenClientRegistration,
        // Seed the MCP endpoint as an RFC 8707 protected resource so token
        // requests targeting it are accepted. Empty when baseURL isn't a static
        // string (autodetected origin) — see resolveMcpResourceIdentifier.
        ...(mcpResourceIdentifier ? { resources: [mcpResourceIdentifier] } : {}),
        // Self-registered MCP clients (CIMD / DCR) have no `oauthClientResource`
        // link rows, so per-client resource enforcement would reject them with
        // `invalid_target` even after the resource is seeded. Disable it: any
        // enabled resource is requestable by any client, which matches the
        // single-resource MCP model.
        enforcePerClientResources: false,
      }) as never,
      // CIMD (Client ID Metadata Documents): lets MCP clients identify
      // themselves with an HTTPS URL `client_id` — no pre-registration, no
      // static credentials. `allowLoopback` is required for local dev because
      // the dev origin is a loopback host (`ww.localhost`); it stays off in
      // production so the server never fetches its own loopback interface.
      cimd({ allowLoopback: true }) as never,
      nextCookies(),
    ],
  };

  const instance = (betterAuth as unknown as (o: BetterAuthOptions) => WildwoodAuthInstance)(
    baOpts,
  );

  let ensurePromise: Promise<void> | null = Promise.resolve();
  function ensureAuthSchema(): Promise<void> {
    if (!ensurePromise) ensurePromise = ensureWildwoodTables(libsqlClient);
    return ensurePromise;
  }

  cachedAuth = { key, client: libsqlClient, instance, ensurePromise };
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
    isAnonymous:
      typeof rec.isAnonymous === "boolean"
        ? rec.isAnonymous
        : rec.isAnonymous === 1
          ? true
          : undefined,
  };
}

export async function getSessionUser(
  auth: WildwoodAuthInstance,
  headers: Headers,
): Promise<{ session: unknown; user: WildwoodAuthUser | null } | null> {
  const s = await (
    auth as { api: { getSession(a: { headers: Headers }): Promise<unknown> } }
  ).api.getSession({ headers });
  if (!s) return null;
  return { session: s, user: userFromSession(s) };
}

/** @deprecated use `authenticate` instead */
export function isAllowedByEmailList(
  user: WildwoodAuthUser | null,
  allowedEmails: string[] | undefined,
): boolean {
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
