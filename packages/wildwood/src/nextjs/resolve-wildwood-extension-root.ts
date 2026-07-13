import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { getWildwoodPackageRoot } from "@/nextjs/read-bundled-extension-asset";

const nodeRequire = createRequire(import.meta.url);

let extensionRoot: string | undefined;

/** Resolved wildwood-vscode root: `bundled-extension/` shipped with `wildwood`, then monorepo / node_modules. */
export function getWildwoodExtensionRoot(): string {
  if (extensionRoot) {
    return extensionRoot;
  }

  const tryRoot = (root: string | undefined): string | undefined => {
    if (!root) {
      return undefined;
    }
    const pkg = join(root, "package.json");
    if (existsSync(pkg)) {
      return root;
    }
    return undefined;
  };

  const bundled = tryRoot(join(getWildwoodPackageRoot(), "bundled-extension"));
  if (bundled) {
    extensionRoot = bundled;
    return extensionRoot;
  }

  const tryResolve = (resolve: () => string): string | undefined => {
    try {
      const resolved = resolve();
      if (!resolved.includes("[project]") && existsSync(resolved)) {
        return dirname(resolved);
      }
    } catch {
      /* try next */
    }
    return undefined;
  };

  const fromWildwoodPkg = tryResolve(() => {
    const wildwoodPkgJson = join(getWildwoodPackageRoot(), "package.json");
    return createRequire(wildwoodPkgJson).resolve("wildwood-vscode/package.json");
  });
  if (fromWildwoodPkg) {
    extensionRoot = fromWildwoodPkg;
    return extensionRoot;
  }

  const fromNodeRequire = tryResolve(() => nodeRequire.resolve("wildwood-vscode/package.json"));
  if (fromNodeRequire) {
    extensionRoot = fromNodeRequire;
    return extensionRoot;
  }

  const cwd = process.cwd();
  for (const candidate of [
    join(cwd, "packages", "extension"),
    join(cwd, "..", "..", "packages", "extension"),
    join(cwd, "node_modules", "wildwood-vscode"),
    join(cwd, "node_modules", "wildwood", "node_modules", "wildwood-vscode"),
  ]) {
    const root = tryRoot(candidate);
    if (root) {
      extensionRoot = root;
      return extensionRoot;
    }
  }

  throw new Error(
    `Could not resolve wildwood-vscode package root (cwd=${cwd}). Run wildwood build (bundled-extension) or install workspace deps.`,
  );
}
