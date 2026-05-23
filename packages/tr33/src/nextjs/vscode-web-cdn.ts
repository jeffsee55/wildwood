export type VscodeWebCdn = {
  commit: string;
  version: string;
  /** `https://main.vscode-cdn.net/stable/{commit}` */
  cdnBase: string;
};

let vscodeWebCdnPromise: Promise<VscodeWebCdn> | null = null;

const VSCODE_WEB_PLATFORM =
  process.env.TR33_VSCODE_WEB_PLATFORM || "server-linux-x64-web";

async function fetchLatestVersion(): Promise<string> {
  const response = await fetch(
    "https://update.code.visualstudio.com/api/releases/stable",
  );
  if (!response.ok) {
    throw new Error(`Failed to resolve VS Code version: ${response.status}`);
  }
  const versions = (await response.json()) as string[];
  if (versions.length === 0) {
    throw new Error("No stable VS Code versions returned");
  }
  return versions[0];
}

async function fetchLatestCommit(): Promise<string> {
  const response = await fetch(
    `https://update.code.visualstudio.com/api/commits/stable/${VSCODE_WEB_PLATFORM}`,
  );
  if (!response.ok) {
    throw new Error(`Failed to resolve VS Code commit: ${response.status}`);
  }
  const commits = (await response.json()) as string[];
  if (commits.length === 0) {
    throw new Error("No stable VS Code commits returned");
  }
  return commits[0];
}

/** Stable VS Code web assets on `main.vscode-cdn.net` (not bundled in serverless). */
export function resolveVscodeWebCdn(): Promise<VscodeWebCdn> {
  if (!vscodeWebCdnPromise) {
    vscodeWebCdnPromise = (async () => {
      const commitOverride = process.env.TR33_VSCODE_WEB_COMMIT?.trim();
      const versionOverride = process.env.TR33_VSCODE_WEB_VERSION?.trim();

      const commit = commitOverride || (await fetchLatestCommit());
      const version =
        versionOverride && versionOverride !== "latest"
          ? versionOverride
          : await fetchLatestVersion();

      return {
        commit,
        version,
        cdnBase: `https://main.vscode-cdn.net/stable/${commit}`,
      };
    })();
  }
  return vscodeWebCdnPromise;
}

export function vscodeCdnProxyPrefix(apiPrefix: string, commit: string): string {
  return `${apiPrefix}/cdn/${commit}`;
}
