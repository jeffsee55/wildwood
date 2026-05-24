import * as vscode from "vscode";
import { Tr33FileSystemProvider, generateBranchName, SCHEME } from "./filesystem";
import { subscribeHostRef } from "./host-bridge";
import { whenTr33ExtensionContextReady } from "./resolve-context";
import { Tr33SourceControlProvider } from "./source-control";

export const logger = (...args: unknown[]) => {
  console.log("[Tr33 Extension]", ...args);
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

class Tr33ImageEditorProvider
  implements vscode.CustomReadonlyEditorProvider
{
  constructor(private fs: Tr33FileSystemProvider) {}

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

    const apiUrl = this.fs.getApiUrl();
    const res = await fetch(`${apiUrl}/blob/${blobOid}/raw`);
    if (!res.ok) {
      webviewPanel.webview.html =
        "<!DOCTYPE html><html><body><p>Failed to load image</p></body></html>";
      return;
    }

    const bytes = new Uint8Array(await res.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
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
    const resolved = await whenTr33ExtensionContextReady(
      context.extensionUri,
    );
    const tr33FS = new Tr33FileSystemProvider(
      context.extensionUri,
      resolved,
    );

    const hostRefSub = subscribeHostRef((ref) => {
      void tr33FS.switchRef(ref, { notifyParent: false });
    });
    context.subscriptions.push(
      new vscode.Disposable(() => hostRefSub.dispose()),
    );

    try {
      await tr33FS.initializeWorkspace();
      context.subscriptions.push(
        vscode.workspace.registerFileSystemProvider(SCHEME, tr33FS, {
          isCaseSensitive: true,
          isReadonly: false,
        }),
      );
      tr33FS.refreshExplorer();
      queueMicrotask(() => tr33FS.refreshExplorer());
      setTimeout(() => tr33FS.refreshExplorer(), 250);
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : String(error);
      throw new Error(
        `Tr33: failed to register "${SCHEME}" file system provider (${detail})`,
        { cause: error },
      );
    }

    context.subscriptions.push(
      tr33FS.onDidCreateBranch((branchName) => {
        vscode.window.showInformationMessage(
          `Created branch: ${branchName}`,
        );
      }),
    );

    context.subscriptions.push(
      vscode.window.registerCustomEditorProvider(
      "tr33.imagePreview",
      new Tr33ImageEditorProvider(tr33FS),
        { supportsMultipleEditorsPerDocument: true },
      ),
    );

    context.subscriptions.push(
      vscode.commands.registerCommand(
        "tr33.openMergeEditor",
      async (
        resourceUri: vscode.Uri,
        commitTreeOid: string,
        configRefTreeOid: string,
        mergeBaseTreeOid: string,
      ) => {
        const base = tr33FS.getTreeUri(resourceUri, mergeBaseTreeOid);
        const input1 = tr33FS.getTreeUri(resourceUri, commitTreeOid);
        const input2 = tr33FS.getTreeUri(resourceUri, configRefTreeOid);
        await vscode.commands.executeCommand("_open.mergeEditor", {
          base,
          input1: { uri: input1, title: "Current" },
          input2: { uri: input2, title: "Incoming" },
          output: resourceUri,
        });
        },
      ),
    );

    const workingScm = new Tr33SourceControlProvider(context, tr33FS, {
    id: "tr33-scm",
    label: "Tr33",
    mode: "combined",
    primaryAction: {
      command: "tr33.source-control.commit",
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
        command: "tr33.source-control.syncToConfigRef",
        title: "Create PR / Merge PR",
      },
    ],
      showStatusBar: true,
    });

    context.subscriptions.push(
      vscode.commands.registerCommand("tr33.switchBranch", async () => {
      const branches = await tr33FS.fetchBranches();
      const currentRef = tr33FS.getCurrentRef();
      const configRef = tr33FS.getConfigRef();
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
          await tr33FS.createBranch(branchName, configRef);
          await tr33FS.switchRef(branchName);
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
      await tr33FS.switchRef(branch);
        vscode.window.showInformationMessage(`Switched to branch: ${branch}`);
      }),
    );

    context.subscriptions.push(
      vscode.commands.registerCommand("tr33.source-control.commit", () =>
      workingScm.performCommit(),
    ),
    vscode.commands.registerCommand(
      "tr33.source-control.commitAndPush",
      () => workingScm.performCommitAndPush(),
    ),
    vscode.commands.registerCommand(
      "tr33.source-control.commitAndSyncWithPull",
      () => workingScm.performCommitAndSyncWithPull(),
    ),
    vscode.commands.registerCommand("tr33.source-control.commitAndMerge", () =>
      workingScm.performCommitAndMerge(),
    ),
    vscode.commands.registerCommand("tr33.source-control.syncToConfigRef", () =>
      workingScm.performSyncToConfigRef(),
    ),
    vscode.commands.registerCommand(
      "tr33.source-control.skipCommitAndSync",
      () => workingScm.performSyncToConfigRef(),
    ),
    vscode.commands.registerCommand("tr33.source-control.discard", () =>
      workingScm.performDiscard(),
    ),
    vscode.commands.registerCommand("tr33.source-control.refresh", () =>
      workingScm.refresh(),
    ),
    vscode.commands.registerCommand(
      "tr33.source-control.main.commitAndMerge",
      () => workingScm.performCommitAndMerge(),
    ),
    vscode.commands.registerCommand(
      "tr33.source-control.main.commitAndCreatePr",
      () => workingScm.performCommitAndCreatePr(),
    ),
    vscode.commands.registerCommand("tr33.source-control.main.commit", () =>
      workingScm.performCommit(),
    ),
    vscode.commands.registerCommand("tr33.source-control.main.viewPr", () =>
      workingScm.viewExistingPr(),
    ),
    vscode.commands.registerCommand(
      "tr33.source-control.main.pullFromRemote",
      () => workingScm.performPullFromRemote(),
    ),
    vscode.commands.registerCommand("tr33.openOnGitHub", () => {
      const repo = tr33FS.getRepo();
      if (repo) {
        vscode.env.openExternal(
          vscode.Uri.parse(`https://github.com/${repo}`),
        );
      }
    }),
    vscode.commands.registerCommand("tr33.openPullRequests", () => {
      const repo = tr33FS.getRepo();
      if (repo) {
        vscode.env.openExternal(
          vscode.Uri.parse(`https://github.com/${repo}/pulls`),
        );
      }
    }),
    vscode.commands.registerCommand("tr33.openIssues", () => {
      const repo = tr33FS.getRepo();
      if (repo) {
        vscode.env.openExternal(
          vscode.Uri.parse(`https://github.com/${repo}/issues`),
        );
      }
    }),
    vscode.commands.registerCommand("tr33.openBranchOnGitHub", () => {
      const repo = tr33FS.getRepo();
      const ref = tr33FS.getCurrentRef();
      if (repo && ref) {
        vscode.env.openExternal(
          vscode.Uri.parse(`https://github.com/${repo}/tree/${ref}`),
        );
      }
    }),
    vscode.commands.registerCommand("tr33.closeEmbeddedEditor", () => {
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
        w.top.postMessage({ type: "tr33-kit-close-editor" }, targetOrigin);
      }),
    );

    logger(`Registered ${SCHEME} filesystem, SCM provider, and commands`);
    await workingScm.refresh();
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
