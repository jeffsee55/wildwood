import type {} from "wildwood-shared";

const log = (...args: unknown[]) => {
  console.info("[wildwood:vscode:kit-parent]", ...args);
};

function channels() {
  // Require so extension host bundler doesn't tree-shake away dynamic constants.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require("wildwood-shared") as typeof import("wildwood-shared");
  return {
    WILDWOOD_EXTENSION_TO_HOST_REF_CHANNEL: mod.WILDWOOD_EXTENSION_TO_HOST_REF_CHANNEL,
    WILDWOOD_EXTENSION_WORKSPACE_CHANGED_CHANNEL:
      mod.WILDWOOD_EXTENSION_WORKSPACE_CHANGED_CHANNEL,
  };
}

export function notifyKitParentBranchChanged(ref: string): void {
  const { WILDWOOD_EXTENSION_TO_HOST_REF_CHANNEL } = channels();
  if (typeof BroadcastChannel !== "undefined") {
    try {
      const bc = new BroadcastChannel(WILDWOOD_EXTENSION_TO_HOST_REF_CHANNEL);
      bc.postMessage({ ref });
      bc.close();
      log("BroadcastChannel → host", WILDWOOD_EXTENSION_TO_HOST_REF_CHANNEL, ref);
    } catch (e) {
      log("BroadcastChannel failed", e);
    }
  }
  if (typeof globalThis.window === "undefined") {
    log("no window; postMessage skipped (BroadcastChannel above may suffice)");
    return;
  }
  const w = globalThis.window as Window & typeof globalThis;
  if (w.top === w) {
    log("postMessage skipped: already top window");
    return;
  }
  let targetOrigin = "*";
  try {
    targetOrigin = w.top!.location.origin;
  } catch {}
  log("postMessage → top", { ref, targetOrigin });
  w.top!.postMessage({ type: "wildwood-kit-branch-changed", ref }, targetOrigin);
}

let workspaceNotifyTimer: ReturnType<typeof setTimeout> | null = null;

export function notifyKitParentWorkspaceChanged(): void {
  if (workspaceNotifyTimer) clearTimeout(workspaceNotifyTimer);
  workspaceNotifyTimer = setTimeout(() => {
    workspaceNotifyTimer = null;
    notifyKitParentWorkspaceChangedNow();
  }, 800);
}

function notifyKitParentWorkspaceChangedNow(): void {
  const { WILDWOOD_EXTENSION_WORKSPACE_CHANGED_CHANNEL } = channels();
  if (typeof BroadcastChannel !== "undefined") {
    try {
      const bc = new BroadcastChannel(WILDWOOD_EXTENSION_WORKSPACE_CHANGED_CHANNEL);
      bc.postMessage({ source: "workspace" as const });
      bc.close();
      log("BroadcastChannel → host (workspace)", WILDWOOD_EXTENSION_WORKSPACE_CHANGED_CHANNEL);
    } catch (e) {
      log("BroadcastChannel workspace failed", e);
    }
  }
  if (typeof globalThis.window === "undefined") return;
  const w = globalThis.window as Window & typeof globalThis;
  if (w.top === w) return;
  let targetOrigin = "*";
  try {
    targetOrigin = w.top!.location.origin;
  } catch {}
  log("postMessage → top (workspace-changed)", { targetOrigin });
  w.top!.postMessage({ type: "wildwood-kit-workspace-changed" }, targetOrigin);
}
