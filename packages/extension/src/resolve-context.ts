import * as vscode from "vscode";
import { readActiveRefFromStorage } from "./host-bridge";
import { logger } from "./extension";

export type WildwoodExtensionContext = {
  repo: string;
  configRef: string;
  currentRef: string;
  /** Origin for Wildwood git API routes, e.g. `https://docs.example.com`. */
  apiBase: string;
};

/** HTTPS origin for `/api/git` — use workspace host, not `vscode-vfs:` / extension path. */
export function resolveWildwoodApiBase(extensionUri: vscode.Uri): string {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (folder?.authority) {
    return `https://${folder.authority}`;
  }
  if (extensionUri.scheme === "https" || extensionUri.scheme === "http") {
    return `${extensionUri.scheme}://${extensionUri.authority}`;
  }
  return `https://${extensionUri.authority}`;
}

export function resolveWildwoodExtensionContext(
  extensionUri: vscode.Uri,
): WildwoodExtensionContext {
  // Try new config first, fall back to legacy tr33 config
  const wildwoodConfig = vscode.workspace.getConfiguration("wildwood");
  const legacyConfig = vscode.workspace.getConfiguration("tr33");
  const getConfig = (key: string, fallback?: string) => {
    const v = wildwoodConfig.get<string>(key);
    if (v != null && v !== "") return v;
    const lv = legacyConfig.get<string>(key);
    if (lv != null && lv !== "") return lv;
    return fallback;
  };

  let repo: string | undefined;
  let initialRef: string | undefined;

  if (extensionUri.query) {
    try {
      const parsed = JSON.parse(extensionUri.query) as {
        repo?: string;
        ref?: string;
      };
      repo = parsed.repo;
      initialRef = parsed.ref;
    } catch {
      const params = new URLSearchParams(extensionUri.query);
      repo = params.get("repo") ?? undefined;
      initialRef = params.get("ref") ?? undefined;
    }
  }

  const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
  const workspaceQuery = workspaceUri?.query;
  if (!repo && workspaceQuery) {
    const query = new URLSearchParams(workspaceQuery);
    repo = query.get("repo") ?? undefined;
    initialRef = initialRef ?? query.get("ref") ?? undefined;
  }

  if (!repo) {
    repo = getConfig("repo");
  }

  if (!repo && workspaceUri) {
    const pathParts = workspaceUri.path.split("/").filter(Boolean);
    if (pathParts.length >= 2) {
      repo = pathParts.join("/");
    } else if (pathParts.length === 1) {
      repo = pathParts[0];
    }
  }

  if (!initialRef) {
    initialRef = readActiveRefFromStorage();
  }

  if (!initialRef) {
    initialRef = getConfig("headRef");
  }

  const extensionParams = extensionUri.query ? new URLSearchParams(extensionUri.query) : null;
  const queryConfigRef =
    (workspaceQuery ? new URLSearchParams(workspaceQuery).get("baseRef") : undefined) ??
    extensionParams?.get("baseRef") ??
    undefined;
  const configRef = queryConfigRef ?? getConfig("baseRef") ?? getConfig("ref", "main");
  const currentRef = initialRef ?? configRef;

  if (!repo || !configRef || !currentRef) {
    throw new Error(
      `Wildwood: cannot resolve workspace context (repo=${repo ?? "missing"}, baseRef=${configRef ?? "missing"}, headRef=${currentRef ?? "missing"}). extensionUri=${extensionUri.toString()}, workspace=${workspaceUri?.toString() ?? "none"}`,
    );
  }

  return {
    repo: repo.toLowerCase(),
    configRef,
    currentRef,
    apiBase: resolveWildwoodApiBase(extensionUri),
  };
}

/** Workbench may open the folder before `configurationDefaults` / workspace folders are visible. */
export async function whenWildwoodExtensionContextReady(
  extensionUri: vscode.Uri,
  options?: { maxWaitMs?: number },
): Promise<WildwoodExtensionContext> {
  const maxWaitMs = options?.maxWaitMs ?? 10_000;
  const deadline = Date.now() + maxWaitMs;
  let lastError: Error | undefined;

  while (Date.now() < deadline) {
    try {
      const ctx = resolveWildwoodExtensionContext(extensionUri);
      logger("Resolved wildwood context", ctx);
      return ctx;
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  throw lastError ?? new Error("Wildwood: timed out waiting for workspace context");
}
