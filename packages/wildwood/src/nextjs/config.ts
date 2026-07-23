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
 * Heavy Node-only deps that must stay external — they live in the app's
 * `node_modules` and are loaded at runtime via dynamic indirection, never
 * bundled into RSC payloads.
 */
const WILDWOOD_SERVER_EXTERNAL_PACKAGES = [
  "better-auth",
  "@libsql/client",
  "@libsql/kysely-libsql",
  "kysely",
  "h3",
  "minimatch",
];

function dedupe(...lists: (readonly string[] | undefined)[]): string[] {
  return [...new Set(lists.flatMap((list) => list ?? []))];
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
  WILDWOOD_TRANSPILE_PACKAGES,
  WILDWOOD_SERVER_EXTERNAL_PACKAGES,
};
