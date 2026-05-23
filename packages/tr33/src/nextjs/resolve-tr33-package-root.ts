import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const nodeRequire = createRequire(import.meta.url);

/** Resolve `packages/tr33` (or `node_modules/tr33`) from dist, workspace, or app cwd. */
export function resolveTr33PackageRoot(): string {
  try {
    const pkgJson = nodeRequire.resolve("tr33/package.json");
    return path.dirname(pkgJson);
  } catch {
    /* fall through */
  }

  const fromDist = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
  );
  if (isTr33PackageRoot(fromDist)) {
    return fromDist;
  }

  const cwd = process.cwd();
  const candidates = [
    path.join(cwd, "node_modules", "tr33"),
    path.join(cwd, "..", "..", "packages", "tr33"),
    path.join(cwd, "..", "packages", "tr33"),
    path.join(cwd, "packages", "tr33"),
  ];
  for (const candidate of candidates) {
    if (isTr33PackageRoot(candidate)) {
      return candidate;
    }
  }

  return fromDist;
}

function isTr33PackageRoot(dir: string): boolean {
  try {
    const raw = readFileSync(path.join(dir, "package.json"), "utf-8");
    return (JSON.parse(raw) as { name?: string }).name === "tr33";
  } catch {
    return false;
  }
}
