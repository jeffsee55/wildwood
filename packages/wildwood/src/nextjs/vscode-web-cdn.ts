import { withVscodeEmbedCors } from "./vscode-embed-csp";

export type VscodeWebCdn = {
  commit: string;
  version: string;
  /** `https://main.vscode-cdn.net/stable/{commit}` */
  cdnBase: string;
};

let vscodeWebCdnPromise: Promise<VscodeWebCdn> | null = null;

const VSCODE_WEB_PLATFORM = process.env.WILDWOOD_VSCODE_WEB_PLATFORM || "server-linux-x64-web";

async function fetchLatestVersion(): Promise<string> {
  const response = await fetch("https://update.code.visualstudio.com/api/releases/stable");
  if (!response.ok) {
    throw new Error(`Failed to resolve VS Code version: ${response.status}`);
  }
  const versions = (await response.json()) as string[];
  if (versions.length === 0) {
    throw new Error("No stable VS Code versions returned");
  }
  return versions[0];
}

async function fetchLatestCommit(): Promise<string> {
  const response = await fetch(
    `https://update.code.visualstudio.com/api/commits/stable/${VSCODE_WEB_PLATFORM}`,
  );
  if (!response.ok) {
    throw new Error(`Failed to resolve VS Code commit: ${response.status}`);
  }
  const commits = (await response.json()) as string[];
  if (commits.length === 0) {
    throw new Error("No stable VS Code commits returned");
  }
  return commits[0];
}

/** Stable VS Code web assets on `main.vscode-cdn.net` (not bundled in serverless). */
const FALLBACK_VSCODE_COMMIT =
  process.env.WILDWOOD_VSCODE_WEB_COMMIT?.trim() || "8a1aaed389a7bc6a8f2d9dbc2b34635633cf8ff2";
const FALLBACK_VSCODE_VERSION =
  process.env.WILDWOOD_VSCODE_WEB_VERSION?.trim() &&
  process.env.WILDWOOD_VSCODE_WEB_VERSION.trim() !== "latest"
    ? process.env.WILDWOOD_VSCODE_WEB_VERSION.trim()
    : "1.105.1";

async function fetchWithTimeout(url: string, ms = 4000): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function tryFetchLatestVersion(): Promise<string | null> {
  try {
    const res = await fetchWithTimeout("https://update.code.visualstudio.com/api/releases/stable");
    if (!res.ok) throw new Error(String(res.status));
    const versions = (await res.json()) as string[];
    return versions[0] ?? null;
  } catch (e) {
    console.warn(
      `[wildwood:vscode-cdn] fetchLatestVersion failed, using fallback ${FALLBACK_VSCODE_VERSION}:`,
      e instanceof Error ? e.message : e,
    );
    return null;
  }
}

async function tryFetchLatestCommit(): Promise<string | null> {
  try {
    const res = await fetchWithTimeout(
      `https://update.code.visualstudio.com/api/commits/stable/${VSCODE_WEB_PLATFORM}`,
    );
    if (!res.ok) throw new Error(String(res.status));
    const commits = (await res.json()) as string[];
    return commits[0] ?? null;
  } catch (e) {
    console.warn(
      `[wildwood:vscode-cdn] fetchLatestCommit failed, using fallback ${FALLBACK_VSCODE_COMMIT}:`,
      e instanceof Error ? e.message : e,
    );
    return null;
  }
}

export function resolveVscodeWebCdn(): Promise<VscodeWebCdn> {
  if (!vscodeWebCdnPromise) {
    vscodeWebCdnPromise = (async () => {
      const commitOverride = process.env.WILDWOOD_VSCODE_WEB_COMMIT?.trim();
      const versionOverride = process.env.WILDWOOD_VSCODE_WEB_VERSION?.trim();

      let commit: string | null = commitOverride || null;
      let version: string | null =
        versionOverride && versionOverride !== "latest" ? versionOverride : null;

      if (!commit) commit = await tryFetchLatestCommit();
      if (!version) version = await tryFetchLatestVersion();

      // Never throw during build/prerender — fall back to known good.
      const finalCommit = commit || FALLBACK_VSCODE_COMMIT;
      const finalVersion = version || FALLBACK_VSCODE_VERSION;

      return {
        commit: finalCommit,
        version: finalVersion,
        cdnBase: `https://main.vscode-cdn.net/stable/${finalCommit}`,
      };
    })();
  }
  return vscodeWebCdnPromise;
}

export function vscodeCdnProxyPrefix(apiPrefix: string, commit: string): string {
  return `${apiPrefix}/cdn/${commit}`;
}

/** Same-origin URL for a vscode-cdn asset (required for `type="module"` scripts). */
export function vscodeCdnProxyAssetUrl(
  origin: string,
  apiPrefix: string,
  commit: string,
  assetPath: string,
): string {
  const prefix = vscodeCdnProxyPrefix(apiPrefix, commit);
  return `${origin}${prefix}/${assetPath.replace(/^\/+/, "")}`;
}

/** Proxy `main.vscode-cdn.net` metadata (e.g. marketplace.json) through the embedder origin. */
export async function proxyMainVscodeCdnAsset(req: Request, assetPath: string): Promise<Response> {
  const url = `https://main.vscode-cdn.net/${assetPath.replace(/^\/+/, "")}`;
  const upstream = await fetch(url, {
    headers: { "Accept-Encoding": "identity" },
  });
  const headers = new Headers();
  const contentType = upstream.headers.get("content-type");
  if (contentType) {
    headers.set("content-type", contentType);
  }
  headers.set("cache-control", "public, max-age=3600");
  if (!upstream.ok) {
    return withVscodeEmbedCors(
      req,
      new Response("Not found", { status: upstream.status, headers }),
    );
  }
  return withVscodeEmbedCors(
    req,
    new Response(upstream.body, { status: upstream.status, headers }),
  );
}
