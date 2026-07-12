import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  getExtensionJsBytes,
  getExtensionNlsJsonBytes,
  getExtensionPackageJsonBytes,
  getWildwoodDarkThemeBytes,
} from "@/nextjs/bundled-extension-bytes.gen";

const assetCache = new Map<string, Uint8Array>();

function extensionAssetRoots(): string[] {
  // Filesystem fallback is dev-only convenience; production reads exclusively
  // from embedded bytes. No `require("wildwood/package.json")` or `import.meta`
  // URL tricks — those break when Next.js bundles the handler.
  return [
    join(process.cwd(), "packages", "wildwood", "bundled-extension"),
    join(process.cwd(), "node_modules", "wildwood", "bundled-extension"),
    join(process.cwd(), "packages", "extension"),
    join(process.cwd(), "..", "..", "packages", "extension"),
  ];
}

export function extensionAssetContentType(asset: string): string | undefined {
  const lower = asset.toLowerCase();
  if (lower.endsWith(".js")) {
    return "application/javascript; charset=utf-8";
  }
  if (lower.endsWith(".json")) {
    return "application/json; charset=utf-8";
  }
  return undefined;
}

/** Read a wildwood-vscode asset; built-ins are embedded at build time for serverless. */
export async function readBundledExtensionAsset(
  asset: string,
): Promise<Uint8Array | null> {
  const assetPath = String(asset);
  const cached = assetCache.get(assetPath);
  if (cached) {
    return cached;
  }

  // Embedded — always available, no filesystem needed (serverless-safe)
  if (assetPath === "dist/extension.js") {
    const bytes = getExtensionJsBytes();
    assetCache.set(assetPath, bytes);
    return bytes;
  }
  if (assetPath === "themes/wildwood-dark.json") {
    const bytes = getWildwoodDarkThemeBytes();
    assetCache.set(assetPath, bytes);
    return bytes;
  }
  if (assetPath === "package.json") {
    const bytes = getExtensionPackageJsonBytes();
    assetCache.set(assetPath, bytes);
    return bytes;
  }
  if (assetPath === "package.nls.json") {
    const nls = getExtensionNlsJsonBytes();
    if (nls) {
      assetCache.set(assetPath, nls);
      return nls;
    }
  }

  // Fallback: search local filesystem roots (useful in monorepo dev, not required in prod)
  for (const root of extensionAssetRoots()) {
    const filePath = join(root, assetPath);
    if (!existsSync(filePath)) continue;
    const bytes = new Uint8Array(await readFile(filePath));
    assetCache.set(assetPath, bytes);
    return bytes;
  }

  return null;
}
