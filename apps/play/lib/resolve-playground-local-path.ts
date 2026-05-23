import fs from "node:fs";
import path from "node:path";
import type { PlaygroundConfig } from "./playground-config";

const MAX_WALK = 10;

/**
 * If `raw` is empty, walk up from `cwd` (the Next / dev server process, usually
 * `.../tr33/apps/play`) until we find a directory with `.git` and a `content/`
 * folder — the tr33 monorepo layout. Falls back to `../..` from cwd, then cwd.
 * If `raw` is set, treat relative paths as relative to `cwd`; absolute as-is.
 */
export function resolvePlaygroundLocalPath(
  raw: string,
  cwd: string = process.cwd(),
): string {
  const t = (raw ?? "").trim();
  if (t) {
    return path.isAbsolute(t) ? path.normalize(t) : path.resolve(cwd, t);
  }
  if (process.env.TR33_PLAYGROUND_LOCAL_ROOT?.trim()) {
    return path.resolve(process.env.TR33_PLAYGROUND_LOCAL_ROOT.trim());
  }
  let dir = cwd;
  for (let i = 0; i < MAX_WALK; i++) {
    if (isTr33RepoLayout(dir)) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return path.resolve(cwd, "..", "..");
}

function isTr33RepoLayout(dir: string): boolean {
  try {
    return (
      fs.existsSync(path.join(dir, ".git")) &&
      fs.existsSync(path.join(dir, "content"))
    );
  } catch {
    return false;
  }
}

/**
 * The path actually passed to `defineConfig` for a local source (null for GitHub).
 */
export function getResolvedLocalPathForPlayground(
  config: PlaygroundConfig,
): string | null {
  if (config.source !== "local") {
    return null;
  }
  return resolvePlaygroundLocalPath(config.localPath);
}

/**
 * Fail fast with a clear message if the play app points at a non-repo directory.
 */
export function assertUsableLocalGitRoot(resolved: string): void {
  if (!fs.existsSync(resolved)) {
    throw new Error(
      `Local path does not exist: ${resolved} (Next cwd is ${process.cwd()}). If you use a relative path, it is resolved from the app directory, usually apps/play.`,
    );
  }
  if (!fs.existsSync(path.join(resolved, ".git"))) {
    throw new Error(
      `Not a git repository root (no .git): ${resolved}. The playground needs the monorepo root that contains the content/ you’re matching, e.g. the tr33 root when running from apps/play.`,
    );
  }
}
