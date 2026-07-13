/** Playground-only: repo + collection shape; separate from wildwood's preview/ref cookies. */
export const PLAYGROUND_CONFIG_COOKIE = "wildwood_playground_v1";
/** @deprecated use PLAYGROUND_CONFIG_COOKIE */
export const LEGACY_PLAYGROUND_CONFIG_COOKIE = "tr33_playground_v1";

export type PlaygroundSource = "github" | "local";

export type PlaygroundConfig = {
  /** `github` = GitHub API for org/repo. `local` = `git` + DB in a directory on disk (org/repo are namespace only). */
  source: PlaygroundSource;
  org: string;
  repo: string;
  ref: string;
  /** Used when `source === "local"` — path to a git worktree (relative to the Next server cwd or absolute). */
  localPath: string;
  match: string;
  contentType: "md" | "json";
};

export const defaultPlaygroundConfig: PlaygroundConfig = {
  source: "github",
  org: "jeffsee55",
  repo: "wildwood-mono",
  ref: "main",
  localPath: "",
  match: "content/docs/**/*.md",
  contentType: "md",
};

function isPlaygroundConfigPayload(value: unknown): value is Record<string, unknown> {
  if (value == null || typeof value !== "object") {
    return false;
  }
  const o = value as Record<string, unknown>;
  const source = o.source;
  if (source != null && source !== "github" && source !== "local") {
    return false;
  }
  return (
    typeof o.org === "string" &&
    o.org.length > 0 &&
    typeof o.repo === "string" &&
    o.repo.length > 0 &&
    typeof o.ref === "string" &&
    o.ref.length > 0 &&
    typeof o.match === "string" &&
    o.match.length > 0 &&
    (o.contentType === "md" || o.contentType === "json")
  );
}

function normalizeToPlaygroundConfig(o: Record<string, unknown>): PlaygroundConfig {
  const contentType = o.contentType === "json" ? "json" : "md";
  const org = o.org as string;
  const repo = o.repo as string;
  const match = o.match as string;
  let ref = o.ref as string;
  // migrate legacy repo name
  const normalizedRepo = repo === "tr33-mono" || repo === "tr33" ? "wildwood-mono" : repo;
  if (o.source === "github" || o.source === "local") {
    return {
      source: o.source,
      org,
      repo: normalizedRepo,
      ref,
      localPath: typeof o.localPath === "string" ? o.localPath : "",
      match,
      contentType,
    };
  }
  // Older cookies had no `source` but the server used localPath "." (native remote) for everyone.
  return {
    source: "local",
    org,
    repo: normalizedRepo,
    ref,
    localPath: ".",
    match,
    contentType,
  };
}

function parseValue(raw: string | undefined): PlaygroundConfig {
  if (raw == null || raw === "") {
    return defaultPlaygroundConfig;
  }
  try {
    const decoded = decodeURIComponent(raw);
    const parsed: unknown = JSON.parse(decoded);
    if (isPlaygroundConfigPayload(parsed)) {
      return normalizeToPlaygroundConfig(parsed);
    }
  } catch {
    // ignore
  }
  return defaultPlaygroundConfig;
}

export function parsePlaygroundConfig(cookies: {
  get(name: string): { value: string } | undefined;
}): PlaygroundConfig {
  // Try new cookie first, fall back to legacy
  const v =
    cookies.get(PLAYGROUND_CONFIG_COOKIE)?.value ??
    cookies.get(LEGACY_PLAYGROUND_CONFIG_COOKIE)?.value;
  return parseValue(v);
}

export function serializePlaygroundConfig(config: PlaygroundConfig): string {
  return encodeURIComponent(JSON.stringify(config));
}

export function stablePlaygroundTag(config: PlaygroundConfig): string {
  return [
    config.source,
    config.org,
    config.repo,
    config.ref,
    config.localPath,
    config.match,
    config.contentType,
  ].join("\x1e");
}
