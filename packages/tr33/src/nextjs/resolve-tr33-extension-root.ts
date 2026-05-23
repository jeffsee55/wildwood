import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const nodeRequire = createRequire(import.meta.url);

let extensionRoot: string | undefined;

/** Resolved `tr33-vscode` package root (`packages/extension` in the monorepo). */
export function getTr33ExtensionRoot(): string {
  if (extensionRoot) {
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
    const tr33PkgJson = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "package.json",
    );
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
    path.join(cwd, "node_modules", "tr33-vscode"),
    path.join(cwd, "node_modules", "tr33", "node_modules", "tr33-vscode"),
    path.join(cwd, "..", "..", "packages", "extension"),
    path.join(cwd, "packages", "extension"),
  ]) {
    const pkg = path.join(candidate, "package.json");
    if (existsSync(pkg)) {
      extensionRoot = candidate;
      return extensionRoot;
    }
  }

  throw new Error(
    `Could not resolve tr33-vscode package root (cwd=${cwd}). Install workspace deps or run from the monorepo.`,
  );
}
