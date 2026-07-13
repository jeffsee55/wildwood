/**
 * Explicit env resolution — no fallbacks inside wildwood.
 *
 * Wildwood no longer does `WILDWOOD_DOCS_DATABASE_URL || TURSO_DATABASE_URL || LIBSQL_URL`.
 * The host app maps its env to explicit options. Wildwood only reads Vercel
 * System Environment Variables for org/repo/origin/ref zero-config, plus optional
 * git remote inference in dev.
 *
 * Reference: https://vercel.com/docs/environment-variables/system-environment-variables
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isProdRuntime } from "@/runtime";

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
// Vercel System Env (auto-provided by Vercel, no user config needed)
// ---------------------------------------------------------------------------

export function isVercel(): boolean {
  return trimEnv("VERCEL") === "1" || Boolean(trimEnv("VERCEL_ENV"));
}

export function vercelEnv(): string | undefined {
  return trimEnv("VERCEL_ENV");
}

export type VercelSystemEnv = {
  isVercel: boolean;
  env: string | undefined;
  targetEnv: string | undefined;
  deploymentId: string | undefined;
  projectId: string | undefined;
  region: string | undefined;
  url: string | undefined;
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
  origin: string | undefined;
};

let cachedVercelEnv: VercelSystemEnv | null = null;

export function getVercelSystemEnv(): VercelSystemEnv {
  if (cachedVercelEnv) return cachedVercelEnv;

  const productionUrl = trimEnv("VERCEL_PROJECT_PRODUCTION_URL");
  const branchUrl = trimEnv("VERCEL_BRANCH_URL");
  const url = trimEnv("VERCEL_URL");

  // Origin resolution: explicit (legacy userland) wins, else Vercel auto URLs.
  // Note: for auth we now prefer autodetect from Request via better-auth, so `origin`
  // here is only for non-auth metadata (OG images, docs origin, etc) and can be omitted.
  // NEXT_PUBLIC_ORIGIN / ORIGIN are kept for back-compat but are not required.
  const explicitOrigin = trimEnv("NEXT_PUBLIC_ORIGIN") || trimEnv("ORIGIN");
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

export function __resetVercelEnvCache(): void {
  cachedVercelEnv = null;
}

// ---------------------------------------------------------------------------
// Git remote parsing (dev zero-config only)
// ---------------------------------------------------------------------------

export function parseGitRemoteUrl(remoteUrl: string): { org: string; repo: string } | null {
  const url = remoteUrl.trim().replace(/\.git\/?$/, "");
  if (!url) return null;

  const scpMatch = url.match(/^(?:ssh:\/\/)?(?:[^@]+@)?[^:]+[:/]([^/]+)\/([^/]+)$/);
  if (scpMatch) {
    const org = scpMatch[1]!;
    const repo = scpMatch[2]!;
    if (org && repo) return { org, repo };
  }

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

    let configPath = join(gitDir, "config");
    try {
      const stat = readFileSync(gitDir, "utf8");
      const m = stat.match(/gitdir:\s*(.+)/);
      if (m) {
        const mainGit = m[1]!.trim();
        const mainConfig = join(mainGit, "config");
        if (existsSync(mainConfig)) configPath = mainConfig;
      }
    } catch {}

    if (!existsSync(configPath)) return null;
    const config = readFileSync(configPath, "utf8");

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
  if (isProdRuntime()) {
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
// Public resolvers — explicit wins, then Vercel system envs, then dev git remote
// No WILDWOOD_* / GITHUB_* fallback cascade. Host maps its env explicitly.
// ---------------------------------------------------------------------------

export function resolveOrg(explicit?: string): string | undefined {
  const e = explicit?.trim();
  if (e) return e;
  return getVercelSystemEnv().git.owner ?? getCachedGitRemote()?.org ?? undefined;
}

export function resolveRepo(explicit?: string): string | undefined {
  const e = explicit?.trim();
  if (e) return e;
  return getVercelSystemEnv().git.slug ?? getCachedGitRemote()?.repo ?? undefined;
}

export function resolveRef(explicit?: string): string {
  const e = explicit?.trim();
  if (e) return e;
  const v = getVercelSystemEnv().git;
  return v.commitRef ?? v.commitSha ?? "main";
}

export function resolveOrigin(explicit?: string): string | undefined {
  const e = explicit?.trim();
  if (e) return withHttps(e) ?? e;
  return getVercelSystemEnv().origin;
}

export function resolveVersion(explicit?: string): string {
  const e = explicit?.trim();
  if (e) return e;
  return "0";
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

export function requireOrgRepo(
  org: string | undefined,
  repo: string | undefined,
): { org: string; repo: string } {
  if (!org || !repo) {
    const v = getVercelSystemEnv();
    throw new Error(
      [
        `Could not resolve org/repo.`,
        `Pass them explicitly: defineConfig({ org: "your-org", repo: "your-repo", ... })`,
        `On Vercel, Wildwood auto-detects from VERCEL_GIT_REPO_OWNER/SLUG — ensure System Env Vars are enabled.`,
        `Received org=${JSON.stringify(org ?? "")} repo=${JSON.stringify(repo ?? "")}`,
        `Vercel: ${v.isVercel ? `yes (owner=${v.git.owner ?? "∅"} slug=${v.git.slug ?? "∅"} ref=${v.git.commitRef ?? v.git.commitSha ?? "∅"})` : "no"}`,
      ].join("\n"),
    );
  }
  return { org, repo };
}
