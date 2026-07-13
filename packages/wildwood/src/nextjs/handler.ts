/**
 * Framework-agnostic H3 handler — owns /api/wildwood/* sub-routers.
 * Zero deps on @wildwood/kit, better-auth, or next/*.
 *
 * Authz note: handlers are transport-only. Route layer (`createWildwoodRoute`)
 * resolves the session user + owns `authenticate` / `authorize` and injects
 * an authorizer here. `provider` / client has no `authorize`.
 */

import { H3 } from "h3";
import type { WildwoodClient } from "@/client/index";
import { vscodeEmbedCorsHeaders, withVscodeEmbedCors } from "@/nextjs/vscode-embed-csp";
import type { WildwoodAuthAction } from "@/nextjs/auth";
import { createGitServiceRouter, type GitServiceAuthorizeFn } from "@/nextjs/handlers/git-service";
import { createGitHubRouter } from "@/nextjs/handlers/github-router";
import { createGitHubAppManifestRouter } from "@/nextjs/handlers/github-app-manifest-router";
import { createVscodeRouter } from "@/nextjs/handlers/vscode-router";

export type CreateHandlerOptions = {
  currentRef?: string;
  /**
   * Optional authorizer — injected by `createWildwoodRoute`.
   * Called before git mutations. Return `Response` / `false` to deny.
   * `client` / provider never owns this; it's route-owned.
   */
  authorize?: GitServiceAuthorizeFn;
  /** Same gate for GitHub App manifest routes that need git-write-level authz. */
  authorizeAppManifest?: (req: Request, action: WildwoodAuthAction) => Promise<Response | null>;
};

export function createHandler(client: WildwoodClient, options?: CreateHandlerOptions) {
  const base = new H3();
  const api = new H3();
  const wildwoodNs = new H3();

  // Injector is optional — when absent (tests / direct usage without route),
  // git routes allow (route layer still gates at Next boundary when configured).
  const gitRouter = createGitServiceRouter(client, { authorize: options?.authorize });
  const githubRouter = createGitHubRouter(client);
  const appManifestRouter = createGitHubAppManifestRouter(client, {
    authorize: options?.authorize as never,
  });
  const vscodeRouter = createVscodeRouter(client);

  // Canonical: /api/wildwood/*
  wildwoodNs.mount("/git", gitRouter);
  wildwoodNs.mount("/github", githubRouter);
  wildwoodNs.mount("/github/app-manifest", appManifestRouter);
  wildwoodNs.mount("/vscode", vscodeRouter);

  api.mount("/wildwood", wildwoodNs);
  // Legacy aliases: /api/git, /api/github, /api/vscode (keep so existing consumers + current vercel.json rewrites don't break)
  api.mount("/git", gitRouter);
  api.mount("/github", githubRouter);
  api.mount("/vscode", vscodeRouter);

  base.use(async (event, next) => {
    const pathname = event.url.pathname;
    const isVscodeApi =
      pathname.startsWith("/api/vscode/") || pathname.startsWith("/api/wildwood/vscode/");
    const origin = event.req.headers.get("origin");
    const corsHeaders: Record<string, string> = isVscodeApi
      ? (vscodeEmbedCorsHeaders(event.req) as Record<string, string>)
      : {
          "Access-Control-Allow-Origin": origin ?? "*",
          ...(origin ? { "Access-Control-Allow-Credentials": "true" } : {}),
          "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS, POST",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Allow-Private-Network": "true",
          Vary: "Origin",
        };

    if (event.req.method === "OPTIONS")
      return new Response(null, { status: 204, headers: corsHeaders });
    const res = await next();
    if (res instanceof Response && isVscodeApi) return withVscodeEmbedCors(event.req, res);
    if (res instanceof Response) {
      const h = new Headers(res.headers);
      for (const [k, v] of Object.entries(corsHeaders)) h.set(k, v);
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
    }
    return res;
  });

  base.mount("/api", api);
  // keep /api/* catch-alls working — if apps use `app/api/[...path]` with prefix /api/wildwood/*,
  // `api.mount("/")` already covers both, but ensure legacy `/api/git/*` → still works.
  return base;
}

/**
 * `Request → Response`. Same signature as Next's catch-all route; no next/* inside.
 * Host owns cookie + revalidateTag + auth — see `apps/docs/app/api/[...path]/route.ts`.
 */
export function handle(client: WildwoodClient, options?: CreateHandlerOptions) {
  const app = createHandler(client, options);
  return (req: Request): Promise<Response> => Promise.resolve(app.fetch(req));
}
