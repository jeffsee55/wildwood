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
 * - /api/auth/*  + /api/wildwood/auth/*  (better-auth, lazy-loaded)
 * - /api/wildwood/auth/capabilities  (Kit can hide edit buttons pre-flight)
 * - branch cookie + revalidateTag on mutations
 *
 * Autodetect:
 * - baseURL optional. When omitted better-auth derives origin from Request
 *   (origin/x-forwarded-host/proto+request.url). Works for localhost, Vercel
 *   previews (*.vercel.app), custom domains — no env mapping needed.
 * - trustedOrigins optional. Defaults to derived baseURL origin. Accepts
 *   static string[] or `(req)=>string[]|Promise<string[]>` for userland mapping.
 * - No env fallbacks inside wildwood — host maps env → explicit options.
 *   DB is not configured here; it's reused from `createClient({ database })`.
 *   GitHub sign-in is `github: true | { clientId, clientSecret }` — `true`
 *   reuses the same GitHub App creds used for git writes
 *   (GITHUB_CLIENT_ID/SECRET from App manifest). No separate WILDWOOD_GITHUB_*
 *   envs. Auth: `authenticate` = sign-in/sign-up gate, `authorize` = per-action gate.
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
import type { WildwoodClient } from "@/client/index";
import {
  activeRefSetCookieHeader,
  clearBranchCookieHeader,
} from "wildwood-shared";
import type { WildwoodAuthAction } from "@/client/auth";

export { WILDWOOD_BRANCH_COOKIE, WILDWOOD_CACHE_TAG };

// --- auth types re-exported for convenience so app can import from "wildwood/nextjs/route"
export type {
  WildwoodAuthenticateContext,
  WildwoodAuthenticateFn,
  WildwoodAuthorizeContext,
  WildwoodAuthorizeFn,
  WildwoodBaseURL,
  WildwoodRouteAuthOptions,
  WildwoodTrustedOrigins,
} from "./auth";

const DEFAULT_MUTATION_RE =
  /\/git\/(commit|discard|merge|pull|create-branch|switch-branch)\/?$/;

export type CreateWildwoodRouteOptions = {
  revalidateTagName?: string;
  branchCookieName?: string;
  legacyCookieNames?: readonly string[];
  mutationRe?: RegExp;
  revalidateTagStore?: "default" | "layout";
  /**
   * When true, `getClient` is called per-request with Request.
   * Needed for apps like `play` where org/repo comes from a cookie.
   * Auto-detected when `getClient.length >= 1`, but you can force it.
   */
  requestAware?: boolean;

  /**
   * Optional auth config. When present, route.ts owns better-auth entirely:
   * - /api/auth/* and /api/wildwood/auth/* → better-auth handler (lazy, no static import)
   * - git endpoints → session → authenticate → authorize gate
   * - /api/wildwood/auth/capabilities → pre-flight for Kit
   *
   * DB is NOT configured here — it's re-used from `createClient({ database })`
   * which is already the Turso/LibSQL client. No `database:` field.
   *
   * GitHub sign-in: `github: true` reuses GITHUB_CLIENT_ID/SECRET from the same
   * GitHub App that provides git writes. Only pass `{ clientId, clientSecret }`
   * if sign-in creds differ. `false` / omitted disables GitHub sign-in.
   * Future: `providers: { gitlab: true, google: true }`.
   *
   * No env fallbacks inside wildwood — host maps env → explicit options.
   * `baseURL`/`trustedOrigins` optional: autodetected from Request.
   *
   * Example (zero-config host):
   *   createWildwoodRoute(() => wildwood, {
   *     auth: {
   *       secret: process.env.BETTER_AUTH_SECRET!,
   *       github: true, // or { clientId, clientSecret } if different from git App
   *
   *       authenticate: async ({ user }) => allowList.has(user.email?.toLowerCase() ?? ""),
   *       authorize: async ({ user, action }) => !!user,
   *     },
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

function isCapabilitiesPath(pathname: string): boolean {
  return pathname.endsWith("/auth/capabilities") || pathname.endsWith("/wildwood/auth/capabilities");
}

function isDraftPath(pathname: string): boolean {
  return pathname.endsWith("/wildwood/draft") || pathname.endsWith("/tr33/draft") || pathname.endsWith("/draft");
}

function isExitPreviewPath(pathname: string): boolean {
  return pathname.endsWith("/wildwood/preview") || pathname.endsWith("/preview/exit");
}

function gitActionFromPathname(pathname: string, bodyHint?: unknown): WildwoodAuthAction | null {
  const m = pathname.match(/\/git\/([^/?]+)/);
  if (!m) return null;
  const op = m[1]!;
  const b = bodyHint as Record<string, unknown> | undefined;
  const ref = typeof b?.ref === "string" ? b.ref : (typeof b?.name === "string" ? b.name : "main");
  const paths = Array.isArray(b?.paths) ? (b!.paths as string[]) : [];
  switch (op) {
    case "switch-branch": return { type: "git.switchRef", ref };
    case "create-branch": return { type: "git.createBranch", name: typeof b?.name === "string" ? b!.name : ref, baseRef: typeof b?.baseRef === "string" ? b.baseRef : undefined };
    case "add": return { type: "git.add", ref, paths };
    case "commit": return { type: "git.commit", ref, message: typeof b?.message === "string" ? b.message : "" };
    case "discard": return { type: "git.discard", ref };
    case "push": return { type: "git.push", ref };
    case "pull": return { type: "git.pull", ref };
    case "merge": return { type: "git.merge", ref, message: typeof b?.message === "string" ? b.message : undefined };
    default: return null;
  }
}

/** Back-compat shim for one minor — synthesize `authenticate` from deprecated shape. */
function synthesizeAuthenticateFromLegacy(
  authOpts: import("./auth").WildwoodRouteAuthOptions,
): import("./auth").WildwoodAuthenticateFn | null {
  const allowedEmails = (authOpts as { allowedEmails?: string[] }).allowedEmails;
  const isAllowedLegacy = (authOpts as {
    isAllowed?: (ctx: { user: import("@/client/auth").WildwoodAuthUser | null; request: Request }) => boolean | Promise<boolean>;
  }).isAllowed;
  if (!allowedEmails && !isAllowedLegacy) return null;
  return async ({ user, request }) => {
    if (isAllowedLegacy) {
      const ok = await isAllowedLegacy({ user: user as never, request });
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

export function createWildwoodRoute(
  getClient: ((req?: Request) => WildwoodClient | Promise<WildwoodClient>) | (() => WildwoodClient | Promise<WildwoodClient>),
  opts: CreateWildwoodRouteOptions = {},
) {
  const tagName = opts.revalidateTagName ?? WILDWOOD_CACHE_TAG;
  const cookieName = opts.branchCookieName ?? WILDWOOD_BRANCH_COOKIE;
  const legacyNames = opts.legacyCookieNames ?? WILDWOOD_BRANCH_COOKIE_FALLBACKS;
  const mutationRe = opts.mutationRe ?? DEFAULT_MUTATION_RE;
  const tagStore = opts.revalidateTagStore ?? "default";
  const authOpts = opts.auth;

  // For apps where client is static (docs), we cache handler. For per-request clients (play),
  // we detect `getClient.length >= 1` or caller opts requestAware.
  const isRequestAware = (opts as { requestAware?: boolean }).requestAware || getClient.length >= 1;

  let staticHandlerPromise: Promise<LazyHandler> | null = null;

  function getHandlerFor(req?: Request): Promise<LazyHandler> {
    if (isRequestAware && req) {
      return Promise.resolve((getClient as (r?: Request) => WildwoodClient | Promise<WildwoodClient>)(req)).then((c) =>
        createNextHandle(c as WildwoodForBranch as unknown as WildwoodClient),
      );
    }
    if (!staticHandlerPromise) {
      staticHandlerPromise = Promise.resolve((getClient as () => WildwoodClient | Promise<WildwoodClient>)()).then((c) =>
        createNextHandle(c as WildwoodForBranch as unknown as WildwoodClient),
      );
    }
    return staticHandlerPromise;
  }

  // Lazy auth singleton — only constructed if auth config is provided AND a request needs it.
  // Keeps `better-auth` out of the bundle for apps without auth.
  // IMPORTANT: use eval("import") indirection so Turbopack doesn't trace
  // packages/wildwood/dist/nextjs/auth.mjs → bare `better-auth` at build time.
  // At build time Turbopack would try to resolve `better-auth` relative to
  // packages/wildwood/ and fail with "Module not found", even though apps/docs
  // has better-auth as direct dep. Runtime import works because Vercel λ's
  // node_modules has it. This is the same fix that made lib/auth.ts self-contained before.
  type AuthBundle = typeof import("./auth");
  let authModulePromise: Promise<AuthBundle> | null = null;
  function getAuthModule(): Promise<AuthBundle> {
    if (!authModulePromise) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dynamicImport = new Function("s", "return import(s)") as (s: string) => Promise<any>;
      // dist auth chunk is sibling of route chunk
      authModulePromise = dynamicImport("./auth.mjs") as Promise<AuthBundle>;
    }
    return authModulePromise;
  }

  let authInstancePromise: Promise<ReturnType<AuthBundle["getOrCreateAuth"]>> | null = null;
  let dbForAuthPromise: Promise<unknown> | null = null;

  function getDbForAuth(): Promise<unknown> {
    if (dbForAuthPromise) return dbForAuthPromise;
    dbForAuthPromise = (async () => {
      // Resolve client once — don't go via H3 handler wrapper
      const maybeWithReq = getClient as unknown as (
        r?: Request,
      ) => import("@/client/index").WildwoodClient | Promise<import("@/client/index").WildwoodClient>;
      const c = await maybeWithReq();
      const rawDb =
        (c as { _: { db?: { client?: unknown; libsqlClient?: unknown } } })._?.db ??
        (c as { _: { db?: unknown } })._?.db;
      return rawDb ?? null;
    })();
    return dbForAuthPromise;
  }

  async function getAuthInstance() {
    if (!authOpts) return null;
    if (!authInstancePromise) {
      authInstancePromise = (async () => {
        const [mod, db] = await Promise.all([getAuthModule(), getDbForAuth()]);
        if (!db) throw new Error("Auth requires a database — ensure createClient({ database }) is configured.");
        return mod.getOrCreateAuth({ auth: authOpts, db: db as never });
      })();
    }
    return authInstancePromise;
  }

  async function resolveAuthUserFromRequest(req: Request) {
    if (!authOpts) return null;
    const inst = await getAuthInstance();
    if (!inst) return null;
    await inst.ensureAuthSchema();
    const mod = await getAuthModule();
    const res = await mod.getSessionUser(inst.auth as never, req.headers as unknown as Headers);
    return res; // { session, user } | null
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
    try {
      if (disable) {
        const dm = (await import("next/headers")) as unknown as { draftMode: () => Promise<{ disable: () => void }> };
        (await dm.draftMode()).disable();
        const jar = await cookies();
        await clearBranchCookies(jar);
        return NextResponse.json({ draftMode: false });
      }
      if (!branch) return NextResponse.json({ error: "Missing ?branch=" }, { status: 400 });
      const dm = (await import("next/headers")) as unknown as { draftMode: () => Promise<{ enable: () => void }> };
      (await dm.draftMode()).enable();
      const jar = await cookies();
      jar.set(cookieName, branch, { path: "/" });
      return NextResponse.json({ draftMode: true, branch });
    } catch {
      if (disable) return NextResponse.json({ draftMode: false });
      if (!branch) return NextResponse.json({ error: "Missing ?branch=" }, { status: 400 });
      const headers = new Headers();
      headers.append("Set-Cookie", cookieHeaderValue(cookieName, branch));
      return new NextResponse(JSON.stringify({ draftMode: true, branch }), { headers });
    }
  }

  async function handleExitPreview(): Promise<Response> {
    try {
      const jar = await cookies();
      await clearBranchCookies(jar);
      try {
        const { draftMode } = (await import("next/headers")) as { draftMode: () => Promise<{ disable: () => void }> };
        (await draftMode()).disable();
      } catch {}
    } catch {}
    return NextResponse.json({ ok: true });
  }

  async function handleCapabilities(req: Request): Promise<Response> {
    if (!authOpts) return NextResponse.json({ capabilities: {} });
    const url = new URL(req.url);
    const intent = url.searchParams.get("intent") ?? url.searchParams.get("action") ?? "";
    const actionPath = url.searchParams.get("path") ?? "";

    const authRes = await resolveAuthUserFromRequest(req);
    const user = authRes?.user ?? null;
    const mod = await getAuthModule();

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

    if (!authOpts.authorize) {
      return NextResponse.json({ allowed: !!user, capabilities: { [intent]: !!user } });
    }

    // Map intent query to an action for pre-flight.
    // Supports `intent=content.update&path=docs/intro.md` and git actions via `intent=git.commit&ref=main`
    let action: WildwoodAuthAction | { type: "content.update"; path: string } = {
      type: "content.update",
      path: actionPath || intent,
    };
    if (intent.startsWith("git.")) {
      const ref = url.searchParams.get("ref") ?? "main";
      const maybe = gitActionFromPathname(`/api/wildwood/git/${intent.slice(4)}`, { ref, path: actionPath });
      if (maybe) action = maybe;
      else action = { type: "git.commit", ref, message: "" } as WildwoodAuthAction;
    }

    const result = await authOpts.authorize({ user: user as never, action: action as never, request: req });
    if (result instanceof Response) return result;
    const allowed = result !== false;
    return NextResponse.json({ allowed, capabilities: { [intent]: allowed }, user });
  }

  async function handleAuth(req: Request): Promise<Response> {
    if (!authOpts) return NextResponse.json({ error: "Auth not configured" }, { status: 501 });
    const inst = await getAuthInstance();
    if (!inst) return NextResponse.json({ error: "Auth init failed" }, { status: 500 });
    await inst.ensureAuthSchema();

    // Use eval indirection for same reason — don't let Turbopack trace better-auth/next-js at build.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dynamicImport = new Function("s", "return import(s)") as (s: string) => Promise<any>;
    const { toNextJsHandler } = (await dynamicImport("better-auth/next-js")) as {
      toNextJsHandler: (a: unknown) => { GET: (r: Request) => Promise<Response>; POST: (r: Request) => Promise<Response> };
    };
    const handlers = toNextJsHandler(inst.auth as never);
    if (req.method === "GET") return handlers.GET(req);
    if (req.method === "POST") return handlers.POST(req);
    // fall through for other methods
    return handlers.GET(req);
  }

  async function apiFetch(req: Request): Promise<Response> {
    const h = await getHandlerFor(req);
    return h(req);
  }

  async function authorizeGitRequest(req: Request, pathname: string): Promise<Response | null> {
    if (!authOpts) {
      // If auth config absent, still allow if client-level authorize is permissive.
      // Git handler does its own authorize via client._.auth.authorize; we only enforce route-level here.
      return null;
    }

    // Public read endpoints — no auth needed
    if (req.method === "GET" && (pathname.includes("/git/refs") || pathname.includes("/git/log"))) {
      return null;
    }

    const authRes = await resolveAuthUserFromRequest(req);
    const user = authRes?.user ?? null;
    const mod = await getAuthModule();

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

    // 2) authorize gate — what may this (already authenticated) session do?
    if (!authOpts.authorize) return null;

    // Try to parse body for ref/paths to give authorize full context — best-effort, don't consume.
    let bodyHint: unknown;
    if (req.method === "POST") {
      try {
        bodyHint = await req.clone().json();
      } catch {
        // ignore
      }
    }

    const gitAction = gitActionFromPathname(pathname, bodyHint);
    if (!gitAction) return null;

    const result = await authOpts.authorize({ user: user as never, action: gitAction as never, request: req });
    if (result instanceof Response) return result;
    if (result === false) return new Response("Forbidden", { status: 403 });
    return null;
  }

  async function GET(req: Request) {
    const pathname = pathnameOf(req);
    if (isCapabilitiesPath(pathname)) return handleCapabilities(req);
    if (isAuthPath(pathname)) return handleAuth(req);
    if (isDraftPath(pathname)) return handleDraft(req);
    if (isExitPreviewPath(pathname)) return handleExitPreview();
    const gate = await authorizeGitRequest(req, pathname);
    if (gate) return gate;
    return apiFetch(req);
  }

  async function HEAD(req: Request) { return apiFetch(req); }
  async function OPTIONS(req: Request) { return apiFetch(req); }

  async function POST(req: Request) {
    const pathname = pathnameOf(req);
    if (isCapabilitiesPath(pathname)) return handleCapabilities(req);
    if (isAuthPath(pathname)) return handleAuth(req);
    if (isDraftPath(pathname)) return handleDraft(req);
    if (isExitPreviewPath(pathname)) return handleExitPreview();

    const gate = await authorizeGitRequest(req, pathname);
    if (gate) return gate;

    let createBranchName: string | undefined;
    if (/\/git\/create-branch\/?$/.test(pathname)) {
      try {
        const b = (await req.clone().json()) as { name?: string };
        const n = typeof b.name === "string" ? b.name.trim() : "";
        if (n) createBranchName = n;
      } catch {}
    }

    const upstream = await apiFetch(req);

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
    return new NextResponse(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
  }

  async function PUT(req: Request) { return POST(req); }
  async function PATCH(req: Request) { return POST(req); }
  async function DELETE(req: Request) { return POST(req); }

  return { GET, POST, HEAD, OPTIONS, PUT, PATCH, DELETE, tagName, cookieName, mutationRe };
}

export const createWildwoodRouteHandlers = createWildwoodRoute;
export const createRoute = createWildwoodRoute;
