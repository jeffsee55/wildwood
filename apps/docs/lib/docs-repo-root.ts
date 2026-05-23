import { existsSync } from "node:fs";
import path from "node:path";

const CONTENT_MARKER = path.join("content", "docs");

/** Monorepo root containing `content/docs` (works from `apps/docs` or repo root). */
export function resolveDocsRepoRoot(): string {
  if (process.env.TR33_DOCS_REPO_PATH?.trim()) {
    return path.resolve(process.env.TR33_DOCS_REPO_PATH.trim());
  }

  let dir = process.cwd();
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(path.join(dir, CONTENT_MARKER))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  return path.resolve(process.cwd(), "../..");
}

export function hasLocalDocsContent(): boolean {
  return existsSync(path.join(resolveDocsRepoRoot(), CONTENT_MARKER));
}
