import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const nodeRequire = createRequire(import.meta.url);

let extensionRoot: string | undefined;

function tr33PackageRootFromModule(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** Resolved tr33-vscode root: `bundled-extension/` shipped with `tr33`, then monorepo / node_modules. */
export function getTr33ExtensionRoot(): string {
  if (extensionRoot) {
    return extensionRoot;
  }

  const tryRoot = (root: string | undefined): string | undefined => {
    if (!root) {
      return undefined;
    }
    const pkg = path.join(root, "package.json");
    if (existsSync(pkg)) {
      return root;
    }
    return undefined;
  };

  const bundled = tryRoot(
    path.join(tr33PackageRootFromModule(), "bundled-extension"),
  );
  if (bundled) {
    extensionRoot = bundled;
    return extensionRoot;
  }

  const tryResolve = (resolve: () => string): string | undefined => {
    try {
      const resolved = resolve();
      if (!resolved.includes("[project]") && existsSync(resolved)) {
        return path.dirname(resolved);
      }
    } catch {
      /* try next */
    }
    return undefined;
  };

  const fromTr33Pkg = tryResolve(() => {
    const tr33PkgJson = path.join(tr33PackageRootFromModule(), "package.json");
    return createRequire(tr33PkgJson).resolve("tr33-vscode/package.json");
  });
  if (fromTr33Pkg) {
    extensionRoot = fromTr33Pkg;
    return extensionRoot;
  }

  const fromNodeRequire = tryResolve(() =>
    nodeRequire.resolve("tr33-vscode/package.json"),
  );
  if (fromNodeRequire) {
    extensionRoot = fromNodeRequire;
    return extensionRoot;
  }

  const cwd = process.cwd();
  for (const candidate of [
    path.join(cwd, "packages", "extension"),
    path.join(cwd, "..", "..", "packages", "extension"),
    path.join(cwd, "node_modules", "tr33-vscode"),
    path.join(cwd, "node_modules", "tr33", "node_modules", "tr33-vscode"),
  ]) {
    const root = tryRoot(candidate);
    if (root) {
      extensionRoot = root;
      return extensionRoot;
    }
  }

  throw new Error(
    `Could not resolve tr33-vscode package root (cwd=${cwd}). Run tr33 build (bundled-extension) or install workspace deps.`,
  );
}
