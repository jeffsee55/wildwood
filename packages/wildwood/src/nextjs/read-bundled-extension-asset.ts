import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  getExtensionJsBytes,
  getExtensionNlsJsonBytes,
  getExtensionPackageJsonBytes,
  getWildwoodDarkThemeBytes,
} from "@/nextjs/bundled-extension-bytes.gen";

function resolveWildwoodPackageRootFallback(): string | undefined {
  try {
    const req = createRequire(import.meta.url);
    const pkgJson = req.resolve("wildwood/package.json");
    return dirname(pkgJson);
  } catch {
    return undefined;
  }
}

export function getWildwoodPackageRoot(): string {
  // Prefer monorepo cwd detection, then node_modules resolution, then relative.
  const cwd = process.cwd();
  for (const candidate of [
    join(cwd, "packages", "wildwood"),
    join(cwd, "node_modules", "wildwood"),
    join(cwd, "..", "..", "packages", "wildwood"),
  ]) {
    try {
      if (existsSync(join(candidate, "package.json"))) return candidate;
    } catch {}
  }
  const fromRequire = resolveWildwoodPackageRootFallback();
  if (fromRequire) return fromRequire;
  // Last resort: relative to this file's compiled location.
  // tsdown preserves src/ structure, so go up heuristically.
  return join(cwd, "packages", "wildwood");
}

// Optional full-manifest export that only exists after `scripts/copy-bundled-extension.mjs`
// has been re-run. The on-disk `bundled-extension-bytes.gen.ts` in the repo is currently
// stale (only minimal manifest embedded), so we must not statically import the missing
// symbol — that would crash the module evaluation in the Edge/Node server. Resolve lazily.
type MaybeFullExports = {
  getExtensionPackageJsonFullBytes?: () => Uint8Array;
  getExtensionPackageJsonFull?: () => unknown;
};
let cachedGen: MaybeFullExports | null = null;
async function tryGetFullBytesFromGen(): Promise<Uint8Array | null> {
  if (cachedGen === undefined) return null;
  if (!cachedGen) {
    try {
      // Dynamic import avoids static binding to a missing export.
      const mod = (await import("@/nextjs/bundled-extension-bytes.gen")) as unknown as MaybeFullExports;
      cachedGen = mod;
    } catch {
      cachedGen = {} as MaybeFullExports; // mark as tried
      return null;
    }
  }
  const fn = cachedGen?.getExtensionPackageJsonFullBytes;
  if (typeof fn !== "function") return null;
  try {
    return fn();
  } catch {
    return null;
  }
}

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

  // package.json / package.nls.json are special: VS Code web requires the FULL manifest
  // (contributes, browser, activationEvents, etc). The old embedded bytes only had the
  // minimal {name,publisher,version,enabledApiProposals} — serving that broke the editor.
  //
  // Strategy: FS first (bundled-extension/package.json is shipped via package.json.files),
  // then try the (new) full-bytes export from the gen module, then fall back to minimal.
  // This makes a stale gen file non-fatal.
  if (assetPath === "package.json" || assetPath === "package.nls.json") {
    for (const root of extensionAssetRoots()) {
      const filePath = join(root, assetPath);
      if (!existsSync(filePath)) continue;
      try {
        const bytes = new Uint8Array(await readFile(filePath));
        assetCache.set(assetPath, bytes);
        return bytes;
      } catch {
        // try next root
      }
    }
    if (assetPath === "package.json") {
      const full = await tryGetFullBytesFromGen();
      if (full) {
        assetCache.set(assetPath, full);
        return full;
      }
      // Last resort — minimal manifest. Editor will load degraded, but we avoid 500.
      const min = getExtensionPackageJsonBytes();
      assetCache.set(assetPath, min);
      return min;
    }
    if (assetPath === "package.nls.json") {
      const nls = getExtensionNlsJsonBytes();
      if (nls) {
        assetCache.set(assetPath, nls);
        return nls;
      }
    }
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
  // legacy name for fallback runners that touched min manifest bytes directly via package.json.
  if (assetPath === "package.min.json") {
    const bytes = getExtensionPackageJsonBytes();
    assetCache.set(assetPath, bytes);
    return bytes;
  }

  // Generic fallback: search local filesystem roots (useful in monorepo dev, not required in prod)
  for (const root of extensionAssetRoots()) {
    const filePath = join(root, assetPath);
    if (!existsSync(filePath)) continue;
    const bytes = new Uint8Array(await readFile(filePath));
    assetCache.set(assetPath, bytes);
    return bytes;
  }

  return null;
}
