import {
  type CommitNode,
  type Diff2Entry,
  type Gitable,
  type TreeEntries,
  Trees,
} from "tr33-store";
import * as vscode from "vscode";
import { logger } from "./extension";
import {
  notifyKitParentBranchChanged,
  notifyKitParentWorkspaceChanged,
} from "./kit-parent";

export const SCHEME = "vscode-vfs";

/** Must match `TR33_SYNC_HOST_ACTIVE_REF_HEADER` in `tr33` (`preview-cookies.ts`). */
const TR33_SYNC_HOST_ACTIVE_REF_HEADER = "x-tr33-sync-host-active-ref";

const BRANCH_CITIES = [
  "jakarta", "istanbul", "cairo", "mumbai", "tokyo", "seoul", "lima",
  "nairobi", "havana", "bogota", "tehran", "delhi", "dhaka", "hanoi",
  "riyadh", "ankara", "kabul", "quito", "dakar", "lusaka", "maputo",
  "tbilisi", "baku", "minsk", "tallinn", "riga", "vilnius", "oslo",
  "reykjavik", "helsinki", "dublin", "lisbon", "prague", "vienna",
  "budapest", "bucharest", "sofia", "tirana", "skopje", "belgrade",
] as const;

export function generateBranchName(): string {
  const city = BRANCH_CITIES[Math.floor(Math.random() * BRANCH_CITIES.length)];
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${city}-${suffix}`;
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export type ScmState = {
  commitTreeOid: string;
  configRefTreeOid: string | null;
  mergeBaseTreeOid: string | null;
  workingChanges: Diff2Entry[];
  configRefChanges: Diff2Entry[];
  conflicts: { path: string; message: string }[];
};

export class Tr33FileSystemProvider
  implements vscode.FileSystemProvider, Gitable
{
  private _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this._emitter.event;

  private repo: string;
  private configRef: string;
  private currentRef: string;
  private apiUrl: string;
  private rootTreeOid: string | null = null;
  private commitTreeOid: string | null = null;

  private _onDidChangeScm = new vscode.EventEmitter<void>();
  readonly onDidChangeScm = this._onDidChangeScm.event;
  private _onDidCreateBranch = new vscode.EventEmitter<string>();
  readonly onDidCreateBranch = this._onDidCreateBranch.event;
  private _switchRefQueue: Promise<void> = Promise.resolve();

  paths: string[] = [];
  trees: Trees;

  private _conflictPaths = new Set<string>();

  constructor(extensionUri: vscode.Uri) {
    const tr33Config = vscode.workspace.getConfiguration("tr33");
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
    if (!repo) {
      const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
      const workspaceQuery = workspaceUri?.query;
      if (workspaceQuery) {
        const query = new URLSearchParams(workspaceQuery);
        const queryRepo = query.get("repo");
        const queryRef = query.get("ref");
        if (queryRepo) {
          repo = queryRepo;
        }
        if (queryRef) {
          initialRef = queryRef;
        }
      }
    }
    if (!repo) {
      repo = tr33Config.get<string>("repo");
    }
    if (!repo) {
      const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
      const pathParts = workspaceUri?.path.split("/").filter(Boolean) ?? [];
      if (pathParts.length >= 2) {
        repo = pathParts.join("/");
      } else if (pathParts.length === 1) {
        repo = pathParts[0];
      }
    }
    if (!initialRef) {
      initialRef = tr33Config.get<string>("headRef");
    }
    const workspaceQuery = vscode.workspace.workspaceFolders?.[0]?.uri?.query;
    const extensionParams = extensionUri.query
      ? new URLSearchParams(extensionUri.query)
      : null;
    const queryConfigRef =
      (workspaceQuery
        ? new URLSearchParams(workspaceQuery).get("baseRef")
        : undefined) ??
      extensionParams?.get("baseRef") ??
      undefined;
    const configRef =
      queryConfigRef ??
      tr33Config.get<string>("baseRef") ??
      tr33Config.get<string>("ref", "main");
    const currentRef = initialRef ?? configRef;
    if (!repo || !configRef || !currentRef) {
      throw new Error(
        "Invalid extension context: cannot resolve repo/configRef/currentRef",
      );
    }
    /*
     * GitHub owner/repo are case-insensitive; workspace folder paths are not always
     * canonical (e.g. macOS renames that only change casing). Normalizing keeps
     * vscode-vfs URIs aligned with the repo id used by the git API and configuration.
     */
    this.repo = repo.toLowerCase();
    this.configRef = configRef;
    this.currentRef = currentRef;
    const base = vscode.Uri.parse(
      `${extensionUri.scheme}://${extensionUri.authority}`,
    );
    this.apiUrl = vscode.Uri.joinPath(base, "api", "git").toString();
    this.trees = new Trees({ gitable: this });
    logger("Tr33FileSystemProvider", {
      repo: this.repo,
      configRef,
      currentRef,
      apiUrl: this.apiUrl,
    });
  }

  // ── Gitable (raw data source — Trees caches on top) ────────────────

  async getTree(oid: string): Promise<TreeEntries | null> {
    const url = `${this.apiUrl}/tree/${oid}`;
    try {
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) {
        logger(
          "getTree HTTP error",
          res.status,
          url,
          await res.text().catch(() => ""),
        );
        return null;
      }
      return (await res.json()) as TreeEntries;
    } catch (e) {
      logger("getTree fetch failed", url, e);
      return null;
    }
  }

  async getBlob(oid: string): Promise<{ oid: string; content: string } | null> {
    const url = `${this.apiUrl}/blob/${oid}`;
    try {
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) {
        logger("getBlob HTTP error", res.status, url);
        return null;
      }
      const data = (await res.json()) as { content: string };
      return { oid, content: data.content };
    } catch (e) {
      logger("getBlob fetch failed", url, e);
      return null;
    }
  }

  async getCommit(oid: string): Promise<CommitNode | null> {
    try {
      const res = await fetch(`${this.apiUrl}/commit/${oid}`);
      if (!res.ok) return null;
      return (await res.json()) as CommitNode;
    } catch {
      return null;
    }
  }

  // ── Ref management ──────────────────────────────────────────────────

  getCurrentRef(): string {
    return this.currentRef;
  }

  getConfigRef(): string {
    return this.configRef;
  }

  /** Owner/repo identifier for GitHub URLs (e.g. "facebook/react"). */
  getRepo(): string {
    return this.repo;
  }

  getRootUri(): vscode.Uri {
    return vscode.Uri.parse(`${SCHEME}:/${this.repo}/`);
  }

  async switchRef(
    newRef: string,
    options?: { notifyParent?: boolean },
  ): Promise<void> {
    const notifyParent = options?.notifyParent !== false;
    this._switchRefQueue = this._switchRefQueue
      .catch(() => {})
      .then(() => this.switchRefInternal(newRef, notifyParent));
    return this._switchRefQueue;
  }

  private async switchRefInternal(
    newRef: string,
    notifyParent = true,
  ): Promise<void> {
    if (newRef === this.currentRef) return;
    if (!this.rootTreeOid || !this.commitTreeOid) {
      try {
        await this.fetchWorktreeState();
      } catch {
        // Best effort: still allow switching refs even if prior state wasn't loaded.
      }
    }
    const previousRootTreeOid = this.rootTreeOid;
    this.currentRef = newRef;
    this.rootTreeOid = null;
    this.commitTreeOid = null;
    await this.fetchWorktreeState({
      syncHostActiveRef: notifyParent,
    });
    const nextRootTreeOid = this.rootTreeOid;

    const rootUri = this.getRootUri();
    const eventsMap = new Map<string, vscode.FileChangeEvent>();
    const eventPriority: Record<number, number> = {
      [vscode.FileChangeType.Changed]: 1,
      [vscode.FileChangeType.Created]: 2,
      [vscode.FileChangeType.Deleted]: 2,
    };
    const markEvent = (uri: vscode.Uri, type: vscode.FileChangeType) => {
      const key = uri.toString();
      const existing = eventsMap.get(key);
      if (existing && eventPriority[existing.type] >= eventPriority[type]) {
        return;
      }
      eventsMap.set(key, { type, uri });
    };
    markEvent(rootUri, vscode.FileChangeType.Changed);
    markEvent(
      vscode.Uri.parse(`${SCHEME}:/${this.repo}`),
      vscode.FileChangeType.Changed,
    );

    if (
      previousRootTreeOid &&
      nextRootTreeOid &&
      previousRootTreeOid !== nextRootTreeOid
    ) {
      const diff = await this.trees.diff2({
        baseTreeOid: previousRootTreeOid,
        currentTreeOid: nextRootTreeOid,
      });
      for (const entry of diff) {
        const segments = entry.path.split("/").filter(Boolean);
        if (segments.length === 0) continue;
        const entryType =
          entry.status === "added"
            ? vscode.FileChangeType.Created
            : entry.status === "removed"
              ? vscode.FileChangeType.Deleted
              : vscode.FileChangeType.Changed;
        markEvent(vscode.Uri.joinPath(rootUri, ...segments), entryType);
        for (let i = 1; i < segments.length; i++) {
          markEvent(
            vscode.Uri.joinPath(rootUri, ...segments.slice(0, i)),
            vscode.FileChangeType.Changed,
          );
        }
      }
    }

    const prefix = `/${this.repo}`;
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme === SCHEME && doc.uri.path.startsWith(prefix)) {
        markEvent(doc.uri, vscode.FileChangeType.Changed);
      }
    }
    this._emitter.fire(Array.from(eventsMap.values()));
    this._onDidChangeScm.fire();
    if (notifyParent) {
      logger("switchRef → notifyKitParentBranchChanged", this.currentRef);
      notifyKitParentBranchChanged(this.currentRef);
    } else {
      logger("switchRef (notifyParent=false)", this.currentRef);
    }
  }

  async fetchBranches(): Promise<string[]> {
    const res = await fetch(`${this.apiUrl}/branches`);
    if (!res.ok) throw new Error(`Failed to fetch branches: ${res.status}`);
    const data = (await res.json()) as { branches: string[] };
    return data.branches ?? [];
  }

  getApiUrl(): string {
    return this.apiUrl;
  }

  async lookupBlobOid(uri: vscode.Uri): Promise<string | null> {
    const filePath = this.pathFromUri(uri);
    const rootOid = await this.getRootTreeOid();
    const entry = await this.trees.lookup(rootOid, filePath);
    if (entry?.type === "blob") return entry.oid;
    if (this.commitTreeOid && this.commitTreeOid !== rootOid) {
      const fallback = await this.trees.lookup(this.commitTreeOid, filePath);
      if (fallback?.type === "blob") return fallback.oid;
    }
    return null;
  }

  private async lookupBlobOidFromTree(
    treeOid: string,
    uri: vscode.Uri,
  ): Promise<string | null> {
    const filePath = this.pathFromUri(uri);
    const entry = await this.trees.lookup(treeOid, filePath);
    return entry?.type === "blob" ? entry.oid : null;
  }

  // ── SCM helpers ────────────────────────────────────────────────────

  getTreeUri(uri: vscode.Uri, treeOid: string): vscode.Uri {
    return uri.with({ query: `oid=${treeOid}` });
  }

  getCommitTreeOid(): string | null {
    return this.commitTreeOid;
  }

  async fetchScmState(): Promise<ScmState> {
    const [currentData, configData] = await Promise.all([
      this.fetchRefData(this.currentRef),
      this.currentRef !== this.configRef
        ? this.fetchRefData(this.configRef)
        : null,
    ]);

    this.commitTreeOid = currentData.commit.treeOid;
    this.rootTreeOid = currentData.rootTreeOid ?? currentData.commit.treeOid;

    const workingChanges =
      this.rootTreeOid !== this.commitTreeOid
        ? await this.trees.diff2({
            baseTreeOid: this.commitTreeOid,
            currentTreeOid: this.rootTreeOid,
          })
        : [];

    if (!configData) {
      return {
        commitTreeOid: this.commitTreeOid,
        configRefTreeOid: null,
        mergeBaseTreeOid: null,
        workingChanges,
        configRefChanges: [],
        conflicts: [],
      };
    }

    const configRefTreeOid = configData.commit.treeOid;

    const configRefChanges =
      configRefTreeOid !== this.commitTreeOid
        ? await this.trees.diff2({
            baseTreeOid: configRefTreeOid,
            currentTreeOid: this.commitTreeOid,
          })
        : [];

    let mergeBaseTreeOid: string | null = null;
    if (currentData.commit.oid === configData.commit.oid) {
      mergeBaseTreeOid = this.commitTreeOid;
    } else {
      mergeBaseTreeOid = await this.fetchMergeBase(
        this.currentRef,
        this.configRef,
      );
    }

    const conflicts = mergeBaseTreeOid
      ? (
          await this.trees.diffTrees({
            baseTreeOid: mergeBaseTreeOid,
            oursTreeOid: this.commitTreeOid,
            theirsTreeOid: configRefTreeOid,
          })
        ).conflicts.map((c) => ({ path: c.path, message: c.message }))
      : [];

    return {
      commitTreeOid: this.commitTreeOid,
      configRefTreeOid,
      mergeBaseTreeOid,
      workingChanges,
      configRefChanges,
      conflicts,
    };
  }

  /** Call after merging into configRef so branch diff is refetched. */
  invalidateConfigRefState(): void {
    this._onDidChangeScm.fire();
  }

  setConflictPaths(paths: string[]): void {
    this._conflictPaths = new Set(paths);
  }

  // ── Mutations ─────────────────────────────────────────────────────

  async createBranch(name: string, base: string): Promise<void> {
    const res = await fetch(`${this.apiUrl}/create-branch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, base }),
      credentials: "include",
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to create branch: ${res.status}: ${err}`);
    }
  }

  async commit(
    message: string,
    author: { name: string; email: string },
  ): Promise<void> {
    const res = await fetch(`${this.apiUrl}/commit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ref: this.currentRef,
        message,
        author,
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to commit: ${res.status}: ${err}`);
    }

    this.rootTreeOid = null;
    this.commitTreeOid = null;
    await this.fetchWorktreeState();
    this._onDidChangeScm.fire();
    notifyKitParentWorkspaceChanged();
  }

  async discard(): Promise<void> {
    const res = await fetch(`${this.apiUrl}/discard`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: this.currentRef }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to discard: ${res.status}: ${err}`);
    }

    this.rootTreeOid = this.commitTreeOid;
    this.trees.treeStore.clear();
    this._onDidChangeScm.fire();
    notifyKitParentWorkspaceChanged();
  }

  async push(): Promise<void> {
    const res = await fetch(`${this.apiUrl}/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: this.currentRef }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to push: ${res.status}: ${err}`);
    }
  }

  async mergeToConfigRef(message?: string): Promise<void> {
    const res = await fetch(`${this.apiUrl}/merge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ref: this.currentRef,
        baseRef: this.getConfigRef(),
        ...(message != null && message.trim() !== "" && { message: message.trim() }),
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to merge: ${res.status}: ${err}`);
    }
    this._onDidChangeScm.fire();
    notifyKitParentWorkspaceChanged();
  }

  async createPrToConfigRef(prMessage?: string): Promise<{ number: number; url: string }> {
    const trimmed = prMessage?.trim();
    const body = trimmed || undefined;
    const firstLine = trimmed?.split(/\n/)[0];
    const MAX_TITLE_LENGTH = 128;
    const title = firstLine
      ? firstLine.length > MAX_TITLE_LENGTH
        ? `${firstLine.slice(0, MAX_TITLE_LENGTH)}…`
        : firstLine
      : undefined;
    const res = await fetch(`${this.apiUrl}/create-pr`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ref: this.currentRef,
        ...(title != null && { title }),
        ...(body != null && { body }),
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to create PR: ${res.status}: ${err}`);
    }
    const result = (await res.json()) as { pr: { number: number; url: string } };
    return result.pr;
  }

  async findPrToConfigRef(): Promise<{ number: number; url: string } | null> {
    const encodedRef = encodeURIComponent(this.currentRef);
    const res = await fetch(`${this.apiUrl}/pr/${encodedRef}`);
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to find PR: ${res.status}: ${err}`);
    }
    const result = (await res.json()) as {
      pr: { number: number; url: string } | null;
    };
    return result.pr;
  }

  /** Fetch from remote and merge into current branch. */
  async pullFromRemote(): Promise<void> {
    const res = await fetch(`${this.apiUrl}/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: this.currentRef }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to pull: ${res.status}: ${err}`);
    }
    this.rootTreeOid = null;
    this.commitTreeOid = null;
    await this.fetchWorktreeState();
    this._onDidChangeScm.fire();
    notifyKitParentWorkspaceChanged();
  }

  // ── Internal helpers ────────────────────────────────────────────────

  private async fetchRefData(
    ref: string,
    options?: { syncHostActiveRef?: boolean },
  ): Promise<{
    commit: { oid: string; treeOid: string };
    rootTreeOid: string | null;
  }> {
    const headers: Record<string, string> = {};
    if (options?.syncHostActiveRef) {
      headers[TR33_SYNC_HOST_ACTIVE_REF_HEADER] = "1";
    }
    const url = `${this.apiUrl}/worktrees/${encodeURIComponent(ref)}`;
    logger(
      "GET worktrees",
      { ref, syncHost: Boolean(options?.syncHostActiveRef), url },
    );
    const res = await fetch(url, { credentials: "include", headers });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger("GET worktrees failed", res.status, body.slice(0, 500));
      throw new Error(`Failed to fetch worktree: ${res.status}`);
    }
    const data = (await res.json()) as {
      commit: { oid: string; treeOid: string };
      rootTreeOid: string | null;
    };
    logger("GET worktrees ok", {
      ref,
      commitTreeOid: data.commit.treeOid.slice(0, 7),
      rootTreeOid: data.rootTreeOid?.slice(0, 7) ?? null,
    });
    return data;
  }

  private async fetchMergeBase(
    ours: string,
    theirs: string,
  ): Promise<string | null> {
    try {
      const res = await fetch(
        `${this.apiUrl}/merge-base/${encodeURIComponent(ours)}/${encodeURIComponent(theirs)}`,
        { credentials: "include" },
      );
      if (!res.ok) return null;
      const data = (await res.json()) as {
        oid: string | null;
        treeOid: string | null;
      };
      return data.treeOid ?? null;
    } catch {
      return null;
    }
  }

  private async fetchWorktreeState(options?: {
    syncHostActiveRef?: boolean;
  }): Promise<void> {
    const data = await this.fetchRefData(this.currentRef, options);
    this.commitTreeOid = data.commit.treeOid;
    this.rootTreeOid = data.rootTreeOid ?? data.commit.treeOid;
  }

  private async getRootTreeOid(): Promise<string> {
    if (this.rootTreeOid) return this.rootTreeOid;
    await this.fetchWorktreeState();
    if (!this.rootTreeOid) {
      throw new Error("Failed to resolve root tree OID");
    }
    return this.rootTreeOid;
  }

  private pathFromUri(uri: vscode.Uri): string {
    const prefix = `/${this.repo}`;
    const p = uri.path;
    if (p === prefix || p === `${prefix}/`) return "";
    if (p.startsWith(`${prefix}/`)) return p.slice(prefix.length + 1);
    return p.startsWith("/") ? p.slice(1) : p;
  }

  /** Virtual .git directory for GitHub PR extension repo discovery. */
  private getVirtualGitPath(filePath: string): "dir" | "config" | null {
    if (filePath === ".git" || filePath === ".git/") return "dir";
    if (filePath === ".git/config") return "config";
    return null;
  }

  private getVirtualGitConfigContent(): string {
    const url = `https://github.com/${this.repo}.git`;
    return `[core]
	repositoryformatversion = 0
	filemode = true
	bare = false
	logallrefupdates = true
[remote "origin"]
	url = ${url}
	fetch = +refs/heads/*:refs/remotes/origin/*
[branch "${this.configRef}"]
	remote = origin
	merge = refs/heads/${this.configRef}
`;
  }

  private async resolve(uri: vscode.Uri) {
    const filePath = this.pathFromUri(uri);
    const rootOid = await this.getRootTreeOid();
    const rootEntry = await this.trees.resolve(rootOid, filePath);
    if (rootEntry) {
      return rootEntry;
    }

    // Some worktree roots can be sparse (only changed paths). If a path is
    // absent there, fall back to the committed tree for stable reads/saves.
    if (!this.commitTreeOid) {
      await this.fetchWorktreeState();
    }
    if (this.commitTreeOid && this.commitTreeOid !== rootOid) {
      return this.trees.resolve(this.commitTreeOid, filePath);
    }
    return null;
  }

  // ── FileSystemProvider ──────────────────────────────────────────────

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => {});
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const filePath = this.pathFromUri(uri);
    const virtualGit = this.getVirtualGitPath(filePath);
    if (virtualGit) {
      return {
        type:
          virtualGit === "dir"
            ? vscode.FileType.Directory
            : vscode.FileType.File,
        ctime: 0,
        mtime: 0,
        size: virtualGit === "config" ? this.getVirtualGitConfigContent().length : 0,
      };
    }
    const oid = new URLSearchParams(uri.query).get("oid");
    const treeOid = oid ?? (await this.getRootTreeOid());
    const entry = await this.trees.lookup(treeOid, filePath);
    if (!entry) {
      if (!oid && this.commitTreeOid && this.commitTreeOid !== treeOid) {
        const fallback = await this.trees.lookup(
          this.commitTreeOid,
          filePath,
        );
        if (fallback) {
          return {
            type:
              fallback.type === "tree"
                ? vscode.FileType.Directory
                : vscode.FileType.File,
            ctime: 0,
            mtime: 0,
            size: 0,
          };
        }
      }
      throw vscode.FileSystemError.FileNotFound(uri);
    }

    return {
      type:
        entry.type === "tree"
          ? vscode.FileType.Directory
          : vscode.FileType.File,
      ctime: 0,
      mtime: 0,
      size: 0,
    };
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const filePath = this.pathFromUri(uri);
    if (filePath === "" || filePath === ".") {
      const entry = await this.resolve(uri);
      if (entry?.type === "tree") {
        const entries = Object.entries(entry.entries).map(([name, child]) => [
          name,
          child.type === "tree" ? vscode.FileType.Directory : vscode.FileType.File,
        ]) as [string, vscode.FileType][];
        if (!entries.some(([name]) => name === ".git")) {
          entries.push([".git", vscode.FileType.Directory]);
        }
        return entries;
      }
    }
    if (filePath === ".git") {
      return [["config", vscode.FileType.File]];
    }
    const entry = await this.resolve(uri);
    if (!entry || entry.type !== "tree") return [];

    return Object.entries(entry.entries).map(([name, child]) => [
      name,
      child.type === "tree" ? vscode.FileType.Directory : vscode.FileType.File,
    ]);
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const filePath = this.pathFromUri(uri);
    if (filePath === ".git/config") {
      return new TextEncoder().encode(this.getVirtualGitConfigContent());
    }
    const oid = new URLSearchParams(uri.query).get("oid");
    const blobOid = oid
      ? await this.lookupBlobOidFromTree(oid, uri)
      : await this.lookupBlobOid(uri);
    if (!blobOid) throw vscode.FileSystemError.FileNotFound(uri);
    const res = await fetch(`${this.apiUrl}/blob/${blobOid}/raw`);
    if (!res.ok) throw vscode.FileSystemError.FileNotFound(uri);
    return new Uint8Array(await res.arrayBuffer());
  }

  async writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    _options: { create: boolean; overwrite: boolean },
  ): Promise<void> {
    if (new URLSearchParams(uri.query).get("oid")) {
      throw vscode.FileSystemError.NoPermissions(uri);
    }

    if (this.currentRef === this.configRef) {
      const newBranch = generateBranchName();
      await this.createBranch(newBranch, this.configRef);
      await this.switchRef(newBranch);
      this._onDidCreateBranch.fire(newBranch);
    }

    const path = this.pathFromUri(uri);
    const isBinary = content.includes(0x00);
    const filePayload: string | { base64: string } = isBinary
      ? { base64: uint8ToBase64(content) }
      : new TextDecoder().decode(content);

    if (!isBinary && this._conflictPaths.has(path)) {
      const current = await this.resolve(uri);
      if (
        current?.type === "blob" &&
        current.content === (filePayload as string)
      ) {
        return;
      }
    }

    const res = await fetch(`${this.apiUrl}/add`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ref: this.currentRef,
        files: { [path]: filePayload },
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to write: ${res.status}: ${err}`);
    }
    this._conflictPaths.delete(path);
    this.rootTreeOid = null;
    await this.fetchWorktreeState();

    this._onDidChangeScm.fire();
    notifyKitParentWorkspaceChanged();
  }

  async delete(uri: vscode.Uri): Promise<void> {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  async rename(oldUri: vscode.Uri, _newUri: vscode.Uri): Promise<void> {
    throw vscode.FileSystemError.NoPermissions(oldUri);
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    throw vscode.FileSystemError.NoPermissions(uri);
  }
}
