/**
 * Framework-agnostic H3 handler — the part `apps/docs` actually uses.
 * Zero deps on @wildwood/kit, better-auth, or next/*.
 */

import { H3 } from "h3";
import type { WildwoodClient } from "@/client/index";
import { vscodeEmbedCorsHeaders, withVscodeEmbedCors } from "@/nextjs/vscode-embed-csp";
import { createGitServiceRouter } from "@/nextjs/handlers/git-service";
import { createGitHubRouter } from "@/nextjs/handlers/github-router";
import { createVscodeRouter } from "@/nextjs/handlers/vscode-router";

export type CreateHandlerOptions = { currentRef?: string };

export function createHandler(client: WildwoodClient, _options?: CreateHandlerOptions) {
  const base = new H3();
  const app = new H3();

  app.mount("/git", createGitServiceRouter(client));
  app.mount("/vscode", createVscodeRouter(client));
  app.mount("/github", createGitHubRouter(client));

  base.use(async (event, next) => {
    const pathname = event.url.pathname;
    const isVscodeApi = pathname.startsWith("/api/vscode/");
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

    if (event.req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
    const res = await next();
    if (res instanceof Response && isVscodeApi) return withVscodeEmbedCors(event.req, res);
    if (res instanceof Response) {
      const h = new Headers(res.headers);
      for (const [k, v] of Object.entries(corsHeaders)) h.set(k, v);
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
    }
    return res;
  });

  base.mount("/api", app);
  return base;
}

/**
 * `Request → Response`. Same signature as Next's catch-all route; no next/* inside.
 * Host owns cookie + revalidateTag — see `apps/docs/app/api/[...path]/route.ts`.
 */
export function handle(client: WildwoodClient, options?: CreateHandlerOptions) {
  const app = createHandler(client, options);
  return (req: Request): Promise<Response> => Promise.resolve(app.fetch(req));
}
