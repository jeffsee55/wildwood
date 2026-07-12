import * as vscode from "vscode";
import { WildwoodFileSystemProvider, generateBranchName, SCHEME } from "./filesystem";
import { subscribeHostRef, writeActiveRefToStorage } from "./host-bridge";
import { whenWildwoodExtensionContextReady } from "./resolve-context";
import { WildwoodSourceControlProvider } from "./source-control";

export const logger = (...args: unknown[]) => {
  console.log("[Wildwood Extension]", ...args);
};

const MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
};

class WildwoodImageEditorProvider
  implements vscode.CustomReadonlyEditorProvider
{
  constructor(private fs: WildwoodFileSystemProvider) {}

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose() {} };
  }

  async resolveCustomEditor(
    document: vscode.CustomDocument,
    webviewPanel: vscode.WebviewPanel,
  ): Promise<void> {
    const uri = document.uri;
    const blobOid = await this.fs.lookupBlobOid(uri);
    if (!blobOid) {
      webviewPanel.webview.html =
        "<!DOCTYPE html><html><body><p>File not found</p></body></html>";
      return;
    }

    const bytes = await this.fs.readBlobBytes(blobOid);
    if (!bytes) {
      webviewPanel.webview.html =
        "<!DOCTYPE html><html><body><p>Failed to load image</p></body></html>";
      return;
    }

    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]!);
    }
    const base64 = btoa(binary);

    const ext = uri.path.split(".").pop()?.toLowerCase() ?? "png";
    const mime = MIME_TYPES[ext] ?? "application/octet-stream";

    webviewPanel.webview.html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
  body { margin:0; display:flex; align-items:center; justify-content:center;
         height:100vh; background:var(--vscode-editor-background);
         background-image: repeating-conic-gradient(
           var(--vscode-editor-background) 0% 25%,
           rgba(128,128,128,0.1) 0% 50%);
         background-size: 16px 16px; }
  img { max-width:100%; max-height:100%; object-fit:contain;
        min-width:32px; min-height:32px; image-rendering:pixelated; }
</style></head>
<body><img src="data:${mime};base64,${base64}" /></body></html>`;
  }
}

export async function activate(context: vscode.ExtensionContext) {
  try {
    logger("Activating...", context.extensionUri.toString());
    const resolved = await whenWildwoodExtensionContextReady(
      context.extensionUri,
    );
    const wildwoodFS = new WildwoodFileSystemProvider(
      context.extensionUri,
      resolved,
    );

    const hostRefSub = subscribeHostRef((ref) => {
      writeActiveRefToStorage(ref);
      void wildwoodFS.switchRef(ref, { notifyParent: false });
    });
    context.subscriptions.push(
      new vscode.Disposable(() => hostRefSub.dispose()),
    );

    try {
      await wildwoodFS.initializeWorkspace();
      context.subscriptions.push(
        vscode.workspace.registerFileSystemProvider(SCHEME, wildwoodFS, {
          isCaseSensitive: true,
          isReadonly: false,
        }),
      );
      await wildwoodFS.bindWorkspaceFolder();
      await wildwoodFS.probeWorkspaceListing();
      wildwoodFS.refreshExplorer();
      queueMicrotask(() => wildwoodFS.refreshExplorer());
      setTimeout(() => wildwoodFS.refreshExplorer(), 250);
      void vscode.commands.executeCommand(
        "workbench.files.action.refreshFilesExplorer",
      );
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : String(error);
      throw new Error(
        `Wildwood: failed to register "${SCHEME}" file system provider (${detail})`,
        { cause: error },
      );
    }

    context.subscriptions.push(
      wildwoodFS.onDidCreateBranch((branchName) => {
        vscode.window.showInformationMessage(
          `Created branch: ${branchName}`,
        );
      }),
    );

    context.subscriptions.push(
      vscode.window.registerCustomEditorProvider(
      "wildwood.imagePreview",
      new WildwoodImageEditorProvider(wildwoodFS),
        { supportsMultipleEditorsPerDocument: true },
      ),
    );

    context.subscriptions.push(
      vscode.commands.registerCommand(
        "wildwood.openMergeEditor",
      async (
        resourceUri: vscode.Uri,
        commitTreeOid: string,
        configRefTreeOid: string,
        mergeBaseTreeOid: string,
      ) => {
        const base = wildwoodFS.getTreeUri(resourceUri, mergeBaseTreeOid);
        const input1 = wildwoodFS.getTreeUri(resourceUri, commitTreeOid);
        const input2 = wildwoodFS.getTreeUri(resourceUri, configRefTreeOid);
        await vscode.commands.executeCommand("_open.mergeEditor", {
          base,
          input1: { uri: input1, title: "Current" },
          input2: { uri: input2, title: "Incoming" },
          output: resourceUri,
        });
        },
      ),
    );

    const workingScm = new WildwoodSourceControlProvider(context, wildwoodFS, {
    id: "wildwood-scm",
    label: "Wildwood",
    mode: "combined",
    primaryAction: {
      command: "wildwood.source-control.commit",
      title: "Commit",
    },
    getPrimaryActionTitle: (state) => {
      if (state.hasUncommittedChanges) {
        return {
          title: "Commit & Push",
          placeholder: `Message (Cmd+Enter to commit and push to "${state.currentRef}")`,
        };
      }
      if (state.isMergeOnly) {
        return {
          title: `Merge to ${state.configRef}`,
          placeholder: `No uncommitted changes. Cmd+Enter to merge "${state.currentRef}" -> "${state.configRef}"`,
        };
      }
      if (state.existingPr) {
        return {
          title: "Merge PR",
          placeholder: `Comment to post on PR before merge (optional). Cmd+Enter to merge into "${state.configRef}"`,
        };
      }
      return {
        title: "Create PR",
        placeholder: `PR title and description. Cmd+Enter to create PR for "${state.currentRef}" -> "${state.configRef}"`,
      };
    },
    secondaryActions: [
      {
        command: "wildwood.source-control.syncToConfigRef",
        title: "Create PR / Merge PR",
      },
    ],
      showStatusBar: true,
    });

    context.subscriptions.push(
      vscode.commands.registerCommand("wildwood.switchBranch", async () => {
      const branches = await wildwoodFS.fetchBranches();
      const currentRef = wildwoodFS.getCurrentRef();
      const configRef = wildwoodFS.getConfigRef();
      const items: vscode.QuickPickItem[] = [
        {
          label: "$(add) New branch",
          description: `Create from ${configRef} (auto-named)`,
          alwaysShow: true,
        },
        ...branches.map((branch) => {
          const isCurrent = branch === currentRef;
          const isDefault = branch === configRef;
          const desc = [isCurrent ? "current" : "", isDefault ? "default" : ""]
            .filter(Boolean)
            .join(", ");
          return {
            label: `${isCurrent ? "$(check) " : "$(git-branch) "}${branch}`,
            description: desc || undefined,
            detail: undefined,
            picked: isCurrent,
            alwaysShow: isCurrent || isDefault,
          } satisfies vscode.QuickPickItem;
        }),
      ];
      const picked = await vscode.window.showQuickPick(items, {
        title: "Switch branch",
        placeHolder: "Type to filter branches or create new...",
        matchOnDescription: true,
      });
      if (!picked) return;
      if (picked.label.startsWith("$(add)")) {
        const branchName = generateBranchName();
        try {
          await wildwoodFS.createBranch(branchName, configRef);
          await wildwoodFS.switchRef(branchName);
          vscode.window.showInformationMessage(
            `Created and switched to branch: ${branchName}`,
          );
        } catch (error) {
          vscode.window.showErrorMessage(
            `Failed to create branch: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return;
      }
      const branch = picked.label.replace(/^\$\([^)]+\)\s*/, "");
      if (branch === currentRef) return;
      await wildwoodFS.switchRef(branch);
        vscode.window.showInformationMessage(`Switched to branch: ${branch}`);
      }),
    );

    context.subscriptions.push(
      vscode.commands.registerCommand("wildwood.source-control.commit", () =>
      workingScm.performCommit(),
    ),
    vscode.commands.registerCommand(
      "wildwood.source-control.commitAndPush",
      () => workingScm.performCommitAndPush(),
    ),
    vscode.commands.registerCommand(
      "wildwood.source-control.commitAndSyncWithPull",
      () => workingScm.performCommitAndSyncWithPull(),
    ),
    vscode.commands.registerCommand("wildwood.source-control.commitAndMerge", () =>
      workingScm.performCommitAndMerge(),
    ),
    vscode.commands.registerCommand("wildwood.source-control.syncToConfigRef", () =>
      workingScm.performSyncToConfigRef(),
    ),
    vscode.commands.registerCommand(
      "wildwood.source-control.skipCommitAndSync",
      () => workingScm.performSyncToConfigRef(),
    ),
    vscode.commands.registerCommand("wildwood.source-control.discard", () =>
      workingScm.performDiscard(),
    ),
    vscode.commands.registerCommand("wildwood.source-control.refresh", () =>
      workingScm.refresh(),
    ),
    vscode.commands.registerCommand(
      "wildwood.source-control.main.commitAndMerge",
      () => workingScm.performCommitAndMerge(),
    ),
    vscode.commands.registerCommand(
      "wildwood.source-control.main.commitAndCreatePr",
      () => workingScm.performCommitAndCreatePr(),
    ),
    vscode.commands.registerCommand("wildwood.source-control.main.commit", () =>
      workingScm.performCommit(),
    ),
    vscode.commands.registerCommand("wildwood.source-control.main.viewPr", () =>
      workingScm.viewExistingPr(),
    ),
    vscode.commands.registerCommand(
      "wildwood.source-control.main.pullFromRemote",
      () => workingScm.performPullFromRemote(),
    ),
    vscode.commands.registerCommand("wildwood.openOnGitHub", () => {
      const repo = wildwoodFS.getRepo();
      if (repo) {
        vscode.env.openExternal(
          vscode.Uri.parse(`https://github.com/${repo}`),
        );
      }
    }),
    vscode.commands.registerCommand("wildwood.openPullRequests", () => {
      const repo = wildwoodFS.getRepo();
      if (repo) {
        vscode.env.openExternal(
          vscode.Uri.parse(`https://github.com/${repo}/pulls`),
        );
      }
    }),
    vscode.commands.registerCommand("wildwood.openIssues", () => {
      const repo = wildwoodFS.getRepo();
      if (repo) {
        vscode.env.openExternal(
          vscode.Uri.parse(`https://github.com/${repo}/issues`),
        );
      }
    }),
    vscode.commands.registerCommand("wildwood.openBranchOnGitHub", () => {
      const repo = wildwoodFS.getRepo();
      const ref = wildwoodFS.getCurrentRef();
      if (repo && ref) {
        vscode.env.openExternal(
          vscode.Uri.parse(`https://github.com/${repo}/tree/${ref}`),
        );
      }
    }),
    vscode.commands.registerCommand("wildwood.closeEmbeddedEditor", () => {
      if (typeof globalThis.window === "undefined") {
        return;
      }
      const w = globalThis.window;
      // Kit embeds the workbench in an iframe; the extension host is nested deeper.
      // parent is often the workbench frame, not the host page — use top.
      if (w.top === w) {
        return;
      }
      let targetOrigin = "*";
      try {
        targetOrigin = w.top.location.origin;
      } catch {
        /* cross-origin top */
      }
        w.top.postMessage({ type: "wildwood-kit-close-editor" }, targetOrigin);
      }),
    );

    logger(`Registered ${SCHEME} filesystem, SCM provider, and commands`);
    queueMicrotask(() => {
      void workingScm.refresh({ skipBranchDiff: true });
    });
    const scheduleFullScmRefresh = () => {
      void workingScm.refresh();
    };
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(scheduleFullScmRefresh, { timeout: 5000 });
    } else {
      setTimeout(scheduleFullScmRefresh, 2000);
    }
  } catch (error) {
    const message =
      error instanceof Error
        ? (error.stack ?? error.message)
        : String(error);
    logger("Activation failed:", message);
    throw error instanceof Error ? error : new Error(message);
  }
}

export function deactivate() {}
