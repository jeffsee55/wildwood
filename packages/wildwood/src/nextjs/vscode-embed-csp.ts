/**
 * Relaxed `Content-Security-Policy` for the embedded VS Code workbench
 * (`/api/vscode/editor`, workbench iframes, and **all** proxied `vscode-cdn` HTML).
 *
 * The workbench and extension host use **inline** scripts, **eval**, `blob:` workers,
 * and fetches to VS Code’s CDN. A hash-only policy in shipped HTML can block
 * `webWorkerExtensionHostIframe.html` → extension host never starts → no tr33
 * extension → `ENOPRO` for `wildwood-vfs://`.
 *
 * @see https://code.visualstudio.com/docs/remote/ssh (similar constraints for web)
 */
export const VSCODE_EMBED_DOCUMENT_CSP = [
  "default-src 'self' data: blob: https:",
  "base-uri 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https: http://127.0.0.1:* http://localhost:* data: blob:",
  "worker-src 'self' blob: data: https:",
  "style-src 'self' 'unsafe-inline' data: https:",
  "img-src 'self' data: blob: https: http:",
  "font-src 'self' data: https:",
  "connect-src 'self' https: http: ws: wss: data: blob: https://*.vscode-cdn.net",
  "frame-src 'self' data: blob: https:",
  "media-src 'self' data: blob: https:",
].join("; ");

/**
 * `vscode-web` ships many HTML surfaces (e.g. `webWorkerExtensionHostIframe.html`, not
 * just `workbench.html` and `/editor`). Each must get this policy, or the extension
 * host iframe fails to run inline script → no tr33 extension → `ENOPRO` on `wildwood-vfs://`.
 */
export function stripBuiltInCspMetaFromHtml(html: string): string {
  return html.replace(/<meta[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, "");
}

/**
 * Use for every `Response` that serves `text/html` from `/api/vscode/cdn/**`.
 * Includes no-store to match the rest of the embed.
 */
export const VSCODE_EMBED_HTML_RESPONSE_HEADERS: Record<string, string> = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": VSCODE_EMBED_DOCUMENT_CSP,
  "cache-control": "no-store, no-cache, must-revalidate",
  pragma: "no-cache",
  expires: "0",
};

/** CORS for extension host on `*.vscode-cdn.net` fetching embedder `/api/vscode/**` assets. */
export function vscodeEmbedCorsHeaders(req: {
  headers: { get: (name: string) => string | null };
}): Record<string, string> {
  const origin = req.headers.get("origin");
  return {
    "Access-Control-Allow-Origin": origin ?? "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Private-Network": "true",
    Vary: "Origin",
  };
}

export function withVscodeEmbedCors(req: Request, response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(vscodeEmbedCorsHeaders(req))) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Proxied static assets (commit-pinned); edge and browsers cache these. */
export function vscodeWebStaticCacheHeaders(commit: string): Record<string, string> {
  return {
    "cache-control": "public, max-age=31536000, immutable",
    "cdn-cache-control": "public, max-age=31536000, immutable",
    "vercel-cdn-cache-control": "public, max-age=31536000, immutable",
    "x-vscode-commit": commit,
  };
}

/** Git trees/blobs keyed by OID — safe to cache immutably in browser and CDN. */
export function gitObjectCacheHeaders(oid: string): Record<string, string> {
  return {
    "cache-control": "public, max-age=31536000, immutable",
    "cdn-cache-control": "public, max-age=31536000, immutable",
    "vercel-cdn-cache-control": "public, max-age=31536000, immutable",
    "x-git-oid": oid,
  };
}

/** Cacheable workbench shell — ref comes from same-origin `localStorage`, not this HTML. */
export function vscodeEmbedEditorCacheHeaders(commit: string): Record<string, string> {
  return {
    "content-type": "text/html; charset=utf-8",
    ...vscodeWebStaticCacheHeaders(commit),
    "content-security-policy": VSCODE_EMBED_DOCUMENT_CSP,
  };
}
