import type { Diff2Entry } from "tr33-store";
import * as vscode from "vscode";
import type { Tr33FileSystemProvider } from "./filesystem";
import { SCHEME } from "./filesystem";

type ComparisonMode = "combined";

type Tr33SourceControlProviderOptions = {
  id: string;
  label: string;
  mode: ComparisonMode;
  primaryAction: {
    command: string;
    /** Fallback title before first refresh; ignored when getPrimaryActionTitle is provided. */
    title: string;
  };
  /** When provided, used as the primary action title in the SCM UI (button and placeholder). */
  getPrimaryActionTitle?: (state: {
    configRef: string;
    currentRef: string;
    hasUncommittedChanges: boolean;
    existingPr: { number: number; url: string } | null;
    isMergeOnly: boolean;
  }) => { title: string; placeholder: string };
  secondaryActions?: {
    command: string;
    title: string;
  }[];
  showStatusBar?: boolean;
};

export class Tr33SourceControlProvider implements vscode.QuickDiffProvider {
  private _sourceControl: vscode.SourceControl;
  private _configRefChangesGroup: vscode.SourceControlResourceGroup;
  private _conflictsGroup: vscode.SourceControlResourceGroup;
  private _workingChangesGroup: vscode.SourceControlResourceGroup;
  private _fs: Tr33FileSystemProvider;
  private _primaryAction: Tr33SourceControlProviderOptions["primaryAction"];
  private _getPrimaryActionTitle: Tr33SourceControlProviderOptions["getPrimaryActionTitle"];
  private _secondaryActions: Tr33SourceControlProviderOptions["secondaryActions"];
  private _showStatusBar: boolean;
  private _existingPr: { number: number; url: string } | null = null;
  private _prActionsSupported = true;
  private _hasUncommittedChanges = false;
  private _disposables: vscode.Disposable[] = [];
  private _refreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    context: vscode.ExtensionContext,
    fs: Tr33FileSystemProvider,
    options: Tr33SourceControlProviderOptions,
  ) {
    this._fs = fs;
    this._primaryAction = options.primaryAction;
    this._getPrimaryActionTitle = options.getPrimaryActionTitle;
    this._secondaryActions = options.secondaryActions;
    this._showStatusBar = options.showStatusBar ?? false;

    this._sourceControl = vscode.scm.createSourceControl(
      options.id,
      options.label,
      fs.getRootUri(),
    );
    this._sourceControl.quickDiffProvider = this;
    this._sourceControl.inputBox.placeholder = "Commit message";
    this._sourceControl.acceptInputCommand = this._primaryAction;

    this._workingChangesGroup = this._sourceControl.createResourceGroup(
      "uncommittedChanges",
      "Uncommitted changes",
    );
    this._workingChangesGroup.hideWhenEmpty = true;
    this._configRefChangesGroup = this._sourceControl.createResourceGroup(
      "changesComparedToConfigRef",
      `Changes compared to ${this._fs.getConfigRef()}`,
    );
    this._configRefChangesGroup.hideWhenEmpty = true;
    this._conflictsGroup = this._sourceControl.createResourceGroup(
      "conflictsWithConfigRef",
      `Conflicts with ${this._fs.getConfigRef()}`,
    );
    this._conflictsGroup.hideWhenEmpty = true;

    this._disposables.push(
      this._sourceControl,
      fs.onDidChangeScm(() => this.scheduleRefresh()),
    );

    context.subscriptions.push(...this._disposables);
  }

  // ── QuickDiffProvider ──────────────────────────────────────────────

  provideOriginalResource(uri: vscode.Uri): vscode.Uri | undefined {
    if (uri.scheme !== SCHEME || uri.query) return undefined;
    const oid = this._fs.getCommitTreeOid();
    if (!oid) return undefined;
    return this._fs.getTreeUri(uri, oid);
  }

  // ── Public API ─────────────────────────────────────────────────────

  private scheduleRefresh(): void {
    if (this._refreshTimer) {
      clearTimeout(this._refreshTimer);
    }
    this._refreshTimer = setTimeout(() => {
      this._refreshTimer = null;
      void this.refresh();
    }, 500);
  }

  async refresh(options?: { skipBranchDiff?: boolean }): Promise<void> {
    try {
      const rootUri = this._fs.getRootUri();
      const state = await this._fs.fetchScmState(options);

      this._hasUncommittedChanges = state.workingChanges.length > 0;
      this._workingChangesGroup.label = "Uncommitted changes";
      this._configRefChangesGroup.label = `Changes compared to ${this._fs.getConfigRef()}`;
      this._conflictsGroup.label = `Conflicts with ${this._fs.getConfigRef()}`;

      this._workingChangesGroup.resourceStates = state.workingChanges.map(
        (c) =>
          this.toResourceState(c, rootUri, "working", state.commitTreeOid),
      );

      const conflictByPath = new Map(
        state.conflicts.map((c) => [c.path, c.message]),
      );
      const { configRefTreeOid, mergeBaseTreeOid } = state;
      this._configRefChangesGroup.resourceStates = configRefTreeOid
        ? state.configRefChanges.map((c) => {
            const conflictMsg = conflictByPath.get(c.path);
            return this.toResourceState(
              c,
              rootUri,
              "branch",
              configRefTreeOid,
              conflictMsg && mergeBaseTreeOid
                ? {
                    message: conflictMsg,
                    commitTreeOid: state.commitTreeOid,
                    configRefTreeOid,
                    mergeBaseTreeOid,
                  }
                : undefined,
            );
          })
        : [];
      this._conflictsGroup.resourceStates = [];

      this._fs.setConflictPaths(state.conflicts.map((c) => c.path));

      if (this._prActionsSupported) {
        try {
          this._existingPr = await this._fs.findPrToConfigRef();
        } catch (error) {
          if (this.isPrUnsupportedError(error)) {
            this._prActionsSupported = false;
            this._existingPr = null;
          } else {
            throw error;
          }
        }
      } else {
        this._existingPr = null;
      }

      if (state.conflicts.length === 0) {
        this._fs.setConflictPaths([]);
      }

      this._sourceControl.count =
        this._workingChangesGroup.resourceStates.length +
        this._configRefChangesGroup.resourceStates.length +
        this._conflictsGroup.resourceStates.length;
      this.updateInputUi();
      this.updateStatusBar();
    } catch (error) {
      console.error("[Tr33 SCM] Refresh failed:", error);
    }
  }

  async performCommit(): Promise<void> {
    const message = this._sourceControl.inputBox.value;
    if (!message.trim()) {
      vscode.window.showWarningMessage("Please enter a commit message.");
      return;
    }

    try {
      await this._fs.commit(message, {
        name: "Tr33 User",
        email: "user@tr33.dev",
      });
      this._sourceControl.inputBox.value = "";
      vscode.window.showInformationMessage(`Committed: "${message}"`);
    } catch (error) {
      vscode.window.showErrorMessage(
        `Commit failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async performCommitAndPush(): Promise<void> {
    const message = this._sourceControl.inputBox.value;
    if (!message.trim()) {
      vscode.window.showWarningMessage("Please enter a commit message.");
      return;
    }

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.SourceControl,
          title: `Committing and pushing to ${this._fs.getCurrentRef()}...`,
        },
        async () => {
          await this._fs.commit(message, {
            name: "Tr33 User",
            email: "user@tr33.dev",
          });
          await this.pushIfSupported();
        },
      );
      this._sourceControl.inputBox.value = "";
      vscode.window.showInformationMessage(
        `Committed and pushed: "${message}"`,
      );
      await this.refresh();
    } catch (error) {
      vscode.window.showErrorMessage(
        `Commit & Push failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Commit, pull from remote, then push and create PR or merge PR. */
  async performCommitAndSyncWithPull(): Promise<void> {
    const message = this._sourceControl.inputBox.value;
    if (!message.trim()) {
      vscode.window.showWarningMessage("Please enter a commit message.");
      return;
    }

    const configRef = this._fs.getConfigRef();
    const currentRef = this._fs.getCurrentRef();
    if (currentRef === configRef) {
      vscode.window.showWarningMessage(
        `Already on ${configRef}. Switch to a feature branch first.`,
      );
      return;
    }

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.SourceControl,
          title: `Commit & Sync (pull first) for ${currentRef}...`,
        },
        async () => {
          await this._fs.commit(message, {
            name: "Tr33 User",
            email: "user@tr33.dev",
          });
          try {
            await this._fs.pullFromRemote();
          } catch (pullError) {
            if (this.isRemoteCapabilityError(pullError)) {
              this.logRemoteCapabilitySkip("pull", pullError);
            } else {
              throw pullError;
            }
          }
          await this.pushIfSupported();
          await this.doSyncAfterPush(configRef, currentRef);
        },
      );
      this._sourceControl.inputBox.value = "";
      await this.refresh();
    } catch (error) {
      vscode.window.showErrorMessage(
        `Commit & Sync failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async performCommitAndMerge(): Promise<void> {
    const message = this._sourceControl.inputBox.value;
    if (!message.trim()) {
      vscode.window.showWarningMessage("Please enter a commit message.");
      return;
    }

    const configRef = this._fs.getConfigRef();
    const currentRef = this._fs.getCurrentRef();
    if (currentRef === configRef) {
      vscode.window.showWarningMessage(
        `Already on ${configRef}. Use "Commit" instead.`,
      );
      return;
    }

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.SourceControl,
          title: `Committing and merging to ${configRef}...`,
        },
        async () => {
          await this._fs.commit(message, {
            name: "Tr33 User",
            email: "user@tr33.dev",
          });
          await this.pushIfSupported();
          await this._fs.mergeToConfigRef();
        },
      );
      this._sourceControl.inputBox.value = "";
      await this.switchToConfigRefAfterMerge(configRef, currentRef);
    } catch (error) {
      vscode.window.showErrorMessage(
        `Commit & Merge failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async performCommitAndCreatePr(): Promise<void> {
    const message = this._sourceControl.inputBox.value;
    if (!message.trim()) {
      vscode.window.showWarningMessage("Please enter a commit message.");
      return;
    }

    const configRef = this._fs.getConfigRef();
    const currentRef = this._fs.getCurrentRef();
    if (currentRef === configRef) {
      vscode.window.showWarningMessage(
        `Already on ${configRef}. Switch to a feature branch first.`,
      );
      return;
    }

    try {
      const pr = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.SourceControl,
          title: `Committing and creating PR to ${configRef}...`,
        },
        async () => {
          await this._fs.commit(message, {
            name: "Tr33 User",
            email: "user@tr33.dev",
          });
          await this.pushIfSupported();
          try {
            return await this._fs.createPrToConfigRef(message);
          } catch (error) {
            if (this.isRemoteCapabilityError(error)) {
              this._prActionsSupported = false;
              this.logRemoteCapabilitySkip("create-pr", error);
              await this.mergeToConfigRef();
              return { number: 0, url: "" };
            }
            throw error;
          }
        },
      );
      if (pr.number === 0) {
        this._sourceControl.inputBox.value = "";
        return;
      }
      this._sourceControl.inputBox.value = "";
      const viewPr = "View PR";
      const choice = await vscode.window.showInformationMessage(
        `Created PR #${pr.number} for "${currentRef}" -> "${configRef}"`,
        viewPr,
      );
      if (choice === viewPr) {
        await vscode.env.openExternal(vscode.Uri.parse(pr.url));
      }
    } catch (error) {
      vscode.window.showErrorMessage(
        `Create PR failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async performSyncToConfigRef(): Promise<void> {
    const configRef = this._fs.getConfigRef();
    const currentRef = this._fs.getCurrentRef();
    if (currentRef === configRef) {
      vscode.window.showWarningMessage(
        `Already on ${configRef}. Nothing to merge.`,
      );
      return;
    }

    if (!this._prActionsSupported) {
      await this.mergeToConfigRef();
      return;
    }

    try {
      let pr: { number: number; url: string } | null = null;
      try {
        pr = await this._fs.findPrToConfigRef();
      } catch (error) {
        if (this.isPrUnsupportedError(error)) {
          this._prActionsSupported = false;
          await this.mergeToConfigRef();
          return;
        }
        throw error;
      }

      if (pr) {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.SourceControl,
            title: `Merging PR into ${configRef}...`,
          },
          async () => {
            const message = this._sourceControl.inputBox.value;
            await this._fs.mergeToConfigRef(message);
          },
        );
        this._sourceControl.inputBox.value = "";
        this._fs.invalidateConfigRefState();
        await this.refresh();
        await this.switchToConfigRefAfterMerge(configRef, currentRef);
        return;
      }

      const createdPr = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.SourceControl,
          title: `Creating PR to ${configRef}...`,
        },
        async (): Promise<{ number: number; url: string } | null> => {
          try {
            await this.pushIfSupported();
          } catch (pushError) {
            const msg =
              pushError instanceof Error ? pushError.message : String(pushError);
            if (msg.includes("No unpushed commits found")) {
              // Branch may already be on remote (e.g. scenario or previous push); try creating PR anyway.
            } else {
              throw pushError;
            }
          }
          const prMessage = this._sourceControl.inputBox.value;
          try {
            return await this._fs.createPrToConfigRef(prMessage);
          } catch (error) {
            if (this.isRemoteCapabilityError(error)) {
              this._prActionsSupported = false;
              this.logRemoteCapabilitySkip("create-pr", error);
              await this.mergeToConfigRef();
              return null;
            }
            throw error;
          }
        },
      );
      if (createdPr) {
        this._existingPr = createdPr;
        this._sourceControl.inputBox.value = "";
        await this.refresh();
        const viewPr = "View PR";
        const choice = await vscode.window.showInformationMessage(
          `Created PR #${createdPr.number} for "${currentRef}" -> "${configRef}"`,
          viewPr,
        );
        if (choice === viewPr) {
          await vscode.env.openExternal(vscode.Uri.parse(createdPr.url));
        }
      }
    } catch (error) {
      vscode.window.showErrorMessage(
        `Sync failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async performDiscard(): Promise<void> {
    const confirm = await vscode.window.showWarningMessage(
      "Discard all uncommitted changes?",
      { modal: true },
      "Discard",
    );
    if (confirm !== "Discard") return;

    try {
      await this._fs.discard();
      vscode.window.showInformationMessage("Changes discarded.");
    } catch (error) {
      vscode.window.showErrorMessage(
        `Discard failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  setCommitMessage(message: string): void {
    this._sourceControl.inputBox.value = message;
  }

  async viewExistingPr(): Promise<void> {
    if (!this._existingPr?.url) {
      vscode.window.showInformationMessage("No PR exists for this branch yet.");
      return;
    }
    await vscode.env.openExternal(vscode.Uri.parse(this._existingPr.url));
  }

  async performPullFromRemote(): Promise<void> {
    const currentRef = this._fs.getCurrentRef();
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.SourceControl,
          title: `Pulling latest from remote for ${currentRef}...`,
        },
        async () => {
          await this._fs.pullFromRemote();
        },
      );
      this._sourceControl.inputBox.value = "";
      await this.refresh();
      vscode.window.showInformationMessage(
        `Pulled latest changes for ${currentRef}`,
      );
    } catch (error) {
      vscode.window.showErrorMessage(
        `Pull failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // ── Private helpers ────────────────────────────────────────────────

  private updateInputUi(): void {
    const currentRef = this._fs.getCurrentRef();
    const configRef = this._fs.getConfigRef();
    const isMergeOnly = !this._prActionsSupported;
    let primaryAction: vscode.Command;
    let placeholder: string;
    if (this._getPrimaryActionTitle) {
      const resolved = this._getPrimaryActionTitle({
        configRef,
        currentRef,
        hasUncommittedChanges: this._hasUncommittedChanges,
        existingPr: this._existingPr,
        isMergeOnly,
      });
      primaryAction = {
        command: this._hasUncommittedChanges
          ? "tr33.source-control.commitAndPush"
          : "tr33.source-control.syncToConfigRef",
        title: resolved.title,
      };
      placeholder = resolved.placeholder;
    } else {
      primaryAction = this._hasUncommittedChanges
        ? ({
            command: "tr33.source-control.commitAndPush",
            title: `Commit & Push`,
          } satisfies vscode.Command)
        : isMergeOnly
          ? ({
              command: "tr33.source-control.syncToConfigRef",
              title: `Merge to ${configRef}`,
            } satisfies vscode.Command)
          : this._existingPr
            ? ({
                command: "tr33.source-control.syncToConfigRef",
                title: `Merge PR`,
              } satisfies vscode.Command)
            : ({
                command: "tr33.source-control.syncToConfigRef",
                title: "Create PR",
              } satisfies vscode.Command);
      placeholder = this._hasUncommittedChanges
        ? `Message (Cmd+Enter to commit on "${currentRef}")`
        : isMergeOnly
          ? `No uncommitted changes. Cmd+Enter to merge "${currentRef}" -> "${configRef}"`
          : this._existingPr
            ? `Comment to post on PR before merge (optional). Cmd+Enter to merge into "${configRef}"`
            : `PR title and description. Cmd+Enter to create PR for "${currentRef}" -> "${configRef}"`;
    }
    this._sourceControl.inputBox.placeholder = placeholder;

    const sc = this._sourceControl as unknown as {
      actionButton?: {
        command: vscode.Command;
        secondaryCommands?: vscode.Command[][];
        enabled: boolean;
      };
    };
    this._sourceControl.acceptInputCommand = primaryAction;
    const commitDropdownActions = this._hasUncommittedChanges
      ? [
          {
            command: "tr33.source-control.commit",
            title: "Commit",
          },
          {
            command: "tr33.source-control.commitAndSyncWithPull",
            title: "Commit & Sync",
          },
        ]
      : [];
    const skipCommitAction = {
      command: "tr33.source-control.skipCommitAndSync",
      title: isMergeOnly
        ? `Merge committed changes to ${configRef}`
        : `Skip commit: Create PR / Merge to ${configRef}`,
    } satisfies vscode.Command;
    const secondaryMenuCommands = this._hasUncommittedChanges
      ? []
      : [skipCommitAction];
    sc.actionButton = {
      command: primaryAction,
      enabled: true,
      secondaryCommands: [
        [
          ...commitDropdownActions,
          ...secondaryMenuCommands,
          ...(this._existingPr && this._prActionsSupported
            ? [
                {
                  command: "tr33.source-control.main.pullFromRemote",
                  title: "Pull from remote",
                },
                {
                  command: "tr33.source-control.main.viewPr",
                  title: `View PR #${this._existingPr.number}`,
                },
              ]
            : []),
        ],
      ],
    };
  }

  private isPrUnsupportedError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }
    return (
      error.message.includes("findPr not implemented for NativeRemote") ||
      error.message.includes("Failed to find PR")
    );
  }

  private updateStatusBar(): void {
    if (!this._showStatusBar) {
      this._sourceControl.statusBarCommands = [];
      return;
    }
    const ref = this._fs.getCurrentRef();
    const hasChanges =
      this._workingChangesGroup.resourceStates.length > 0 ||
      this._configRefChangesGroup.resourceStates.length > 0;
    this._sourceControl.statusBarCommands = [
      {
        title: `$(git-branch) ${ref}${hasChanges ? "*" : ""}`,
        command: "tr33.switchBranch",
        tooltip: "Switch branch",
      },
    ];
  }

  private toResourceState(
    change: Diff2Entry,
    rootUri: vscode.Uri,
    group: "working" | "branch",
    baseTreeOid: string,
    conflict?: {
      message: string;
      commitTreeOid: string;
      configRefTreeOid: string;
      mergeBaseTreeOid: string;
    },
  ): vscode.SourceControlResourceState {
    const resourceUri = vscode.Uri.joinPath(rootUri, ...change.path.split("/"));
    const label = change.path.split("/").pop() ?? change.path;

    const baseUri = this._fs.getTreeUri(resourceUri, baseTreeOid);
    const isConflict = conflict !== undefined;

    const decorations: vscode.SourceControlResourceDecorations = {
      strikeThrough: change.status === "removed" && !isConflict,
      tooltip: isConflict
        ? conflict.message
        : change.status === "added"
          ? "Added"
          : change.status === "removed"
            ? "Deleted"
            : "Modified",
      light: {
        iconPath: isConflict
          ? new vscode.ThemeIcon("warning")
          : this.iconForStatus(change.status),
      },
      dark: {
        iconPath: isConflict
          ? new vscode.ThemeIcon("warning")
          : this.iconForStatus(change.status),
      },
    };

    const command: vscode.Command = isConflict
      ? {
          command: "tr33.openMergeEditor",
          title: "Open in Merge Editor",
          arguments: [
            resourceUri,
            conflict.commitTreeOid,
            conflict.configRefTreeOid,
            conflict.mergeBaseTreeOid,
          ],
        }
      : change.status === "removed"
        ? {
            command: "vscode.open",
            title: "Open (deleted)",
            arguments: [baseUri],
          }
        : change.status === "added"
          ? {
              command: "vscode.open",
              title: "Open File",
              arguments: [resourceUri],
            }
          : {
              command: "vscode.diff",
              title: "Open Changes",
              arguments: [
                baseUri,
                resourceUri,
                group === "working"
                  ? `${label} (Working Tree)`
                  : `${label} (vs ${this._fs.getConfigRef()})`,
              ],
            };

    return { resourceUri, decorations, command };
  }

  private iconForStatus(status: string): vscode.ThemeIcon {
    switch (status) {
      case "added":
        return new vscode.ThemeIcon("diff-added");
      case "removed":
        return new vscode.ThemeIcon("diff-removed");
      default:
        return new vscode.ThemeIcon("diff-modified");
    }
  }

  private async mergeToConfigRef(): Promise<void> {
    const configRef = this._fs.getConfigRef();
    const currentRef = this._fs.getCurrentRef();
    const message = this._sourceControl.inputBox.value;
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.SourceControl,
        title: `Merging into ${configRef}...`,
      },
      async () => {
        await this.pushIfSupported();
        await this._fs.mergeToConfigRef(message);
      },
    );
    this._sourceControl.inputBox.value = "";
    await this.switchToConfigRefAfterMerge(configRef, currentRef);
  }

  private async switchToConfigRefAfterMerge(
    configRef: string,
    featureBranchRef: string,
  ): Promise<void> {
    await this._fs.switchRef(configRef);
    await this.refresh();
    const stayOnBranch = "Stay on feature branch";
    const chosen = await vscode.window.showInformationMessage(
      `Switching back to '${configRef}'.`,
      stayOnBranch,
    );
    if (chosen === stayOnBranch) {
      await this._fs.switchRef(featureBranchRef);
      await this.refresh();
    }
  }

  private async pushIfSupported(): Promise<void> {
    try {
      await this._fs.push();
    } catch (error) {
      if (this.isRemoteCapabilityError(error)) {
        this.logRemoteCapabilitySkip("push", error);
        return;
      }
      throw error;
    }
  }

  private logRemoteCapabilitySkip(operation: string, error: unknown): void {
    console.warn(
      `[Tr33 SCM] Skipping unsupported remote operation "${operation}"`,
      error,
    );
  }

  private isRemoteCapabilityError(error: unknown): boolean {
    return (
      this.isPrUnsupportedError(error) ||
      (error instanceof Error &&
        error.message
          .toLowerCase()
          .includes("not implemented for nativeremote"))
    );
  }
}
