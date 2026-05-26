import {
  type CommitNode,
  type Diff2Entry,
  type Gitable,
  type TreeEntries,
  Trees,
  calculateBlobOid,
  calculateBlobOidFromBytes,
} from "tr33-store";
import * as vscode from "vscode";
import { logger } from "./extension";
import {
  notifyKitParentBranchChanged,
  notifyKitParentWorkspaceChanged,
} from "./kit-parent";
import { postAddWithProgress } from "./add-with-progress";
import { postPatchWorktree, treesForPatch } from "./patch-worktree";
import {
  type Tr33ExtensionContext,
  resolveTr33ExtensionContext,
} from "./resolve-context";

/** Distinct from VS Code's built-in `vscode-vfs` (Remote Repositories). */
export const SCHEME = "tr33-vfs";


async function postSwitchBranch(
  apiUrl: string,
  ref: string,
): Promise<void> {
  const res = await fetch(`${apiUrl}/switch-branch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ref }),
    credentials: "include",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Failed to switch branch to ${ref}: ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
    );
  }
}

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
  private apiBase: string;
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

  constructor(
    extensionUri: vscode.Uri,
    resolved?: Tr33ExtensionContext,
  ) {
    const ctx = resolved ?? resolveTr33ExtensionContext(extensionUri);
    this.repo = ctx.repo;
    this.configRef = ctx.configRef;
    this.currentRef = ctx.currentRef;
    this.apiBase = ctx.apiBase;
    this.apiUrl = `${ctx.apiBase}/api/git`;
    this.trees = new Trees({ gitable: this });
    logger("Tr33FileSystemProvider", {
      repo: this.repo,
      configRef: ctx.configRef,
      currentRef: ctx.currentRef,
      apiUrl: this.apiUrl,
    });
  }

  // ── Gitable (raw data source — Trees caches on top) ────────────────

  async getTree(oid: string): Promise<TreeEntries | null> {
    const url = `${this.apiUrl}/tree/${encodeURIComponent(String(oid))}`;
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
      const tree = (await res.json()) as TreeEntries;
      logger("getTree ok", {
        oid: oid.slice(0, 7),
        entryCount: Object.keys(tree).length,
      });
      return tree;
    } catch (e) {
      logger("getTree fetch failed", url, e);
      return null;
    }
  }

  async getBlob(oid: string): Promise<{ oid: string; content: string } | null> {
    const url = `${this.apiUrl}/blob/${encodeURIComponent(String(oid))}`;
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
    const host = new URL(this.apiBase).host;
    return vscode.Uri.parse(`${SCHEME}://${host}/`);
  }

  /** Load worktree + root tree before the workbench lists the workspace folder. */
  async initializeWorkspace(): Promise<void> {
    logger("initializeWorkspace: loading worktree and root tree");
    await this.fetchWorktreeState();
    const rootOid = await this.getRootTreeOid();
    const tree = await this.trees.getTree(rootOid);
    logger("initializeWorkspace", {
      ref: this.currentRef,
      rootOid: rootOid.slice(0, 7),
      entryCount: tree ? Object.keys(tree).length : 0,
    });
  }

  /** Align the workbench folder with the provider root (`tr33-vfs://host/`). */
  async bindWorkspaceFolder(): Promise<void> {
    const root = this.getRootUri();
    const name = this.repo.split("/").pop() ?? this.repo;
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) {
      const ok = await vscode.workspace.updateWorkspaceFolders(0, 0, {
        uri: root,
        name,
      });
      logger("bindWorkspaceFolder: added", { ok, uri: root.toString() });
      return;
    }
    const first = folders[0].uri;
    if (first.toString() !== root.toString()) {
      const ok = await vscode.workspace.updateWorkspaceFolders(0, 1, {
        uri: root,
        name,
      });
      logger("bindWorkspaceFolder: replaced", {
        ok,
        from: first.toString(),
        to: root.toString(),
      });
      return;
    }
    logger("bindWorkspaceFolder: already bound", root.toString());
  }

  async probeWorkspaceListing(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      logger("probe: no workspace folder");
      return;
    }
    try {
      const entries = await vscode.workspace.fs.readDirectory(folder.uri);
      logger("probe readDirectory", {
        uri: folder.uri.toString(),
        entryCount: entries.length,
        sample: entries.slice(0, 6).map(([name]) => name),
      });
    } catch (e) {
      logger("probe readDirectory failed", folder.uri.toString(), e);
    }
  }

  /** Re-list explorer after `registerFileSystemProvider` (early events are ignored). */
  refreshExplorer(): void {
    const events: vscode.FileChangeEvent[] = [];
    const seen = new Set<string>();
    const push = (uri: vscode.Uri) => {
      const key = uri.toString();
      if (seen.has(key)) return;
      seen.add(key);
      events.push({ type: vscode.FileChangeType.Changed, uri });
    };
    push(this.getRootUri());
    const root = this.getRootUri();
    const withoutTrailing = root.path.replace(/\/+$/, "");
    if (withoutTrailing !== root.path) {
      push(root.with({ path: withoutTrailing }));
    }
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (folder.uri.scheme === SCHEME) {
        push(folder.uri);
      }
    }
    if (events.length > 0) {
      this._emitter.fire(events);
    }
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
    if (notifyParent) {
      await postSwitchBranch(this.apiUrl, newRef);
    }
    await this.fetchWorktreeState();
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

    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme === SCHEME) {
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

  private async fetchRefData(ref: string): Promise<{
    commit: { oid: string; treeOid: string };
    rootTreeOid: string | null;
  }> {
    const url = `${this.apiUrl}/worktrees/${encodeURIComponent(ref)}`;
    logger("GET worktrees", { ref, url });
    const res = await fetch(url, { credentials: "include" });
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

  private async fetchWorktreeState(): Promise<void> {
    const data = await this.fetchRefData(this.currentRef);
    const nextCommitOid = data.commit.treeOid;
    const nextRootOid = data.rootTreeOid ?? data.commit.treeOid;
    const changed =
      this.commitTreeOid !== nextCommitOid || this.rootTreeOid !== nextRootOid;
    this.commitTreeOid = nextCommitOid;
    this.rootTreeOid = nextRootOid;
    if (changed) {
      this._emitter.fire([
        { type: vscode.FileChangeType.Changed, uri: this.getRootUri() },
      ]);
    }
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
    const p = uri.path.replace(/\/+$/, "") || "/";
    if (p === prefix || p === "/") return "";
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
    if (filePath === "") {
      await this.getRootTreeOid();
      return {
        type: vscode.FileType.Directory,
        ctime: 0,
        mtime: 0,
        size: 0,
      };
    }
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
      let entry = await this.resolve(uri);
      if (!entry?.type && this.commitTreeOid) {
        await this.trees.getTree(this.commitTreeOid);
        entry = await this.resolve(uri);
      }
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
      logger("readDirectory: empty root", {
        uri: uri.toString(),
        path: uri.path,
        filePath,
        hasCommitTree: Boolean(this.commitTreeOid),
      });
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

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: `Saving ${path}`,
        cancellable: false,
      },
      async (progress) => {
        if (this.currentRef === this.configRef) {
          progress.report({ message: "Creating draft branch…" });
          const newBranch = generateBranchName();
          await this.createBranch(newBranch, this.configRef);
          progress.report({ message: `Switching to ${newBranch}…` });
          await this.switchRef(newBranch);
          this._onDidCreateBranch.fire(newBranch);
        }

        if (isBinary) {
          progress.report({ message: "Uploading binary via legacy add…" });
          const addResult = await postAddWithProgress(
            this.apiUrl,
            {
              ref: this.currentRef,
              files: { [path]: filePayload },
            },
            (message) => progress.report({ message }),
          );
          this._conflictPaths.delete(path);
          this.rootTreeOid = addResult.rootTreeOid;
          this._emitter.fire([
            { type: vscode.FileChangeType.Changed, uri: this.getRootUri() },
          ]);
          return;
        }

        progress.report({ message: "Computing tree locally…" });
        const rootTreeOid = await this.getRootTreeOid();
        const blobOid = isBinary
          ? await calculateBlobOidFromBytes(content)
          : await calculateBlobOid(filePayload as string);
        const applied = await this.trees.applyEntriesToTree({
          rootTreeOid,
          entries: [{ oid: blobOid, path }],
        });
        const trees = treesForPatch(
          this.trees.exportTreesForPersist(applied.trees),
          { omitEmptyTree: true },
        );
        progress.report({
          message: `Uploading ${trees.length} changed tree(s) and indexing ${path}…`,
        });
        const textContent = filePayload as string;
        const patchResult = await postPatchWorktree(this.apiUrl, {
          ref: this.currentRef,
          rootTreeOid: applied.rootOid,
          changedFiles: [{ path, oid: blobOid, content: textContent }],
          trees,
        });

        this._conflictPaths.delete(path);
        this.rootTreeOid = patchResult.rootTreeOid;
        this._emitter.fire([
          { type: vscode.FileChangeType.Changed, uri: this.getRootUri() },
        ]);
      },
    );

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
