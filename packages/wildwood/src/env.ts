/**
 * First-class Vercel System Env resolution for Wildwood.
 *
 * Goal: `defineConfig({ collections })` just works on Vercel without any
 * `WILDWOOD_*` env vars. We infer `org`, `repo`, `ref`, `origin` from
 * Vercel's System Environment Variables when available, falling back to
 * explicit `WILDWOOD_*` overrides, then to local git remote parsing.
 *
 * Reference: https://vercel.com/docs/environment-variables/system-environment-variables
 *
 * Priority (highest → lowest):
 *   org:
 *     1. explicit param (config.org)
 *     2. WILDWOOD_GITHUB_ORG / WILDWOOD_ORG / GITHUB_ORG
 *     3. VERCEL_GIT_REPO_OWNER (system)
 *     4. git remote.origin owner (dev only, fs read)
 *   repo:
 *     1. explicit
 *     2. WILDWOOD_GITHUB_REPO / WILDWOOD_REPO / GITHUB_REPO
 *     3. VERCEL_GIT_REPO_SLUG (system)
 *     4. git remote.origin repo
 *   ref:
 *     1. explicit
 *     2. WILDWOOD_DOCS_REF / WILDWOOD_REF / WILDWOOD_GIT_REF
 *     3. VERCEL_GIT_COMMIT_REF (branch name, e.g. "main", "feat/foo")
 *     4. VERCEL_GIT_COMMIT_SHA (pinned SHA, useful for immutable deploys)
 *     5. "main"
 *   origin / production URL:
 *     1. NEXT_PUBLIC_ORIGIN / ORIGIN / NEXT_PUBLIC_SITE_URL
 *     2. VERCEL_PROJECT_PRODUCTION_URL
 *     3. VERCEL_BRANCH_URL (preview)
 *     4. VERCEL_URL
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

function trimEnv(name: string): string | undefined {
  const v = process.env[name];
  if (v == null) return undefined;
  const t = v.trim();
  return t.length ? t : undefined;
}

function withHttps(hostOrUrl: string | undefined): string | undefined {
  if (!hostOrUrl) return undefined;
  const t = hostOrUrl.trim();
  if (!t) return undefined;
  if (t.startsWith("http://") || t.startsWith("https://")) return t;
  return `https://${t}`;
}

// ---------------------------------------------------------------------------
// Vercel detection
// ---------------------------------------------------------------------------

export function isVercel(): boolean {
  return trimEnv("VERCEL") === "1" || Boolean(trimEnv("VERCEL_ENV"));
}

export function vercelEnv(): string | undefined {
  return trimEnv("VERCEL_ENV"); // production | preview | development
}

export type VercelSystemEnv = {
  isVercel: boolean;
  env: string | undefined;
  targetEnv: string | undefined;
  deploymentId: string | undefined;
  projectId: string | undefined;
  region: string | undefined;
  url: string | undefined; // *.vercel.app (no scheme)
  branchUrl: string | undefined;
  productionUrl: string | undefined;
  git: {
    provider: string | undefined;
    owner: string | undefined;
    slug: string | undefined;
    repoId: string | undefined;
    commitRef: string | undefined;
    commitSha: string | undefined;
    commitMessage: string | undefined;
    pullRequestId: string | undefined;
    previousSha: string | undefined;
  };
  origin: string | undefined; // absolute https://...
};

let cachedVercelEnv: VercelSystemEnv | null = null;

export function getVercelSystemEnv(): VercelSystemEnv {
  if (cachedVercelEnv) return cachedVercelEnv;

  const productionUrl = trimEnv("VERCEL_PROJECT_PRODUCTION_URL");
  const branchUrl = trimEnv("VERCEL_BRANCH_URL");
  const url = trimEnv("VERCEL_URL");

  // NEXT_PUBLIC_ORIGIN wins over Vercel auto URLs, but we still compute the
  // Vercel fallback so callers can use a single `origin` without wiring env.
  const explicitOrigin =
    trimEnv("NEXT_PUBLIC_ORIGIN") ||
    trimEnv("ORIGIN") ||
    trimEnv("NEXT_PUBLIC_SITE_URL") ||
    trimEnv("SITE_URL");

  const fallbackOrigin = productionUrl || branchUrl || url;
  const origin = withHttps(explicitOrigin || fallbackOrigin);

  const env: VercelSystemEnv = {
    isVercel: isVercel(),
    env: trimEnv("VERCEL_ENV"),
    targetEnv: trimEnv("VERCEL_TARGET_ENV"),
    deploymentId: trimEnv("VERCEL_DEPLOYMENT_ID"),
    projectId: trimEnv("VERCEL_PROJECT_ID"),
    region: trimEnv("VERCEL_REGION"),
    url,
    branchUrl,
    productionUrl,
    git: {
      provider: trimEnv("VERCEL_GIT_PROVIDER"),
      owner: trimEnv("VERCEL_GIT_REPO_OWNER"),
      slug: trimEnv("VERCEL_GIT_REPO_SLUG"),
      repoId: trimEnv("VERCEL_GIT_REPO_ID"),
      commitRef: trimEnv("VERCEL_GIT_COMMIT_REF"),
      commitSha: trimEnv("VERCEL_GIT_COMMIT_SHA"),
      commitMessage: trimEnv("VERCEL_GIT_COMMIT_MESSAGE"),
      pullRequestId: trimEnv("VERCEL_GIT_PULL_REQUEST_ID"),
      previousSha: trimEnv("VERCEL_GIT_PREVIOUS_SHA"),
    },
    origin,
  };

  cachedVercelEnv = env;
  return env;
}

/** Clear cached Vercel env (for tests that mutate process.env). */
export function __resetVercelEnvCache(): void {
  cachedVercelEnv = null;
}

// ---------------------------------------------------------------------------
// Git remote parsing (dev zero-config)
// ---------------------------------------------------------------------------

export function parseGitRemoteUrl(
  remoteUrl: string,
): { org: string; repo: string } | null {
  const url = remoteUrl.trim().replace(/\.git\/?$/, "");
  if (!url) return null;

  // git@github.com:owner/repo
  // ssh://git@github.com/owner/repo
  const scpMatch = url.match(/^(?:ssh:\/\/)?(?:[^@]+@)?[^:]+[:/]([^/]+)\/([^/]+)$/);
  if (scpMatch) {
    const org = scpMatch[1]!;
    const repo = scpMatch[2]!;
    if (org && repo) return { org, repo };
  }

  // https://github.com/owner/repo
  try {
    const u = new URL(url.includes("://") ? url : `https://${url}`);
    const parts = u.pathname.replace(/^\/+/, "").split("/");
    if (parts.length >= 2) {
      const org = parts[0]!;
      const repo = parts[1]!;
      if (org && repo) return { org, repo };
    }
  } catch {
    // ignore
  }

  return null;
}

function findGitDir(start = process.cwd()): string | null {
  let dir = start;
  for (let i = 0; i < 12; i++) {
    const gitPath = join(dir, ".git");
    if (existsSync(gitPath)) return gitPath;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function readGitRemoteOrigin(): { org: string; repo: string } | null {
  try {
    const gitDir = findGitDir();
    if (!gitDir) return null;

    // .git may be a file (worktree) pointing elsewhere
    let configPath = join(gitDir, "config");
    try {
      const stat = readFileSync(gitDir, "utf8");
      // worktree: "gitdir: /path/to/main/.git/worktrees/..."
      const m = stat.match(/gitdir:\s*(.+)/);
      if (m) {
        const mainGit = m[1]!.trim();
        const mainConfig = join(mainGit, "config");
        if (existsSync(mainConfig)) configPath = mainConfig;
      }
    } catch {
      // gitDir is a directory, normal case
    }

    if (!existsSync(configPath)) return null;
    const config = readFileSync(configPath, "utf8");

    // Very small INI parser: look for [remote "origin"] then url = ...
    const lines = config.split("\n");
    let inOrigin = false;
    for (const raw of lines) {
      const line = raw.trim();
      if (line.startsWith("[")) {
        inOrigin = /^\[remote\s+"origin"\]/.test(line);
        continue;
      }
      if (!inOrigin) continue;
      const urlMatch = line.match(/^url\s*=\s*(.+)$/);
      if (urlMatch) {
        const remoteUrl = urlMatch[1]!.trim();
        const parsed = parseGitRemoteUrl(remoteUrl);
        if (parsed) return parsed;
      }
    }
    return null;
  } catch {
    return null;
  }
}

let cachedGitRemote: { org: string; repo: string } | null | undefined;

function getCachedGitRemote(): { org: string; repo: string } | null {
  if (cachedGitRemote !== undefined) return cachedGitRemote;
  // Only attempt in non-production (dev / build) to avoid fs reads in serverless
  // unless explicitly allowed via WILDWOOD_INFER_GIT_REMOTE=1
  const allowInProd = trimEnv("WILDWOOD_INFER_GIT_REMOTE") === "1";
  const isProdRuntime = process.env.NODE_ENV === "production" && !process.env.NEXT_PHASE;
  if (isProdRuntime && !allowInProd) {
    cachedGitRemote = null;
    return null;
  }
  cachedGitRemote = readGitRemoteOrigin();
  return cachedGitRemote;
}

export function __resetGitRemoteCache(): void {
  cachedGitRemote = undefined;
}

// ---------------------------------------------------------------------------
// Public resolvers
// ---------------------------------------------------------------------------

export function resolveOrg(explicit?: string): string | undefined {
  const e = explicit?.trim();
  if (e) return e;
  return (
    trimEnv("WILDWOOD_GITHUB_ORG") ||
    trimEnv("WILDWOOD_ORG") ||
    trimEnv("GITHUB_ORG") ||
    trimEnv("WILDWOOD_GIT_ORG") ||
    getVercelSystemEnv().git.owner ||
    getCachedGitRemote()?.org ||
    undefined
  );
}

export function resolveRepo(explicit?: string): string | undefined {
  const e = explicit?.trim();
  if (e) return e;
  return (
    trimEnv("WILDWOOD_GITHUB_REPO") ||
    trimEnv("WILDWOOD_REPO") ||
    trimEnv("GITHUB_REPO") ||
    trimEnv("WILDWOOD_GIT_REPO") ||
    getVercelSystemEnv().git.slug ||
    getCachedGitRemote()?.repo ||
    undefined
  );
}

export function resolveRef(explicit?: string): string {
  const e = explicit?.trim();
  if (e) return e;

  return (
    trimEnv("WILDWOOD_DOCS_REF") ||
    trimEnv("WILDWOOD_REF") ||
    trimEnv("WILDWOOD_GIT_REF") ||
    trimEnv("WILDWOOD_BRANCH") ||
    // Vercel: prefer branch name (human-readable, works with git remote)
    // over SHA. SHA is second choice for immutable deploys.
    trimEnv("VERCEL_GIT_COMMIT_REF") ||
    trimEnv("VERCEL_GIT_COMMIT_SHA") ||
    // legacy fallback used before Vercel system envs existed
    trimEnv("GIT_REF") ||
    "main"
  );
}

export function resolveOrigin(explicit?: string): string | undefined {
  const e = explicit?.trim();
  if (e) return withHttps(e) ?? e;
  return getVercelSystemEnv().origin;
}

export function resolveVersion(explicit?: string): string {
  const e = explicit?.trim();
  if (e) return e;
  return trimEnv("WILDWOOD_VERSION") || "0";
}

export type ResolvedWildwoodIdentity = {
  org: string | undefined;
  repo: string | undefined;
  ref: string;
  origin: string | undefined;
  isVercel: boolean;
  vercel: VercelSystemEnv;
};

export function resolveIdentity(explicit?: {
  org?: string;
  repo?: string;
  ref?: string;
  origin?: string;
}): ResolvedWildwoodIdentity {
  const v = getVercelSystemEnv();
  return {
    org: resolveOrg(explicit?.org),
    repo: resolveRepo(explicit?.repo),
    ref: resolveRef(explicit?.ref),
    origin: resolveOrigin(explicit?.origin),
    isVercel: v.isVercel,
    vercel: v,
  };
}

// Convenience: throw if org/repo still missing after all fallbacks.
// Used by `defineConfig` when the user omitted both and we are not in a
// context where git remote inference can help.
export function requireOrgRepo(org: string | undefined, repo: string | undefined): { org: string; repo: string } {
  if (!org || !repo) {
    const v = getVercelSystemEnv();
    const parts: string[] = [];
    if (v.isVercel) {
      parts.push(
        "On Vercel, Wildwood auto-detects org/repo from VERCEL_GIT_REPO_OWNER and VERCEL_GIT_REPO_SLUG.",
        "Make sure System Environment Variables are enabled in your Vercel project settings (Settings → Environment Variables → Enable System Environment Variables).",
      );
    }
    parts.push(
      `Could not resolve org/repo. Explicitly pass them or set env:`,
      `  defineConfig({ org: "your-org", repo: "your-repo", ... })`,
      `or`,
      `  WILDWOOD_GITHUB_ORG / WILDWOOD_GITHUB_REPO`,
      `Received org=${JSON.stringify(org ?? "")} repo=${JSON.stringify(repo ?? "")}`,
      `Vercel detected: ${v.isVercel ? `yes (owner=${v.git.owner ?? "∅"} slug=${v.git.slug ?? "∅"} ref=${v.git.commitRef ?? v.git.commitSha ?? "∅"})` : "no"}`,
    );
    throw new Error(parts.join("\n"));
  }
  return { org, repo };
}
