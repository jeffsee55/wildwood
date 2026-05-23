/**
 * Relaxed `Content-Security-Policy` for the embedded VS Code workbench
 * (`/api/vscode/editor`, `workbench.html`, and **all** other `vscode-web` HTML assets).
 *
 * The workbench and extension host use **inline** scripts, **eval**, `blob:` workers,
 * and fetches to VS Code’s CDN. A hash-only policy in shipped HTML can block
 * `webWorkerExtensionHostIframe.html` → extension host never starts → no tr33
 * extension → `ENOPRO` for `vscode-vfs://`.
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
 * host iframe fails to run inline script → no tr33 extension → `ENOPRO` on `vscode-vfs://`.
 */
export function stripBuiltInCspMetaFromHtml(html: string): string {
  return html.replace(
    /<meta[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi,
    "",
  );
}

/**
 * Use for every `Response` that serves `text/html` from `/api/vscode/vscode-web/**`.
 * Includes no-store to match the rest of the embed.
 */
export const VSCODE_EMBED_HTML_RESPONSE_HEADERS: Record<string, string> = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": VSCODE_EMBED_DOCUMENT_CSP,
  "cache-control": "no-store, no-cache, must-revalidate",
  pragma: "no-cache",
  expires: "0",
};

/** Versioned static assets (js/css/fonts); browsers and the edge cache these. */
export function vscodeWebStaticCacheHeaders(version: string): Record<string, string> {
  return {
    "cache-control": "public, max-age=31536000, immutable",
    "cdn-cache-control": "public, max-age=31536000, immutable",
    "vercel-cdn-cache-control": "public, max-age=31536000, immutable",
    "x-vscode-version": version,
  };
}
