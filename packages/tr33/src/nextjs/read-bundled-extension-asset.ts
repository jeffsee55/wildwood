import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { getExtensionJsBytes } from "@/nextjs/bundled-extension-bytes.gen";

const nodeRequire = createRequire(import.meta.url);

const assetCache = new Map<string, Uint8Array>();

/** `tr33` package root (`node_modules/tr33` on Vercel, `packages/tr33` in dev). */
export function getTr33PackageRoot(): string {
  return path.dirname(nodeRequire.resolve("tr33/package.json"));
}

function extensionAssetRoots(): string[] {
  const roots = [
    path.join(getTr33PackageRoot(), "bundled-extension"),
    path.join(process.cwd(), "packages", "tr33", "bundled-extension"),
    path.join(process.cwd(), "node_modules", "tr33", "bundled-extension"),
    path.join(process.cwd(), "packages", "extension"),
    path.join(process.cwd(), "..", "..", "packages", "extension"),
    path.join(process.cwd(), "node_modules", "tr33-vscode"),
  ];

  try {
    roots.push(path.dirname(nodeRequire.resolve("tr33-vscode/package.json")));
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

/** Read a tr33-vscode asset; `dist/extension.js` is embedded at build time for serverless. */
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

  for (const root of extensionAssetRoots()) {
    if (!existsSync(path.join(root, "package.json"))) {
      continue;
    }
    const filePath = path.join(root, assetPath);
    if (!existsSync(filePath)) {
      continue;
    }
    const bytes = new Uint8Array(await readFile(filePath));
    assetCache.set(assetPath, bytes);
    return bytes;
  }

  return null;
}
