/**
 * `wildwood/nextjs/route` — the only route file you need.
 *
 * Single catch-all:
 *   app/api/[...path]/route.ts
 *     export const { GET, POST, HEAD, OPTIONS, PUT, PATCH, DELETE } =
 *       createWildwoodRoute(() => wildwood, { auth: { ... } });
 *
 * What it owns:
 * - /api/wildwood/*  (git, github, vscode) via H3 handler
 * - /api/wildwood/draft  + /api/wildwood/preview  (draft/preview toggle, per-user)
 * - /api/auth/*  + /api/wildwood/auth/*  (better-auth)
 * - /api/wildwood/auth/capabilities  (Kit can hide edit buttons pre-flight)
 * - branch cookie + revalidateTag on mutations
 *
 * Autodetect:
 * - baseURL optional. When omitted better-auth derives origin from Request
 *   (origin/x-forwarded-host/proto+request.url). Works for localhost, Vercel
 *   previews (*.vercel.app), custom domains — no env mapping needed.
 * - trustedOrigins optional. Defaults to derived baseURL origin. Accepts
 *   static string[] or `(req)=>string[]|Promise<string[]>` for userland mapping.
 * - No auth env fallbacks inside wildwood; credentials come from explicit client config.
 *   DB is not configured here; it's reused from `createClient({ database })`.
 *   GitHub sign-in is `github: true | { clientId, clientSecret }` — `true`
 *   reuses the same explicit GitHub App creds used for git writes.
 *   Auth: `authenticate` = sign-in/sign-up gate, `authorize` = an optional
 *   additional per-action restriction.
 */

import { cookies } from "next/headers";
import { revalidateTag } from "next/cache";
import { NextResponse } from "next/server";
import {
  WILDWOOD_BRANCH_COOKIE,
  WILDWOOD_BRANCH_COOKIE_FALLBACKS,
  WILDWOOD_CACHE_TAG,
  type WildwoodForBranch,
} from "./branch";
import { handle as createNextHandle } from "./handler";
import { resolveWildwoodPaths, type WildwoodWellKnownOptions } from "./config";
import { renderCmsApprovalPage } from "./cms-approval-page";
import { renderCmsDatabasePage } from "./cms-database-page";
import { renderCmsWorkIntentPage } from "./cms-work-intent-page";
import type { WildwoodClient } from "@/client/index";
import {
  activeRefSetCookieHeader,
  clearBranchCookieHeader,
  generateBranchName,
} from "wildwood-shared";

export { WILDWOOD_BRANCH_COOKIE, WILDWOOD_CACHE_TAG };

// --- auth types re-exported for convenience so app can import from "wildwood/nextjs/route"
// All `authenticate` / `authorize` / identity / action types live here —
// provider / client is transport-only, no authz.
export type {
  WildwoodAuthAction,
  WildwoodAuthenticateContext,
  WildwoodAuthenticateFn,
  WildwoodAuthUser,
  WildwoodAuthorizeContext,
  WildwoodAuthorizeFn,
  WildwoodBaseURL,
  WildwoodRouteAuthOptions,
  WildwoodTrustedOrigins,
} from "./auth";
export type {
  WildwoodBootstrapConfig,
  WildwoodAgentSession,
  WildwoodGrant,
  WildwoodGrantConstraints,
  WildwoodPermission,
  WildwoodProject,
  WildwoodProjectInput,
  WildwoodRefSelector,
} from "./access";
import type { WildwoodAuthAction } from "./auth";
import * as authModule from "./auth";
import {
  WILDWOOD_PERMISSIONS,
  authorizeManagedAction,
  authorizeManagedPermission,
  createAgentBranchGrant,
  createAgentSession,
  createContributorAccess,
  createContributorBranchAccess,
  createMergeApprovalRequest,
  decideApprovalRequest,
  ensureBootstrapOwner,
  listApprovalRequests,
  listProjectGrants,
  revokeGrant,
  resolveProject,
  selectorsMatch,
  verifyAgentSession,
  type WildwoodAccessDb,
  type WildwoodPermission,
  type WildwoodProject,
} from "./access";
import {
  createWorkIntent,
  decideWorkIntent,
  getWorkIntent,
  type WildwoodWorkIntent,
} from "./work-intent";
import {
  revokePreviewToken,
  createPreviewToken,
  verifyPreviewToken,
} from "./handlers/preview-token";
import { handleMcpRequest } from "./handlers/mcp-server";
import type { McpAuthorizeFn } from "./handlers/mcp-server";

const DEFAULT_MUTATION_RE = /\/git\/(commit|discard|merge|pull|create-branch|switch-branch)\/?$/;

/** Preview token endpoints — create / revoke / preview. */
function isPreviewTokenPath(pathname: string): boolean {
  return /\/wildwood\/preview-token(?:\/|$)/.test(pathname);
}

function isPreviewPath(pathname: string): boolean {
  return /\/wildwood\/preview(?:\/|$)/.test(pathname) && !isPreviewTokenPath(pathname);
}

export type CreateWildwoodRouteOptions = {
  revalidateTagName?: string;
  branchCookieName?: string;
  legacyCookieNames?: readonly string[];
  mutationRe?: RegExp;
  revalidateTagStore?: "default" | "layout";
  /**
   * Exposes the bootstrap-owner-only `/wildwood/cms/database` management page
   * and destructive `POST /wildwood/access/reset` prototype action.
   * This destroys every user, session, grant, approval, and indexed Git value
   * in the shared database. Never enable it for a stable production system.
   */
  dangerouslyAllowDatabaseReset?: boolean;
  /**
   * When true, `getClient` is called per-request with Request.
   * Needed for apps like `play` where org/repo comes from a cookie.
   * Auto-detected when `getClient.length >= 1`, but you can force it.
   */
  requestAware?: boolean;

  /**
   * Where the Wildwood catch-all is mounted and where the MCP resource / auth
   * issuer live. Must match the value passed to `wildwoodWellKnown()` in
   * `next.config` so the rewrite sources and the generated/proxied discovery
   * docs stay in lockstep.
   *
   * String shorthand for `{ base }` (default `/api`); object form sets the MCP
   * resource path and auth issuer path independently. Everything below —
   * generated protected-resource metadata, the proxied authorization-server
   * doc, and the MCP endpoint's OAuth resource/audience — derives from this.
   */
  wellKnown?: string | WildwoodWellKnownOptions;

  /**
   * Optional auth config. When present, route.ts owns better-auth entirely:
   * - /api/auth/* and /api/wildwood/auth/* → better-auth handler
   * - git endpoints → session → authenticate → authorize gate
   * - /api/wildwood/auth/capabilities → pre-flight for Kit
   *
   * DB is NOT configured here — it's re-used from `createClient({ database })`
   * which is already the Turso/LibSQL client. No `database:` field.
   *
   * Managed GitHub sign-in reuses the explicit credentials on the same GitHub
   * App config that provides git writes. Only pass `{ clientId, clientSecret }`
   * if sign-in creds differ. `false` disables GitHub sign-in.
   * Future: `providers: { gitlab: true, google: true }`.
   *
   * No auth env fallbacks inside wildwood.
   * `baseURL`/`trustedOrigins` optional: autodetected from Request.
   *
   * Example:
   *   createWildwoodRoute(() => wildwood, {
   *     auth: { bootstrap: { owner: "owner@example.com" } },
   *   })
   */
  auth?: import("./auth").WildwoodRouteAuthOptions;
  /** Future alias for `auth` — will become `providers` / `auth` unified */
  providers?: import("./auth").WildwoodRouteAuthOptions;
};

type LazyHandler = ReturnType<typeof createNextHandle>;

function pathnameOf(req: Request): string {
  try {
    return new URL(req.url).pathname;
  } catch {
    return "";
  }
}

function cookieHeaderValue(name: string, ref: string, maxAge?: number): string {
  if (maxAge === 0) return clearBranchCookieHeader(name);
  return activeRefSetCookieHeader(ref, name);
}

function isAuthPath(pathname: string): boolean {
  // /api/auth/*  (canonical better-auth)  and  /api/wildwood/auth/*  (namespaced alias)
  return /\/auth(?:\/|$)/.test(pathname);
}

/** The authenticated MCP endpoint — JSON-RPC over Streamable HTTP. */
function isMcpPath(pathname: string): boolean {
  return /\/wildwood\/mcp(?:\/|$)/.test(pathname);
}

/**
 * MCP OAuth discovery documents. Clients probe these at the ORIGIN ROOT (per the
 * MCP auth spec + RFC 8414 / RFC 9728), not under `/api/*`. `withWildwood`
 * rewrites the root `/.well-known/oauth-*` paths into `/api/wildwood/.well-known/*`
 * so they reach this handler, which proxies them to the better-auth-served
 * `/api/auth/*` metadata endpoints. We accept both the rewritten form and the
 * raw root form (in case a host wires routing differently).
 */
function isOAuthDiscoveryPath(pathname: string): boolean {
  return /(?:^|\/)\.well-known\/(oauth-authorization-server|oauth-protected-resource|openid-configuration)/.test(
    pathname,
  );
}

function isCapabilitiesPath(pathname: string): boolean {
  return (
    pathname.endsWith("/auth/capabilities") || pathname.endsWith("/wildwood/auth/capabilities")
  );
}

function isAccessPath(pathname: string): boolean {
  return /\/wildwood\/access(?:\/|$)/.test(pathname);
}

function isCmsDatabasePath(pathname: string): boolean {
  return /\/wildwood\/cms\/database\/?$/.test(pathname);
}

function isDraftPath(pathname: string): boolean {
  return (
    pathname.endsWith("/wildwood/draft") ||
    pathname.endsWith("/tr33/draft") ||
    pathname.endsWith("/draft")
  );
}

function isExitPreviewPath(pathname: string): boolean {
  return pathname.endsWith("/wildwood/preview") || pathname.endsWith("/preview/exit");
}

function gitActionFromPathname(pathname: string, bodyHint?: unknown): WildwoodAuthAction | null {
  const m = pathname.match(/\/git\/([^/?]+)/);
  if (!m) return null;
  const op = m[1]!;
  const b = bodyHint as Record<string, unknown> | undefined;
  const ref = typeof b?.ref === "string" ? b.ref : typeof b?.name === "string" ? b.name : "main";
  const paths = Array.isArray(b?.paths) ? (b!.paths as string[]) : [];
  switch (op) {
    case "switch-branch":
      return { type: "git.switchRef", ref };
    case "create-branch":
      return {
        type: "git.createBranch",
        name: typeof b?.name === "string" ? b!.name : ref,
        baseRef: typeof b?.baseRef === "string" ? b.baseRef : undefined,
      };
    case "add":
      return { type: "git.add", ref, paths };
    case "commit":
      return { type: "git.commit", ref, message: typeof b?.message === "string" ? b.message : "" };
    case "discard":
      return { type: "git.discard", ref };
    case "push":
      return { type: "git.push", ref };
    case "pull":
      return { type: "git.pull", ref };
    case "merge":
      return {
        type: "git.merge",
        ref,
        message: typeof b?.message === "string" ? b.message : undefined,
      };
    default:
      return null;
  }
}

/** Back-compat shim for one minor — synthesize `authenticate` from deprecated shape. */
function synthesizeAuthenticateFromLegacy(
  authOpts: import("./auth").WildwoodRouteAuthOptions,
): import("./auth").WildwoodAuthenticateFn | null {
  const allowedEmails = (authOpts as { allowedEmails?: string[] }).allowedEmails;
  const isAllowedLegacy = (
    authOpts as {
      isAllowed?: (ctx: {
        user: import("./auth").WildwoodAuthUser | null;
        request: Request;
      }) => boolean | Promise<boolean>;
    }
  ).isAllowed;
  if (!allowedEmails && !isAllowedLegacy) return null;
  return async ({ user, request }) => {
    if (isAllowedLegacy) {
      const ok = await isAllowedLegacy({ user, request });
      if (!ok) return false as const;
    }
    if (allowedEmails) {
      const lower = user.email?.toLowerCase() ?? "";
      if (!lower) return false as const;
      if (allowedEmails.length === 0) return true as const;
      return allowedEmails.some((e) => e.toLowerCase() === lower);
    }
    return true as const;
  };
}

export type WildwoodRouteClientInput =
  | WildwoodClient
  | {
      _?: {
        config?: { ref?: string | undefined; org?: string | undefined; repo?: string | undefined };
      } & Record<string, unknown>;
    }
  | Record<string, unknown>;

export function createWildwoodRoute(
  getClient:
    | ((req?: Request) => WildwoodRouteClientInput | Promise<WildwoodRouteClientInput>)
    | (() => WildwoodRouteClientInput | Promise<WildwoodRouteClientInput>),
  opts: CreateWildwoodRouteOptions = {},
) {
  const tagName = opts.revalidateTagName ?? WILDWOOD_CACHE_TAG;
  const cookieName = opts.branchCookieName ?? WILDWOOD_BRANCH_COOKIE;
  const legacyNames = opts.legacyCookieNames ?? WILDWOOD_BRANCH_COOKIE_FALLBACKS;
  const mutationRe = opts.mutationRe ?? DEFAULT_MUTATION_RE;
  const tagStore = opts.revalidateTagStore ?? "default";
  const authOpts = opts.auth;
  const managedAuth = authOpts?.bootstrap;
  // Absolute URL paths for the MCP resource, auth issuer, and catch-all mount.
  // Single source of truth shared with `wildwoodWellKnown()` in next.config.
  const wwPaths = resolveWildwoodPaths(opts.wellKnown);

  // For apps where client is static (docs), we cache handler. For per-request clients (play),
  // we detect `getClient.length >= 1` or caller opts requestAware.
  const isRequestAware = (opts as { requestAware?: boolean }).requestAware || getClient.length >= 1;

  async function accessContext(client: WildwoodClient): Promise<{
    db: WildwoodAccessDb;
    project: WildwoodProject;
  }> {
    const config = client._.config;
    const db = client._.db.client as unknown as WildwoodAccessDb;
    const remote = client._.git.remote as unknown as {
      getRepositoryIdentity?: () => Promise<{ provider: string; externalId: string }>;
    };
    let repositoryIdentity: { provider: string; externalId: string } | undefined;
    try {
      repositoryIdentity = await remote.getRepositoryIdentity?.();
    } catch {
      // Local/native remotes and temporarily unavailable GitHub APIs still resolve
      // by canonical name; a later successful request binds the immutable id.
    }
    return {
      db,
      project: await resolveProject({
        db,
        project: {
          provider: repositoryIdentity?.provider ?? "github",
          externalId: repositoryIdentity?.externalId,
          org: config.org,
          repo: config.repo,
          configRef: config.ref,
        },
      }),
    };
  }

  async function availableManagedBranchName(client: WildwoodClient): Promise<string> {
    await client._.db.init();
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const candidate = generateBranchName();
      if (!(await client._.db.refs.get({ ref: candidate }))) return candidate;
    }
    throw new Error("Could not allocate a unique branch name");
  }

  function managedBranchCreation(
    client: WildwoodClient,
    access: { db: WildwoodAccessDb; project: WildwoodProject },
    userId: string,
  ) {
    return {
      generateName: () => availableManagedBranchName(client),
      onCreated: (ref: string) =>
        createContributorBranchAccess({
          ...access,
          userId,
          ref,
        }).then(() => undefined),
    };
  }

  async function managedMcpAgentId(
    projectId: string,
    userId: string,
    jwt: Record<string, unknown>,
  ): Promise<string> {
    const clientId =
      [jwt.client_id, jwt.clientId, jwt.azp].find(
        (value): value is string => typeof value === "string" && value.length > 0,
      ) ?? "oauth-client";
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${projectId}\0${userId}\0${clientId}`),
    );
    const id = Array.from(new Uint8Array(digest).slice(0, 18), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    return `agent_mcp_${id}`;
  }

  async function evaluateManagedAccess(
    client: WildwoodClient,
    user: import("./auth").WildwoodAuthUser | null,
    action: WildwoodAuthAction,
  ): Promise<Response | null> {
    if (!managedAuth) return null;
    const { db, project } = await accessContext(client);
    const decision = await authorizeManagedAction({ db, project, user, action });
    if (decision.allowed) return null;
    return new Response(decision.reason, {
      status: user ? 403 : 401,
      statusText: user ? "Forbidden" : "Unauthorized",
    });
  }

  async function databaseOwnerGate(args: {
    db: WildwoodAccessDb;
    project: WildwoodProject;
    user: import("./auth").WildwoodAuthUser | null;
  }): Promise<Response | null> {
    const isBootstrapOwner =
      Boolean(args.user?.email) &&
      args.user!.email!.trim().toLowerCase() === managedAuth?.owner.trim().toLowerCase();
    if (!isBootstrapOwner) {
      return NextResponse.json(
        { error: "Only the configured bootstrap owner can manage the database" },
        { status: args.user ? 403 : 401 },
      );
    }
    const decision = await authorizeManagedPermission({
      db: args.db,
      project: args.project,
      user: args.user,
      permission: "access.manage",
    });
    return decision.allowed
      ? null
      : NextResponse.json({ error: decision.reason }, { status: args.user ? 403 : 401 });
  }

  // Shared authorizer injected into H3 git handlers — only owns authz lives here.
  // H3 routers may not have request yet when constructed, so we build an
  // authorize fn that closes over authOpts + per-request user resolution.
  // If authOpts absent, authorize is undefined (allow-all, matches route gate).
  let gitAuthorizeForH3:
    | ((req: Request, action: WildwoodAuthAction) => Promise<Response | null>)
    | undefined;

  async function buildGitAuthorizeForRequest(
    req: Request,
  ): Promise<(req: Request, action: WildwoodAuthAction) => Promise<Response | null>> {
    if (!authOpts) return async () => null;
    return async (innerReq: Request, action: WildwoodAuthAction) => {
      const authRes = await resolveAuthUserFromRequest(innerReq ?? req);
      const user = authRes?.user ?? null;
      const mod = authModule;

      if (managedAuth) {
        const client = await resolveClient(innerReq ?? req);
        const managedGate = await evaluateManagedAccess(client, user, action);
        if (managedGate) return managedGate;
      }

      const authFn = authOpts.authenticate ?? synthesizeAuthenticateFromLegacy(authOpts);
      if (authFn) {
        const gate = await mod.evaluateAuthenticate(
          authFn as never,
          user as never,
          innerReq ?? req,
        );
        if (gate) {
          if (!user) return new Response("Authentication required", { status: 401 });
          if (gate instanceof Response) return gate;
          return new Response("Forbidden", { status: 403 });
        }
      }
      if (!authOpts.authorize) return null;
      const result = await authOpts.authorize({
        user: user as never,
        action: action as never,
        request: innerReq ?? req,
      });
      if (result instanceof Response) return result;
      if (result === false) return new Response("Forbidden", { status: 403 });
      return null;
    };
  }

  let staticHandlerPromise: Promise<LazyHandler> | null = null;

  /**
   * Build an MCP authorizer gate that returns `string | null` (error message
   * or allow) instead of `Response | null`. The MCP path doesn't have a
   * session cookie, so we build the user from the JWT and run the same
   * `authenticate` + `authorize` gates the HTTP API uses.
   */
  async function buildMcpAuthorizeForRequest(
    req: Request,
    user: import("./auth").WildwoodAuthUser | null,
  ): Promise<McpAuthorizeFn> {
    if (!authOpts) return async () => null;
    return async (action: WildwoodAuthAction) => {
      const mod = authModule;
      if (managedAuth) {
        const client = await resolveClient(req);
        const managedGate = await evaluateManagedAccess(client, user as never, action);
        if (managedGate) {
          if (
            user?.managedSubjectType === "agent" &&
            user.id &&
            action.type === "git.merge" &&
            action.sourceCommit
          ) {
            const approval = await createMergeApprovalRequest({
              ...(await accessContext(client)),
              requestedBy: user.id,
              sourceRef: action.ref,
              sourceCommit: action.sourceCommit,
              reason: action.message,
            });
            const approvalUrl = `${requestOrigin(req)}${wwPaths.base}/wildwood/access/approvals/${approval.id}`;
            return JSON.stringify({
              error: "approval_required",
              approvalId: approval.id,
              approvalUrl,
              sourceRef: approval.sourceRef,
              targetRef: approval.targetRef,
              sourceCommit: approval.sourceCommit,
              expiresAt: approval.expiresAt,
            });
          }
          return (await managedGate.text()) || managedGate.statusText || "Forbidden";
        }
      }
      const authFn =
        user?.managedSubjectType === "agent"
          ? null
          : (authOpts.authenticate ?? synthesizeAuthenticateFromLegacy(authOpts));
      if (authFn) {
        const gate = await mod.evaluateAuthenticate(authFn as never, user as never, req);
        if (gate) {
          if (!user) return "Authentication required";
          if (gate instanceof Response) return gate.statusText || "Forbidden";
          return "Forbidden";
        }
      }
      if (!authOpts.authorize) return null;
      const result = await authOpts.authorize({
        user: user as never,
        action: action as never,
        request: req,
      });
      if (result instanceof Response) return result.statusText || "Forbidden";
      if (result === false) return "Forbidden";
      return null;
    };
  }

  function getHandlerFor(req?: Request): Promise<LazyHandler> {
    if (isRequestAware && req) {
      // Per-request client (play) — need per-request authorize that can resolve user for this req.
      return (async () => {
        const client = (await (
          getClient as (r?: Request) => WildwoodRouteClientInput | Promise<WildwoodRouteClientInput>
        )(req)) as WildwoodClient;
        const authorize = await buildGitAuthorizeForRequest(req);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return createNextHandle(
          client as unknown as WildwoodForBranch as unknown as WildwoodClient,
          { authorize: authorize as any, requireRefForObjectReads: Boolean(managedAuth) },
        );
      })();
    }
    if (!staticHandlerPromise) {
      staticHandlerPromise = (async () => {
        const client = (await (
          getClient as () => WildwoodRouteClientInput | Promise<WildwoodRouteClientInput>
        )()) as WildwoodClient;
        // Static case — lazily init authorize once; it still resolves user per-request via its own arg.
        if (!gitAuthorizeForH3) {
          // Placeholder that will self-initialize on first call then memoize inner fn.
          // We can't know req here, so build a wrapper that builds real fn per req.
          gitAuthorizeForH3 = async (innerReq: Request, action: WildwoodAuthAction) => {
            const fn = await buildGitAuthorizeForRequest(innerReq);
            return fn(innerReq, action);
          };
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return createNextHandle(
          client as unknown as WildwoodForBranch as unknown as WildwoodClient,
          { authorize: gitAuthorizeForH3 as any, requireRefForObjectReads: Boolean(managedAuth) },
        );
      })();
    }
    return staticHandlerPromise;
  }

  type AuthBundle = typeof authModule;

  // getOrCreateAuth is async — unwrap to avoid Promise<Promise<>>.
  let authInstancePromise: Promise<Awaited<ReturnType<AuthBundle["getOrCreateAuth"]>>> | null =
    null;
  let dbForAuthPromise: Promise<unknown> | null = null;

  function getDbForAuth(req?: Request): Promise<unknown> {
    if (dbForAuthPromise) return dbForAuthPromise;
    dbForAuthPromise = (async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const maybeWithReq = getClient as unknown as (r?: Request | undefined) => any;
      const c = await maybeWithReq(req);
      const rawDb =
        (c as { _?: { db?: { client?: unknown; libsqlClient?: unknown } | unknown } })?._?.db ??
        (c as { db?: unknown })?.db ??
        null;
      return rawDb ?? null;
    })();
    return dbForAuthPromise;
  }

  async function getAuthInstance(req?: Request) {
    if (!authOpts) return null;
    if (!authInstancePromise) {
      authInstancePromise = (async () => {
        const mod = authModule;
        const db = await getDbForAuth(req);
        if (!db)
          throw new Error(
            "Auth requires a database — ensure createClient({ database }) is configured.",
          );
        // getOrCreateAuth itself is async. Pass the resolved MCP path so the
        // oauth-provider can seed it as an RFC 8707 resource — otherwise the
        // authorize/token endpoints reject the `resource` param that MCP
        // clients derive from the protected-resource discovery doc.
        return await mod.getOrCreateAuth({
          // Better Auth plugins need a concrete origin even when the host did
          // not configure one. Resolve it from the first real request: local
          // dev, Vercel previews, and production all use the same path without
          // auth environment variables.
          auth: authOpts.baseURL || !req ? authOpts : { ...authOpts, baseURL: requestOrigin(req) },
          db: db as never,
          mcpPath: wwPaths.mcp,
        });
      })();
    }
    return authInstancePromise;
  }

  async function resolveAuthUserFromRequest(req: Request) {
    if (!authOpts) return null;
    const inst = await getAuthInstance(req);
    if (!inst) return null;
    await inst.ensureAuthSchema();
    const mod = authModule;
    const res = await mod.getSessionUser(inst.auth as never, req.headers as unknown as Headers);
    if (managedAuth && res?.user) {
      const client = await resolveClient(req);
      const { db, project } = await accessContext(client);
      await ensureBootstrapOwner({ db, project, bootstrap: managedAuth, user: res.user });
    }
    return res; // { session, user } | null
  }

  /** Resolve the Wildwood client for a request (handles request-aware clients). */
  async function resolveClient(req: Request): Promise<WildwoodClient> {
    return (await (
      getClient as (r?: Request) => WildwoodRouteClientInput | Promise<WildwoodRouteClientInput>
    )(req)) as WildwoodClient;
  }

  function revalidateContent() {
    revalidateTag(tagName, tagStore as never);
  }

  async function clearBranchCookies(jar: Awaited<ReturnType<typeof cookies>>) {
    jar.delete(cookieName);
    for (const name of legacyNames) if (name !== cookieName) jar.delete(name);
    for (const f of WILDWOOD_BRANCH_COOKIE_FALLBACKS) {
      if (f !== cookieName && !(legacyNames as readonly string[]).includes(f)) jar.delete(f);
    }
    if (cookieName !== WILDWOOD_BRANCH_COOKIE) jar.delete(WILDWOOD_BRANCH_COOKIE);
  }

  async function handleDraft(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const disable = url.searchParams.get("disable");
    const branch = url.searchParams.get("branch")?.trim() || "";
    const redirectParam = url.searchParams.get("redirect")?.trim();
    if (redirectParam && (!redirectParam.startsWith("/") || redirectParam.startsWith("//"))) {
      return NextResponse.json({ error: '"redirect" must be a same-origin path' }, { status: 400 });
    }
    const redirectUrl = redirectParam ? new URL(redirectParam, url.origin) : undefined;

    if (branch && managedAuth) {
      const authRes = await resolveAuthUserFromRequest(req);
      const user = authRes?.user ?? null;
      const client = await resolveClient(req);
      const decision = await authorizeManagedAction({
        ...(await accessContext(client)),
        user,
        action: { type: "content.read", ref: branch },
      });
      if (!decision.allowed) {
        return NextResponse.json(
          { error: decision.reason },
          { status: user ? 403 : 401, headers: { "cache-control": "private, no-store" } },
        );
      }
    }

    try {
      if (disable) {
        const dm = (await import("next/headers")) as unknown as {
          draftMode: () => Promise<{ disable: () => void }>;
        };
        (await dm.draftMode()).disable();
        const jar = await cookies();
        await clearBranchCookies(jar);
        return redirectUrl
          ? NextResponse.redirect(redirectUrl, { status: 303 })
          : NextResponse.json({ draftMode: false });
      }
      if (!branch) return NextResponse.json({ error: "Missing ?branch=" }, { status: 400 });
      const dm = (await import("next/headers")) as unknown as {
        draftMode: () => Promise<{ enable: () => void }>;
      };
      (await dm.draftMode()).enable();
      const jar = await cookies();
      jar.set(cookieName, branch, { path: "/" });
      return redirectUrl
        ? NextResponse.redirect(redirectUrl, { status: 303 })
        : NextResponse.json({ draftMode: true, branch });
    } catch {
      if (disable) {
        return redirectUrl
          ? NextResponse.redirect(redirectUrl, { status: 303 })
          : NextResponse.json({ draftMode: false });
      }
      if (!branch) return NextResponse.json({ error: "Missing ?branch=" }, { status: 400 });
      const headers = new Headers();
      headers.append("Set-Cookie", cookieHeaderValue(cookieName, branch));
      if (redirectUrl) {
        headers.set("location", redirectUrl.toString());
        return new NextResponse(null, { status: 303, headers });
      }
      return new NextResponse(JSON.stringify({ draftMode: true, branch }), { headers });
    }
  }

  async function handleExitPreview(): Promise<Response> {
    try {
      const jar = await cookies();
      await clearBranchCookies(jar);
      try {
        const { draftMode } = (await import("next/headers")) as {
          draftMode: () => Promise<{ disable: () => void }>;
        };
        (await draftMode()).disable();
      } catch {}
    } catch {}
    return NextResponse.json({ ok: true });
  }

  /**
   * Preview-token creation / revocation. Only signed-in non-anonymous users
   * can create tokens. Revocation deletes the verification row so future link
   * opens fail.
   */
  async function handlePreviewToken(req: Request): Promise<Response> {
    if (!authOpts) return NextResponse.json({ error: "Auth not configured" }, { status: 501 });
    const inst = await getAuthInstance(req);
    if (!inst) return NextResponse.json({ error: "Auth init failed" }, { status: 500 });
    await inst.ensureAuthSchema();

    const client = await resolveClient(req);
    const url = new URL(req.url);
    const db = client._.db;

    const authRes = await resolveAuthUserFromRequest(req);
    const editor = authRes?.user ?? null;
    if (!editor?.id)
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    if (editor.isAnonymous)
      return NextResponse.json(
        { error: "Anonymous users cannot manage preview tokens" },
        { status: 403 },
      );

    if (req.method === "DELETE") {
      const token = url.searchParams.get("token")?.trim();
      if (!token) return NextResponse.json({ error: "Missing ?token=" }, { status: 400 });
      const branch = url.searchParams.get("branch")?.trim();
      if (managedAuth) {
        const access = await accessContext(client);
        const decision = await authorizeManagedPermission({
          ...access,
          user: editor,
          permission: "access.revoke",
          ref: branch,
        });
        if (!decision.allowed)
          return NextResponse.json({ error: decision.reason }, { status: 403 });
      }
      const access = managedAuth ? await accessContext(client) : undefined;
      try {
        await revokePreviewToken({
          db,
          token,
          branch,
          access: access ? { ...access, actorId: editor.id } : undefined,
        });
      } catch (error) {
        return NextResponse.json(
          { error: error instanceof Error ? error.message : String(error) },
          { status: 403 },
        );
      }
      return NextResponse.json({ ok: true });
    }

    if (req.method !== "POST")
      return NextResponse.json({ error: "Method not allowed" }, { status: 405 });

    const branch = url.searchParams.get("branch")?.trim();
    if (!branch) return NextResponse.json({ error: "Missing ?branch=" }, { status: 400 });

    let previewAccess:
      | (Awaited<ReturnType<typeof accessContext>> & { parentGrantId?: string })
      | undefined;
    if (managedAuth) {
      const access = await accessContext(client);
      const decision = await authorizeManagedPermission({
        ...access,
        user: editor,
        permission: "branch.share",
        ref: branch,
      });
      if (!decision.allowed) return NextResponse.json({ error: decision.reason }, { status: 403 });
      const parent = decision.grants.find(
        (grant) => grant.permissions.includes("branch.share") && selectorsMatch(grant.refs, branch),
      );
      previewAccess = { ...access, parentGrantId: parent?.id };
    }

    const origin = requestOrigin(req);
    try {
      const result = await createPreviewToken({
        auth: inst.auth,
        db,
        editor,
        branch,
        origin,
        previewPath: wwPaths.preview,
        access: previewAccess,
      });
      return NextResponse.json(result);
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : String(e) },
        { status: 500 },
      );
    }
  }

  /**
   * Preview link landing. A visitor opens a share link with ?branch=&token=.
   * We verify the token, mint a session for the branch god-user, set the session
   * cookie + branch cookie, enable draft mode, and redirect to "/" so the
   * preview renders. No account needed.
   */
  async function handlePreviewLink(req: Request): Promise<Response> {
    if (!authOpts) return NextResponse.json({ error: "Auth not configured" }, { status: 501 });
    const inst = await getAuthInstance(req);
    if (!inst) return NextResponse.json({ error: "Auth init failed" }, { status: 500 });
    await inst.ensureAuthSchema();

    const url = new URL(req.url);
    const branch = url.searchParams.get("branch")?.trim();
    const token = url.searchParams.get("token")?.trim();

    if (!branch || !token) {
      return NextResponse.json({ error: "Missing ?branch= or ?token=" }, { status: 400 });
    }

    const client = await resolveClient(req);
    const db = client._.db;

    const result = await verifyPreviewToken({
      auth: inst.auth,
      db,
      token,
      access: managedAuth ? await accessContext(client) : undefined,
    });

    if (!result.ok) {
      return new NextResponse(result.error, { status: 403 });
    }
    if (result.branch !== branch) {
      return new NextResponse("Token is not valid for this branch", { status: 403 });
    }

    // Set the session cookie + branch cookie + enable draft mode.
    const headers = new Headers();
    headers.append("Set-Cookie", result.setCookie);
    headers.append("Set-Cookie", cookieHeaderValue(cookieName, result.branch));
    headers.set("Location", "/");
    return new NextResponse(null, { status: 302, headers });
  }

  async function handleCapabilities(req: Request): Promise<Response> {
    if (!authOpts) return NextResponse.json({ capabilities: {} });
    const url = new URL(req.url);
    const intent = url.searchParams.get("intent") ?? url.searchParams.get("action") ?? "";
    const actionPath = url.searchParams.get("path") ?? "";

    const authRes = await resolveAuthUserFromRequest(req);
    const user = authRes?.user ?? null;
    const mod = authModule;

    // authenticate gate — who may have a session at all.
    // New: single callback `authenticate`. Deprecated legacy `allowedEmails` / `isAllowed`
    // are still honored here via `synthesizeAuthenticateFromLegacy` for one minor,
    // so existing deploys don't break.
    {
      const authFn = authOpts.authenticate ?? synthesizeAuthenticateFromLegacy(authOpts);
      if (authFn) {
        const gate = await mod.evaluateAuthenticate(authFn as never, user as never, req);
        if (gate) return NextResponse.json({ allowed: false, capabilities: {} });
      }
    }

    // Map intent query to an action for pre-flight.
    // Supports `intent=content.update&path=docs/intro.md` and git actions via `intent=git.commit&ref=main`
    const requestedRef = url.searchParams.get("ref") ?? (await resolveClient(req))._.config.ref;
    let action: WildwoodAuthAction = {
      type: "content.update",
      ref: requestedRef,
      path: actionPath || intent,
    };
    if (intent.startsWith("git.")) {
      const ref = requestedRef;
      const maybe = gitActionFromPathname(`/api/wildwood/git/${intent.slice(4)}`, {
        ref,
        path: actionPath,
      });
      if (maybe) action = maybe;
      else action = { type: "git.commit", ref, message: "" } as WildwoodAuthAction;
    }

    if (managedAuth) {
      const client = await resolveClient(req);
      const managedGate = await evaluateManagedAccess(client, user, action);
      if (managedGate) {
        return NextResponse.json({ allowed: false, capabilities: { [intent]: false }, user });
      }
    }

    if (!authOpts.authorize) {
      return NextResponse.json({ allowed: !!user, capabilities: { [intent]: !!user }, user });
    }

    const result = await authOpts.authorize({
      user: user as never,
      action: action as never,
      request: req,
    });
    if (result instanceof Response) return result;
    const allowed = result !== false;
    return NextResponse.json({ allowed, capabilities: { [intent]: allowed }, user });
  }

  async function handleCmsDatabase(req: Request): Promise<Response> {
    if (!managedAuth || !opts.dangerouslyAllowDatabaseReset) {
      return new Response("Not found", { status: 404 });
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405 });
    }
    const authRes = await resolveAuthUserFromRequest(req);
    const user = authRes?.user ?? null;
    const client = await resolveClient(req);
    const { db, project } = await accessContext(client);
    const gate = await databaseOwnerGate({ db, project, user });
    if (gate) return gate;

    const pathname = new URL(req.url).pathname;
    const endpoint = pathname.replace(/\/wildwood\/cms\/database\/?$/, "/wildwood/access/reset");
    const html = renderCmsDatabasePage({
      endpoint,
      project: { org: project.org, repo: project.repo },
      stats: await client._.db.stats(),
    });
    return new Response(req.method === "HEAD" ? null : html, {
      headers: {
        "cache-control": "private, no-store",
        "content-security-policy":
          "default-src 'none'; connect-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
        "content-type": "text/html; charset=utf-8",
        "x-content-type-options": "nosniff",
      },
    });
  }

  async function handleAccess(req: Request): Promise<Response> {
    if (!managedAuth) {
      return NextResponse.json({ error: "Managed access is not configured" }, { status: 501 });
    }
    const authRes = await resolveAuthUserFromRequest(req);
    const user = authRes?.user ?? null;
    const client = await resolveClient(req);
    const { db, project } = await accessContext(client);
    const accessPathname = new URL(req.url).pathname;

    if (/\/wildwood\/access\/reset\/?$/.test(accessPathname)) {
      if (!opts.dangerouslyAllowDatabaseReset) {
        return NextResponse.json({ error: "Database reset is not enabled" }, { status: 404 });
      }
      const gate = await databaseOwnerGate({ db, project, user });
      if (gate) return gate;
      if (req.method === "GET") {
        const capabilityOnly = new URL(req.url).searchParams.get("capability") === "1";
        return NextResponse.json(
          {
            allowed: true,
            database: {
              resetEnabled: true,
              ...(capabilityOnly ? {} : { stats: await client._.db.stats() }),
            },
            project: {
              id: project.id,
              org: project.org,
              repo: project.repo,
            },
          },
          { headers: { "cache-control": "private, no-store" } },
        );
      }
      if (req.method !== "POST" && req.method !== "DELETE") {
        return NextResponse.json({ error: "Method not allowed" }, { status: 405 });
      }
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
      }
      if ((body as { confirm?: unknown }).confirm !== "wipe all wildwood data") {
        return NextResponse.json(
          { error: 'Expected { "confirm": "wipe all wildwood data" }' },
          { status: 400 },
        );
      }

      if (req.headers.get("accept")?.includes("application/x-ndjson")) {
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const emit = (event: unknown) => {
              try {
                controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
              } catch {
                // The reset continues if the browser disconnects after authorizing it.
              }
            };
            const close = () => {
              try {
                controller.close();
              } catch {
                // Already closed by the runtime or disconnected client.
              }
            };
            void (async () => {
              try {
                await client._.db.reset({
                  preserveAuthSettings: true,
                  onProgress: emit,
                });
                revalidateContent();
                emit({ phase: "complete", signedOut: true });
              } catch (error) {
                emit({
                  phase: "error",
                  message: error instanceof Error ? error.message : "Database reset failed",
                });
              } finally {
                close();
              }
            })();
          },
        });
        return new Response(stream, {
          headers: {
            "cache-control": "private, no-store",
            "content-type": "application/x-ndjson; charset=utf-8",
            "x-accel-buffering": "no",
            "x-content-type-options": "nosniff",
          },
        });
      }

      // Keep the persisted signing secret aligned with this warm runtime. User
      // identities and sessions are still deleted, so the caller must sign in
      // again and will reclaim the bootstrap owner grant from scratch.
      await client._.db.reset({ preserveAuthSettings: true });
      revalidateContent();
      return NextResponse.json(
        { ok: true, signedOut: true },
        { headers: { "cache-control": "private, no-store" } },
      );
    }

    const intentMatch = accessPathname.match(/\/wildwood\/access\/intents\/([^/]+)\/?$/);
    if (intentMatch) {
      const intentId = decodeURIComponent(intentMatch[1]!);
      const intent = await getWorkIntent({ db, project, intentId });
      if (!intent) {
        return NextResponse.json({ error: "Edit intent not found" }, { status: 404 });
      }
      if (!user?.id) {
        if (req.method === "GET" && req.headers.get("accept")?.includes("text/html")) {
          const origin = requestOrigin(req);
          const signIn = `${origin}${wwPaths.base}/wildwood/device/signin?next=${encodeURIComponent(accessPathname)}`;
          return NextResponse.redirect(signIn, 303);
        }
        return NextResponse.json({ error: "Authentication required" }, { status: 401 });
      }
      if (intent.requestedFor !== user.id) {
        return NextResponse.json(
          { error: "This edit intent belongs to a different user" },
          { status: 403 },
        );
      }

      if (req.method === "GET") {
        if (req.headers.get("accept")?.includes("text/html")) {
          return new Response(
            renderCmsWorkIntentPage({
              endpoint: accessPathname,
              project: { org: project.org, repo: project.repo },
              actor: { name: user.name, email: user.email },
              intent,
            }),
            {
              headers: {
                "cache-control": "private, no-store",
                "content-security-policy":
                  "default-src 'none'; connect-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
                "content-type": "text/html; charset=utf-8",
                "x-content-type-options": "nosniff",
              },
            },
          );
        }
        return NextResponse.json({ intent });
      }
      if (req.method !== "POST") {
        return NextResponse.json({ error: "Method not allowed" }, { status: 405 });
      }
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
      }
      const requestedDecision = (body as { decision?: unknown }).decision;
      if (requestedDecision !== "approve" && requestedDecision !== "deny") {
        return NextResponse.json(
          { error: 'Expected { "decision": "approve" | "deny" }' },
          { status: 400 },
        );
      }
      try {
        const decided = await decideWorkIntent({
          db,
          project,
          intentId,
          actorId: user.id,
          decision: requestedDecision,
          activate: async (pending: WildwoodWorkIntent) => {
            const ref = await availableManagedBranchName(client);
            const decision = await authorizeManagedAction({
              db,
              project,
              user,
              action: { type: "git.createBranch", name: ref, baseRef: project.configRef },
            });
            if (!decision.allowed) throw new Error(decision.reason);
            await client._.git.createBranch({ name: ref, base: project.configRef });
            await createContributorBranchAccess({ db, project, userId: user.id!, ref });
            const grant = await createAgentBranchGrant({
              db,
              project,
              userId: user.id!,
              agentId: pending.requestedBy,
              ref,
              expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            });
            revalidateContent();
            return { ref, grantId: grant.id };
          },
        });
        const previewUrl = decided.ref
          ? `${requestOrigin(req)}${wwPaths.base}/wildwood/draft?branch=${encodeURIComponent(decided.ref)}&redirect=%2F`
          : undefined;
        return NextResponse.json({ intent: decided, previewUrl });
      } catch (error) {
        return NextResponse.json(
          { error: error instanceof Error ? error.message : String(error) },
          { status: 409 },
        );
      }
    }

    const approvalMatch = accessPathname.match(/\/wildwood\/access\/approvals(?:\/([^/]+))?\/?$/);
    if (approvalMatch) {
      const decisionGate = await authorizeManagedPermission({
        db,
        project,
        user,
        permission: "approval.decide",
      });
      if (!decisionGate.allowed) {
        return NextResponse.json({ error: decisionGate.reason }, { status: user ? 403 : 401 });
      }
      const approvalId = approvalMatch[1] ? decodeURIComponent(approvalMatch[1]) : undefined;
      if (req.method === "GET") {
        const status = new URL(req.url).searchParams.get("status") ?? "pending";
        if (!["pending", "approved", "denied", "expired"].includes(status)) {
          return NextResponse.json({ error: "Unknown approval status" }, { status: 400 });
        }
        const approvals = await listApprovalRequests({
          db,
          project,
          status: approvalId
            ? undefined
            : (status as "pending" | "approved" | "denied" | "expired"),
        });
        if (approvalId) {
          const approval = approvals.find((candidate) => candidate.id === approvalId);
          if (!approval) {
            return NextResponse.json({ error: "Approval request not found" }, { status: 404 });
          }
          if (req.headers.get("accept")?.includes("text/html")) {
            return new Response(
              renderCmsApprovalPage({
                endpoint: new URL(req.url).pathname,
                project: { org: project.org, repo: project.repo },
                actor: { name: user?.name, email: user?.email },
                approval,
              }),
              {
                headers: {
                  "cache-control": "private, no-store",
                  "content-type": "text/html; charset=utf-8",
                },
              },
            );
          }
          return NextResponse.json({ approval });
        }
        return NextResponse.json({ approvals });
      }
      if (req.method !== "POST" || !approvalId) {
        return NextResponse.json({ error: "Method not allowed" }, { status: 405 });
      }
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
      }
      const requestedDecision = (body as { decision?: unknown }).decision;
      if (requestedDecision !== "approve" && requestedDecision !== "deny") {
        return NextResponse.json(
          { error: 'Expected { "decision": "approve" | "deny" }' },
          { status: 400 },
        );
      }
      try {
        const approval = await decideApprovalRequest({
          db,
          project,
          approvalId,
          actorId: user!.id!,
          decision: requestedDecision,
        });
        return NextResponse.json({ approval });
      } catch (error) {
        return NextResponse.json(
          { error: error instanceof Error ? error.message : String(error) },
          { status: 409 },
        );
      }
    }

    if (/\/wildwood\/access\/agent\/?$/.test(accessPathname)) {
      if (req.method !== "POST") {
        return NextResponse.json({ error: "Method not allowed" }, { status: 405 });
      }
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
      }
      const input = body as { ref?: unknown; permissions?: unknown; ttlSeconds?: unknown };
      if (typeof input.ref !== "string" || !input.ref.trim()) {
        return NextResponse.json({ error: 'Expected a non-empty "ref"' }, { status: 400 });
      }
      const permissions = input.permissions ?? undefined;
      if (
        permissions !== undefined &&
        (!Array.isArray(permissions) ||
          permissions.some(
            (permission) =>
              typeof permission !== "string" ||
              !(WILDWOOD_PERMISSIONS as readonly string[]).includes(permission),
          ))
      ) {
        return NextResponse.json(
          { error: '"permissions" contains an unknown permission' },
          {
            status: 400,
          },
        );
      }
      if (
        input.ttlSeconds !== undefined &&
        (typeof input.ttlSeconds !== "number" || !Number.isFinite(input.ttlSeconds))
      ) {
        return NextResponse.json({ error: '"ttlSeconds" must be a number' }, { status: 400 });
      }
      try {
        const session = await createAgentSession({
          db,
          project,
          user: user!,
          ref: input.ref.trim(),
          permissions: permissions as WildwoodPermission[] | undefined,
          ttlSeconds: input.ttlSeconds as number | undefined,
        });
        return NextResponse.json(
          {
            agentId: session.agentId,
            token: session.token,
            expiresAt: session.expiresAt,
            grant: session.grant,
            mcp: wwPaths.mcp,
          },
          { status: 201, headers: { "cache-control": "no-store" } },
        );
      } catch (error) {
        return NextResponse.json(
          { error: error instanceof Error ? error.message : String(error) },
          { status: user ? 403 : 401 },
        );
      }
    }

    const required =
      req.method === "GET"
        ? "access.inspect"
        : req.method === "DELETE"
          ? "access.revoke"
          : "access.manage";
    const decision = await authorizeManagedPermission({ db, project, user, permission: required });
    if (!decision.allowed) {
      return NextResponse.json({ error: decision.reason }, { status: user ? 403 : 401 });
    }

    if (req.method === "GET") {
      const grants = await listProjectGrants({
        db,
        project,
        includeRevoked: new URL(req.url).searchParams.get("history") === "true",
      });
      return NextResponse.json({ grants });
    }

    if (req.method === "DELETE") {
      const grantId = new URL(req.url).searchParams.get("grant")?.trim();
      if (!grantId) return NextResponse.json({ error: "Missing ?grant=" }, { status: 400 });
      const revoked = await revokeGrant({ db, project, grantId, actorId: user!.id! });
      if (!revoked) return NextResponse.json({ error: "Grant not found" }, { status: 404 });
      return NextResponse.json({ ok: true });
    }

    if (req.method === "POST") {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
      }
      const input = body as { type?: unknown; userId?: unknown };
      if (
        input.type !== "contributor" ||
        typeof input.userId !== "string" ||
        !input.userId.trim()
      ) {
        return NextResponse.json(
          { error: 'Expected { "type": "contributor", "userId": "..." }' },
          { status: 400 },
        );
      }
      const grants = await createContributorAccess({
        db,
        project,
        userId: input.userId.trim(),
        issuedBy: user!.id!,
      });
      return NextResponse.json({ grants }, { status: 201 });
    }

    return NextResponse.json({ error: "Method not allowed" }, { status: 405 });
  }

  async function handleAuth(req: Request): Promise<Response> {
    if (!authOpts) return NextResponse.json({ error: "Auth not configured" }, { status: 501 });
    const inst = await getAuthInstance(req);
    if (!inst) return NextResponse.json({ error: "Auth init failed" }, { status: 500 });
    await inst.ensureAuthSchema();

    // `better-auth/next-js` is bundled into `wildwood/dist` via the auth module
    // (tsdown `noExternal`) — one bundling boundary, owned by `./auth`.
    const mod = authModule;
    const handlers = (
      mod.toNextJsHandler as (a: unknown) => {
        GET: (r: Request) => Promise<Response>;
        POST: (r: Request) => Promise<Response>;
      }
    )(inst.auth as never);
    if (req.method === "GET") return handlers.GET(req);
    if (req.method === "POST") return handlers.POST(req);
    // fall through for other methods
    return handlers.GET(req);
  }

  async function apiFetch(req: Request): Promise<Response> {
    const h = await getHandlerFor(req);
    return h(req);
  }

  /** Request origin, honoring standard proxy headers (including Vercel). */
  function requestOrigin(req: Request): string {
    try {
      const url = new URL(req.url);
      const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? url.host;
      const proto =
        req.headers.get("x-forwarded-proto") ??
        (host.startsWith("localhost") || host.startsWith("127.0.0.1")
          ? "http"
          : url.protocol.replace(":", ""));
      return `${proto}://${host}`;
    } catch {
      return "http://localhost";
    }
  }

  /**
   * Serve the root `/.well-known/oauth-*` discovery docs. MCP clients only know
   * the MCP URL, so they probe the origin root; the app's `wildwoodWellKnown()`
   * rewrite forwards the two path-scoped suffixes into this catch-all.
   *
   * Two docs, handled asymmetrically because better-auth serves only one of them:
   * - `oauth-protected-resource/api/wildwood/mcp` (RFC 9728): better-auth does
   *   NOT emit this — we GENERATE it here. It advertises the MCP endpoint as its
   *   own OAuth resource/audience and points at the better-auth issuer.
   * - `oauth-authorization-server/api/auth` + `openid-configuration` (RFC 8414):
   *   better-auth serves these natively under `/api/auth/.well-known/*`, so we
   *   PROXY through to it and relay the body.
   */
  async function handleOAuthDiscovery(req: Request): Promise<Response> {
    if (!authOpts) return NextResponse.json({ error: "Auth not configured" }, { status: 501 });
    const url = new URL(req.url);
    const origin = requestOrigin(req);

    // Protected-resource metadata is generated, not proxied — better-auth's
    // oauth-provider only emits the 401 `WWW-Authenticate` pointer, never this
    // document. Keep it in lockstep with the `resource`/`issuer` used by
    // `handleMcp` below (both derive from `${origin}/api`).
    if (url.pathname.includes("/.well-known/oauth-protected-resource")) {
      return NextResponse.json(
        {
          resource: `${origin}${wwPaths.mcp}`,
          authorization_servers: [`${origin}${wwPaths.auth}`],
          bearer_methods_supported: ["header"],
        },
        { headers: { "cache-control": "public, max-age=15, stale-while-revalidate=15" } },
      );
    }

    // Authorization-server + OpenID docs are served by better-auth under the
    // BARE `/api/auth/.well-known/<doc-type>` path. The incoming request carries
    // the RFC 8414 issuer-path suffix (`…/oauth-authorization-server/api/auth`),
    // which better-auth does not answer — so strip everything after the
    // document-type segment before proxying. Also normalizes either
    // `/.well-known/…` (raw root) or `/api/wildwood/.well-known/…` (rewrite).
    const idx = url.pathname.indexOf("/.well-known/");
    const wellKnownPath = idx >= 0 ? url.pathname.slice(idx) : url.pathname;
    const docType = wellKnownPath.replace(/^\/\.well-known\//, "").split("/")[0];
    const target = `${origin}${wwPaths.auth}/.well-known/${docType}${url.search}`;
    const proxied = new Request(target, { method: "GET", headers: req.headers });
    return handleAuth(proxied);
  }

  /**
   * Authenticated MCP endpoint. `mcpHandler` verifies the OAuth 2.1 bearer token
   * (JWKS-signed by the `jwt` plugin) and either returns the 401 + discovery
   * `WWW-Authenticate` response or invokes our handler with the verified JWT.
   * The MCP endpoint URL is its own OAuth resource/audience.
   */
  async function handleMcp(req: Request): Promise<Response> {
    if (!authOpts) return NextResponse.json({ error: "Auth not configured" }, { status: 501 });
    const inst = await getAuthInstance(req);
    if (!inst) return NextResponse.json({ error: "Auth init failed" }, { status: 500 });
    await inst.ensureAuthSchema();

    const origin = requestOrigin(req);
    const resource = `${origin}${wwPaths.mcp}`;
    const mod = authModule;
    const client = (await (
      getClient as (r?: Request) => WildwoodRouteClientInput | Promise<WildwoodRouteClientInput>
    )(req)) as WildwoodClient;

    const bearer = req.headers
      .get("authorization")
      ?.match(/^Bearer\s+(.+)$/i)?.[1]
      ?.trim();
    if (managedAuth && bearer?.startsWith("wwa_")) {
      const access = await accessContext(client);
      const credential = await verifyAgentSession({ ...access, token: bearer });
      if (!credential) {
        return NextResponse.json(
          { error: "Agent credential is invalid, expired, or revoked" },
          { status: 401, headers: { "cache-control": "no-store" } },
        );
      }
      const agentUser: import("./auth").WildwoodAuthUser = {
        id: credential.agentId,
        name: "Wildwood agent",
        managedSubjectType: "agent",
      };
      const authorizeForMcp = await buildMcpAuthorizeForRequest(req, agentUser);
      return handleMcpRequest(
        req,
        client as never,
        {
          userId: credential.agentId,
          scopes: credential.grant.permissions,
        },
        authorizeForMcp,
        {
          origin,
          previewPath: wwPaths.preview,
          auth: inst.auth,
          access,
          userPreviewUrl: (ref) =>
            `${origin}${wwPaths.base}/wildwood/draft?branch=${encodeURIComponent(ref)}&redirect=%2F`,
          onMutate: revalidateContent,
        },
      );
    }

    // The token `iss` claim is the better-auth OAuth issuer, which is the auth
    // base (`${origin}/api/auth`) — NOT the bare origin. This must match the
    // `issuer` advertised in the `/.well-known/oauth-authorization-server`
    // discovery doc, or jose's `jwtVerify` rejects every token with
    // "invalid access token". `audience` stays the MCP resource identifier.
    const issuer = `${origin}${wwPaths.auth}`;
    const guarded = mod.mcpHandler(
      {
        verifyOptions: { issuer, audience: resource },
        jwksUrl: `${origin}${wwPaths.auth}/jwks`,
      },
      async (request: Request, jwt: Record<string, unknown>) => {
        const scopeClaim = typeof jwt.scope === "string" ? jwt.scope : "";
        const oauthUserId = String(jwt.sub ?? "");
        const oauthAuth = {
          userId: oauthUserId,
          email: typeof jwt.email === "string" ? jwt.email : undefined,
          scopes: scopeClaim.split(/\s+/).filter(Boolean),
        };
        const access = managedAuth ? await accessContext(client) : undefined;
        const agentId =
          access && oauthUserId
            ? await managedMcpAgentId(access.project.id, oauthUserId, jwt)
            : undefined;
        // In managed projects an OAuth MCP connection is a linked agent, not a
        // second copy of the user's authority. It begins powerless and receives
        // exact-ref grants only after the linked user approves a work intent.
        const mcpUser = agentId
          ? ({
              id: agentId,
              email: oauthAuth.email,
              managedSubjectType: "agent" as const,
            } satisfies import("./auth").WildwoodAuthUser)
          : oauthUserId
            ? { id: oauthUserId, email: oauthAuth.email }
            : null;
        const auth = agentId ? { ...oauthAuth, userId: agentId } : oauthAuth;
        const authorizeForMcp = await buildMcpAuthorizeForRequest(request, mcpUser);
        return handleMcpRequest(request, client as never, auth, authorizeForMcp, {
          origin,
          previewPath: wwPaths.preview,
          auth: inst.auth,
          access,
          userPreviewUrl: (ref) =>
            `${origin}${wwPaths.base}/wildwood/draft?branch=${encodeURIComponent(ref)}&redirect=%2F`,
          workIntents:
            access && agentId && oauthUserId
              ? {
                  begin: async (summary) => {
                    const intent = await createWorkIntent({
                      ...access,
                      requestedBy: agentId,
                      requestedFor: oauthUserId,
                      summary,
                    });
                    return {
                      ...intent,
                      approvalUrl: `${origin}${wwPaths.base}/wildwood/access/intents/${intent.id}`,
                    };
                  },
                  get: (intentId) => getWorkIntent({ ...access, intentId, requestedBy: agentId }),
                }
              : undefined,
          onMutate: revalidateContent,
        });
      },
    );
    return guarded(req);
  }

  async function authorizeGitRequest(req: Request, pathname: string): Promise<Response | null> {
    if (!authOpts) {
      // If auth config absent, still allow if client-level authorize is permissive.
      // Git handler does its own authorize via client._.auth.authorize; we only enforce route-level here.
      return null;
    }

    // Legacy callback mode kept these reads public. Managed grants fail closed.
    if (
      !managedAuth &&
      req.method === "GET" &&
      (pathname.includes("/git/refs") || pathname.includes("/git/log"))
    ) {
      return null;
    }

    // Device-authorization UI pages (verify/approve + dev sign-in) are served by
    // the library and must be publicly reachable — a device user lands on the
    // verification_uri before (or in order to) sign in. The pages themselves
    // call the CSRF-protected better-auth endpoints, which enforce the session.
    if (req.method === "GET" && /\/wildwood\/device(?:\/|$)/.test(pathname)) {
      return null;
    }

    const authRes = await resolveAuthUserFromRequest(req);
    const user = authRes?.user ?? null;
    const mod = authModule;

    // 1) authenticate gate — who may have a session at all.
    {
      const authFn = authOpts.authenticate ?? synthesizeAuthenticateFromLegacy(authOpts);
      if (authFn) {
        const gate = await mod.evaluateAuthenticate(authFn as never, user as never, req);
        if (gate) {
          if (!user) return new Response("Authentication required", { status: 401 });
          if (gate instanceof Response) return gate;
          return new Response("Forbidden", { status: 403 });
        }
      }
    }

    // Try to parse body for ref/paths to give authorize full context — best-effort, don't consume.
    let bodyHint: unknown;
    if (req.method !== "GET" && req.method !== "HEAD") {
      try {
        bodyHint = await req.clone().json();
      } catch {
        // ignore
      }
    }

    let gitAction = gitActionFromPathname(pathname, bodyHint);
    if (!gitAction && managedAuth) {
      const client = await resolveClient(req);
      const body = bodyHint as Record<string, unknown> | undefined;
      const pathRef = pathname.match(/\/git\/(?:worktrees|pr)\/([^/?]+)/)?.[1];
      const queryRef = new URL(req.url).searchParams.get("ref");
      const ref =
        (typeof body?.ref === "string" ? body.ref : undefined) ??
        queryRef ??
        (pathRef ? decodeURIComponent(pathRef) : undefined) ??
        client._.config.ref;
      gitAction = { type: "content.read", ref };
    }
    if (!gitAction) return null;

    if (managedAuth) {
      const client = await resolveClient(req);
      const managedGate = await evaluateManagedAccess(client, user, gitAction);
      if (managedGate) return managedGate;
    }

    // Optional legacy callback is an additional restriction in managed mode.
    if (!authOpts.authorize) return null;

    const result = await authOpts.authorize({
      user: user as never,
      action: gitAction as never,
      request: req,
    });
    if (result instanceof Response) return result;
    if (result === false) return new Response("Forbidden", { status: 403 });
    return null;
  }

  async function GET(req: Request) {
    const pathname = pathnameOf(req);
    if (isOAuthDiscoveryPath(pathname)) return handleOAuthDiscovery(req);
    if (isMcpPath(pathname)) return handleMcp(req);
    if (isCapabilitiesPath(pathname)) return handleCapabilities(req);
    if (isCmsDatabasePath(pathname)) return handleCmsDatabase(req);
    if (isAccessPath(pathname)) return handleAccess(req);
    if (isAuthPath(pathname)) return handleAuth(req);
    if (isDraftPath(pathname)) return handleDraft(req);
    if (isPreviewTokenPath(pathname)) return handlePreviewToken(req);
    if (isPreviewPath(pathname)) return handlePreviewLink(req);
    if (isExitPreviewPath(pathname)) return handleExitPreview();
    const gate = await authorizeGitRequest(req, pathname);
    if (gate) return gate;
    return apiFetch(req);
  }

  async function HEAD(req: Request) {
    const pathname = pathnameOf(req);
    if (isCmsDatabasePath(pathname)) return handleCmsDatabase(req);
    const gate = await authorizeGitRequest(req, pathname);
    if (gate) return gate;
    return apiFetch(req);
  }
  async function OPTIONS(req: Request) {
    return apiFetch(req);
  }

  async function POST(req: Request) {
    const pathname = pathnameOf(req);
    if (isMcpPath(pathname)) return handleMcp(req);
    if (isCapabilitiesPath(pathname)) return handleCapabilities(req);
    if (isAccessPath(pathname)) return handleAccess(req);
    if (isAuthPath(pathname)) return handleAuth(req);
    if (isDraftPath(pathname)) return handleDraft(req);
    if (isPreviewTokenPath(pathname)) return handlePreviewToken(req);
    if (isExitPreviewPath(pathname)) return handleExitPreview();

    const isCreateBranch = /\/git\/create-branch\/?$/.test(pathname);
    let forwardedReq = req;
    let managedBranchOwner: string | undefined;
    let managedBranchAccess: { db: WildwoodAccessDb; project: WildwoodProject } | undefined;

    // In managed mode branch refs are server-owned identifiers. Callers only
    // choose the base; the returned two-word ref is the value they must retain.
    if (managedAuth && isCreateBranch) {
      try {
        const body = (await req.clone().json()) as Record<string, unknown>;
        const authRes = await resolveAuthUserFromRequest(req);
        if (authRes?.user?.id) {
          const client = await resolveClient(req);
          const name = await availableManagedBranchName(client);
          const headers = new Headers(req.headers);
          headers.set("content-type", "application/json");
          headers.delete("content-length");
          forwardedReq = new Request(req.url, {
            method: req.method,
            headers,
            body: JSON.stringify({ ...body, name }),
            signal: req.signal,
          });
          managedBranchOwner = authRes.user.id;
          managedBranchAccess = await accessContext(client);
        }
      } catch (error) {
        return NextResponse.json(
          { error: error instanceof Error ? error.message : "Invalid branch request" },
          { status: 400 },
        );
      }
    }

    const gate = await authorizeGitRequest(forwardedReq, pathname);
    if (gate) return gate;

    let createBranchName: string | undefined;
    if (isCreateBranch) {
      try {
        const b = (await forwardedReq.clone().json()) as { name?: string };
        const n = typeof b.name === "string" ? b.name.trim() : "";
        if (n) createBranchName = n;
      } catch {}
    }

    const upstream = await apiFetch(forwardedReq);

    if (
      upstream.ok &&
      isCreateBranch &&
      createBranchName &&
      managedBranchOwner &&
      managedBranchAccess
    ) {
      try {
        await createContributorBranchAccess({
          ...managedBranchAccess,
          userId: managedBranchOwner,
          ref: createBranchName,
        });
      } catch (error) {
        return NextResponse.json(
          {
            error:
              error instanceof Error
                ? error.message
                : "The branch was created but its access grant could not be recorded",
          },
          { status: 500 },
        );
      }
    }

    if (mutationRe.test(pathname)) revalidateContent();

    if (!/\/git\/(create-branch|switch-branch)\/?$/.test(pathname)) return upstream;

    let branch: string | undefined = createBranchName;
    if (!branch) {
      try {
        const data = (await upstream.clone().json()) as { ref?: string };
        if (typeof data.ref === "string" && data.ref.trim()) branch = data.ref.trim();
      } catch {}
    }
    if (!branch) return upstream;

    const headers = new Headers(upstream.headers);
    headers.delete("set-cookie");
    headers.append("Set-Cookie", cookieHeaderValue(cookieName, branch));
    return new NextResponse(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  }

  async function PUT(req: Request) {
    return POST(req);
  }
  async function PATCH(req: Request) {
    return POST(req);
  }
  async function DELETE(req: Request) {
    return POST(req);
  }

  return { GET, POST, HEAD, OPTIONS, PUT, PATCH, DELETE, tagName, cookieName, mutationRe };
}

export const createWildwoodRouteHandlers = createWildwoodRoute;
export const createRoute = createWildwoodRoute;

/**
 * Pull the OAuth sign-in creds off the read client's single GitHub credential
 * object. Lets `createCMS(ww, { auth: { github: true } })` reuse the SAME
 * `clientId`/`clientSecret` you configured on `wildwood({ github })` — declare
 * the GitHub App once. Auth never looks up a second set of credentials.
 */
function reuseGithubSignInFromClient(
  client: WildwoodRouteClientInput,
  opts: CreateWildwoodRouteOptions,
): CreateWildwoodRouteOptions {
  const authOpts = opts.auth;
  if (!authOpts) return opts;

  const config = (client as { _?: { config?: { origin?: string; repo?: string } } })?._?.config;
  let nextAuth = {
    ...authOpts,
    ...(!authOpts.baseURL && config?.origin ? { baseURL: config.origin } : {}),
    ...(!authOpts.appName && config?.repo ? { appName: config.repo } : {}),
  };

  // Only inject when sign-in is requested but creds weren't given explicitly.
  const wantsGithub =
    authOpts.github === true ||
    opts.providers?.github === true ||
    (Boolean(authOpts.bootstrap) && authOpts.github === undefined);
  if (!wantsGithub) return { ...opts, auth: nextAuth };

  const gh = (client as { _?: { provider?: { github?: unknown } } })?._?.provider?.github as
    | { clientId?: string; clientSecret?: string }
    | undefined;
  const clientId = typeof gh?.clientId === "string" ? gh.clientId.trim() || undefined : undefined;
  const clientSecret =
    typeof gh?.clientSecret === "string" ? gh.clientSecret.trim() || undefined : undefined;
  if (!clientId || !clientSecret) return { ...opts, auth: nextAuth };

  nextAuth = { ...nextAuth, github: { clientId, clientSecret } };
  return { ...opts, auth: nextAuth };
}

/**
 * `createCMS(client, options)` — the CMS layer on top of the read client.
 *
 * Composes with `wildwood()`:
 *
 *   const ww = wildwood({ ...identity, collections, database, github });
 *   export const { GET, POST, HEAD, OPTIONS, PUT, PATCH, DELETE } =
 *     createCMS(ww, { auth: { bootstrap: { owner: "owner@example.com" } } });
 *
 * It owns everything write/auth related — mutation endpoints, better-auth,
 * `authenticate`/`authorize`, branch cookie, `revalidateTag`, capabilities —
 * and reuses `ww`'s single GitHub credential object for sign-in.
 *
 * Returns the HTTP handler object (so the one-line destructure above works) with
 * the read `client` attached as `.client`. Attaching (rather than nesting under
 * `.route`) keeps the common route-file export a one-liner while still making
 * the client reachable for server actions / mutation calls:
 *
 *   const cms = createCMS(ww, { auth });
 *   export const { GET, POST } = cms;   // handlers
 *   // cms.client → the read client
 */
export function createCMS<Client extends WildwoodRouteClientInput>(
  client: Client,
  opts: CreateWildwoodRouteOptions = {},
) {
  const merged = reuseGithubSignInFromClient(client, opts);
  const handlers = createWildwoodRoute(() => client, merged);
  return Object.assign(handlers, { client });
}
