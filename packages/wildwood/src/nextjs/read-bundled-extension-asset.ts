import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  getExtensionJsBytes,
  getWildwoodDarkThemeBytes,
} from "@/nextjs/bundled-extension-bytes.gen";

const nodeRequire = createRequire(import.meta.url);

const assetCache = new Map<string, Uint8Array>();

/** `wildwood` package root (`node_modules/wildwood` on Vercel, `packages/wildwood` in dev). */
export function getWildwoodPackageRoot(): string {
  return dirname(nodeRequire.resolve("wildwood/package.json"));
}

function extensionAssetRoots(): string[] {
  const roots = [
    join(getWildwoodPackageRoot(), "bundled-extension"),
    join(process.cwd(), "packages", "wildwood", "bundled-extension"),
    join(process.cwd(), "node_modules", "wildwood", "bundled-extension"),
    join(process.cwd(), "packages", "extension"),
    join(process.cwd(), "..", "..", "packages", "extension"),
    join(process.cwd(), "node_modules", "wildwood-vscode"),
  ];

  try {
    roots.push(dirname(nodeRequire.resolve("wildwood-vscode/package.json")));
  } catch {
    /* optional */
  }

  return [...new Set(roots)];
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

/** Read a wildwood-vscode asset; `dist/extension.js` is embedded at build time for serverless. */
export async function readBundledExtensionAsset(
  asset: string,
): Promise<Uint8Array | null> {
  const assetPath = String(asset);
  const cached = assetCache.get(assetPath);
  if (cached) {
    return cached;
  }

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

  for (const root of extensionAssetRoots()) {
    if (!existsSync(join(root, "package.json"))) {
      continue;
    }
    const filePath = join(root, assetPath);
    if (!existsSync(filePath)) {
      continue;
    }
    const bytes = new Uint8Array(await readFile(filePath));
    assetCache.set(assetPath, bytes);
    return bytes;
  }

  return null;
}
