import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { resolveTr33PackageRoot } from "@/nextjs/resolve-tr33-package-root";

export type VscodeWebVendorManifest = {
  platform: string;
  version: string;
  versionDir: string;
  /** Path relative to `vendor/vscode-web/`. */
  rootRelative: string;
};

const vendorRoot = () =>
  path.join(resolveTr33PackageRoot(), "vendor", "vscode-web");

export async function loadVendoredVscodeWebAssets(): Promise<{
  rootDir: string;
  version: string;
}> {
  const root = vendorRoot();
  const manifestPath = path.join(root, "current.json");
  let manifest: VscodeWebVendorManifest;
  try {
    manifest = JSON.parse(
      await readFile(manifestPath, "utf-8"),
    ) as VscodeWebVendorManifest;
  } catch {
    throw new Error(
      `VS Code web vendor manifest not found at ${manifestPath}. ` +
        "Run `pnpm run build` in packages/tr33 (included in turbo `tr33#build`).",
    );
  }

  const assetsRoot = path.join(root, manifest.rootRelative);
  try {
    await stat(assetsRoot);
  } catch {
    throw new Error(
      `VS Code web vendor assets missing at ${assetsRoot} (manifest version ${manifest.version}). ` +
        "Re-run `pnpm run build` in packages/tr33.",
    );
  }

  return { rootDir: assetsRoot, version: manifest.version };
}
