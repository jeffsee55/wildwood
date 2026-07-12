import {
  activeRefSetCookieHeader,
  cookiesFromCookieHeader,
  handle,
} from "tr33/nextjs";

import { getPlaygroundTr33 } from "@/lib/tr33";

/**
 * Play reuses the same `tr33-active-ref` cookie name for consistency with docs.
 * You can pick any cookie — active-ref lives entirely in host app glue now.
 */
const REVALIDATE_HINT = "playground-content" as const;
void REVALIDATE_HINT;

async function tr33HandlerFor(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname;

  // Exit preview — clear the cookie on our side
  if (request.method === "POST" && pathname.endsWith("/tr33/preview")) {
    // NextResponse not available from pure H3, so we craft a redirect-style response
    // that the browser will accept for cookie clearing. Host should delete its own cookie.
    return new Response(JSON.stringify({ ok: true }), {
      headers: {
        "content-type": "application/json",
        "Set-Cookie": `${"tr33-active-ref"}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
      },
    });
  }

  const tr33 = getPlaygroundTr33(cookiesFromCookieHeader(request.headers.get("cookie")));
  const api = handle(tr33);

  let createBranchNameFromRequest: string | undefined;
  if (request.method === "POST" && /\/git\/create-branch\/?$/.test(pathname)) {
    try {
      const b = (await request.clone().json()) as { name?: string };
      const n = typeof b.name === "string" ? b.name.trim() : "";
      if (n) createBranchNameFromRequest = n;
    } catch {}
  }

  const upstream = await api(request);

  // Track branch name for Set-Cookie after success
  let branch: string | undefined;
  if (request.method === "POST" && /\/git\/create-branch\/?$/.test(pathname)) {
    if (createBranchNameFromRequest) branch = createBranchNameFromRequest;
    else {
      try {
        const data = (await upstream.clone().json()) as { ref?: string };
        if (typeof data.ref === "string" && data.ref.trim()) branch = data.ref.trim();
      } catch {}
    }
  } else if (request.method === "POST" && /\/git\/switch-branch\/?$/.test(pathname)) {
    try {
      const data = (await upstream.clone().json()) as { ref?: string };
      if (typeof data.ref === "string" && data.ref.trim()) branch = data.ref.trim();
    } catch {}
  } else {
    return upstream;
  }

  if (!branch) return upstream;

  const headers = new Headers(upstream.headers);
  headers.delete("set-cookie");
  headers.append("Set-Cookie", activeRefSetCookieHeader(branch));
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

export const GET = tr33HandlerFor;
export const HEAD = tr33HandlerFor;
export const OPTIONS = tr33HandlerFor;
/** Git mutations and other Tr33 APIs use POST; Next only forwards exported methods. */
export const POST = tr33HandlerFor;
