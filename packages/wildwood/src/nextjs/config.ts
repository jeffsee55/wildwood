import type { NextConfig } from "next";

/**
 * Packages Wildwood needs Next.js to transpile from source: they ship inline
 * CSS (`?inline`) and/or `"use client"` directives that must be processed by
 * the consuming app's bundler.
 *
 * `wildwood` itself is intentionally NOT transpiled — it keeps its Node-only
 * deps external via dynamic-import indirection so Turbopack never traces them
 * (avoids the Cache Components build-worker "id must be string" crash).
 */
const WILDWOOD_TRANSPILE_PACKAGES = ["wildwood-kit", "wildwood-shared", "wildwood-store"];

/**
 * Node-only deps that must stay external — they live in the app's
 * `node_modules` and are loaded at runtime, never bundled into RSC payloads.
 *
 * `better-auth` + the libsql dialect are NOT here: they're bundled into
 * `wildwood/dist` (tsdown `noExternal`) and reached only via the lazy
 * `import("./auth")` chunk, so consumer apps need no better-auth peer dep.
 * `@libsql/client` stays external — the app supplies the DB driver instance.
 */
const WILDWOOD_SERVER_EXTERNAL_PACKAGES = ["@libsql/client", "h3", "minimatch"];

function dedupe(...lists: (readonly string[] | undefined)[]): string[] {
  return [...new Set(lists.flatMap((list) => list ?? []))];
}

type Rewrite = { source: string; destination: string };

/**
 * Where each Wildwood OAuth/MCP discovery document is served from. Every field
 * is an absolute URL path (leading slash); all default from `base`, so the
 * common case stays a single string.
 */
type WildwoodWellKnownOptions = {
  /**
   * Mount prefix of the Wildwood catch-all (`app${base}/[...path]/route.ts`).
   * The handler that answers the forwarded discovery requests lives at
   * `${base}/wildwood`. Defaults to `/api`.
   */
  base?: string;
  /**
   * URL path of the MCP endpoint — the RFC 9728 protected-resource. The
   * well-known suffix mirrors it: `/.well-known/oauth-protected-resource${mcp}`.
   * Defaults to `${base}/wildwood/mcp`.
   */
  mcp?: string;
  /**
   * URL path of the better-auth issuer — the RFC 8414 authorization-server. The
   * well-known suffix mirrors it: `/.well-known/oauth-authorization-server${auth}`.
   * Defaults to `${base}/auth`.
   */
  auth?: string;
  /**
   * URL path of the preview-link landing route — where share-link visitors land.
   * Defaults to `${base}/wildwood/preview`.
   */
  preview?: string;
};

/** Fully-resolved discovery paths — every field an absolute URL path. */
type WildwoodPaths = { base: string; mcp: string; auth: string; preview: string };

/** Normalize to an absolute path: ensure a single leading slash, no trailing slash. */
function absPath(p: string): string {
  const trimmed = p.replace(/\/+$/, "");
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/**
 * Resolve the string-or-object arg into the three absolute paths that both the
 * next.config rewrites (`wildwoodWellKnown`) and the runtime route handler
 * (`createWildwoodRoute`) derive from. Keeping this single source of truth is
 * what guarantees the rewrite sources and the generated/proxied discovery docs
 * never drift.
 */
function resolveWildwoodPaths(options: string | WildwoodWellKnownOptions = "/api"): WildwoodPaths {
  const opts = typeof options === "string" ? { base: options } : options;
  const base = absPath(opts.base ?? "/api");
  const mcp = absPath(opts.mcp ?? `${base}/wildwood/mcp`);
  const auth = absPath(opts.auth ?? `${base}/auth`);
  const preview = absPath(opts.preview ?? `${base}/wildwood/preview`);
  return { base, mcp, auth, preview };
}

/**
 * Opt-in rewrites that route the MCP OAuth discovery documents into the
 * Wildwood catch-all. Drop the result straight into `next.config`:
 *
 * ```ts
 * import { wildwoodWellKnown } from "wildwood/nextjs/config";
 *
 * const nextConfig: NextConfig = {
 *   async rewrites() {
 *     return { beforeFiles: wildwoodWellKnown("/api"), afterFiles: [], fallback: [] };
 *   },
 * };
 * ```
 *
 * Why a rewrite at all: OAuth/MCP discovery docs live at the ORIGIN ROOT per
 * the MCP auth spec (RFC 8414 / RFC 9728) — a client given only the MCP URL
 * probes `/.well-known/oauth-*` at the host root. But the Wildwood handler is
 * mounted under the app's catch-all (`app${base}/[...path]/route.ts`), so the
 * root request has to be forwarded in.
 *
 * What it deliberately does NOT do: it never rewrites the bare-root
 * `/.well-known/oauth-authorization-server` (no suffix). Only the two
 * PATH-SCOPED suffixes that are genuinely Wildwood's are forwarded —
 * the protected-resource doc for the MCP endpoint and the
 * authorization-server doc for the better-auth issuer — so the app's own
 * root-level `/.well-known/*` routes are never shadowed.
 *
 * The path suffixes are not arbitrary labels: per the RFCs they mirror the real
 * resource URL and issuer URL. By default both derive from `base` (the mount
 * prefix of your catch-all), but the object form lets you point the two
 * discovery docs at independent locations when the MCP resource and the auth
 * issuer are not siblings under one prefix.
 *
 * @param options Either the catch-all mount prefix as a string (shorthand for
 *   `{ base }`, default `/api`), or a `WildwoodWellKnownOptions` object to set
 *   the MCP resource path and auth issuer path independently.
 *
 * @example
 * ```ts
 * // Shorthand — both docs derive from "/api":
 * wildwoodWellKnown("/api");
 *
 * // Object — auth issuer lives elsewhere than the Wildwood catch-all:
 * wildwoodWellKnown({ base: "/api", auth: "/auth" });
 * ```
 */
function wildwoodWellKnown(options: string | WildwoodWellKnownOptions = "/api"): Rewrite[] {
  const { base, mcp, auth } = resolveWildwoodPaths(options);
  // The catch-all handler that answers these lives at `${base}/wildwood`.
  const handler = `${base}/wildwood`;
  return [
    {
      source: `/.well-known/oauth-protected-resource${mcp}`,
      destination: `${handler}/.well-known/oauth-protected-resource${mcp}`,
    },
    {
      source: `/.well-known/oauth-authorization-server${auth}`,
      destination: `${handler}/.well-known/oauth-authorization-server${auth}`,
    },
  ];
}

/**
 * Wraps a Next.js config with the bundler settings Wildwood requires, so apps
 * don't have to know which packages need transpilation or which Node-only deps
 * must stay external.
 *
 * @example
 * ```ts
 * // next.config.ts
 * import { withWildwood } from "wildwood/nextjs/config";
 *
 * export default withWildwood({
 *   cacheComponents: true,
 * });
 * ```
 *
 * User-provided `transpilePackages` / `serverExternalPackages` are merged
 * (deduped), not overwritten.
 *
 * Note: this does NOT inject OAuth/MCP discovery rewrites — those are opt-in via
 * `wildwoodWellKnown()` so the app explicitly owns its `rewrites` config and no
 * root `/.well-known/*` routing happens behind its back.
 */
export function withWildwood(config: NextConfig = {}): NextConfig {
  return {
    ...config,
    transpilePackages: dedupe(WILDWOOD_TRANSPILE_PACKAGES, config.transpilePackages),
    serverExternalPackages: dedupe(
      WILDWOOD_SERVER_EXTERNAL_PACKAGES,
      config.serverExternalPackages,
    ),
  };
}

export {
  wildwoodWellKnown,
  resolveWildwoodPaths,
  WILDWOOD_TRANSPILE_PACKAGES,
  WILDWOOD_SERVER_EXTERNAL_PACKAGES,
};
export type { WildwoodWellKnownOptions, WildwoodPaths };
