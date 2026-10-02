import type { NextConfig } from "next";
/** Optional routing convenience only. No transpilation or asset/build configuration. */
export function wildwoodWellKnown(base = "/cms") {
  if (!/^\/[A-Za-z0-9_/-]+$/.test(base) || base.endsWith("/"))
    throw new Error("Invalid CMS mount path");
  return [
    {
      source: `/.well-known/oauth-protected-resource${base}/mcp`,
      destination: `${base}/.well-known/oauth-protected-resource`,
    },
    {
      source: `/.well-known/oauth-authorization-server${base}/auth`,
      destination: `${base}/auth/.well-known/oauth-authorization-server`,
    },
  ];
}
export function withWildwood(
  config: NextConfig = {},
  options: { base?: string; mcpDiscovery?: boolean } = {},
): NextConfig {
  if (!options.mcpDiscovery) return config;
  return {
    ...config,
    async rewrites() {
      const prior = await config.rewrites?.();
      const ours = wildwoodWellKnown(options.base);
      if (Array.isArray(prior)) return { beforeFiles: ours, afterFiles: prior, fallback: [] };
      return {
        beforeFiles: [...(prior?.beforeFiles ?? []), ...ours],
        afterFiles: prior?.afterFiles ?? [],
        fallback: prior?.fallback ?? [],
      };
    },
  };
}
