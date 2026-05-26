import {
  TR33_EXTENSION_TO_HOST_REF_CHANNEL,
  TR33_EXTENSION_WORKSPACE_CHANGED_CHANNEL,
} from "./host-bridge";

const log = (...args: unknown[]) => {
  console.info("[tr33:vscode:kit-parent]", ...args);
};

/**
 * Notifies the embedding Kit host that the active git ref changed.
 *
 * 1. **BroadcastChannel** — works from the extension host worker when it shares an origin
 *    with the page (same-origin policy applies to who receives the message).
 * 2. **postMessage** — when `window` exists and the editor is embedded (`top !== self`).
 *
 * Must match Kit listeners: `tr33-kit-branch-changed` and `TR33_EXTENSION_TO_HOST_REF_CHANNEL`.
 */
export function notifyKitParentBranchChanged(ref: string): void {
  if (typeof BroadcastChannel !== "undefined") {
    try {
      const bc = new BroadcastChannel(TR33_EXTENSION_TO_HOST_REF_CHANNEL);
      bc.postMessage({ ref });
      bc.close();
      log("BroadcastChannel → host", TR33_EXTENSION_TO_HOST_REF_CHANNEL, ref);
    } catch (e) {
      log("BroadcastChannel failed", e);
    }
  }

  if (typeof globalThis.window === "undefined") {
    log("no window; postMessage skipped (BroadcastChannel above may suffice)");
    return;
  }
  const w = globalThis.window;
  if (w.top === w) {
    log("postMessage skipped: already top window");
    return;
  }
  let targetOrigin = "*";
  try {
    targetOrigin = w.top!.location.origin;
  } catch {
    /* cross-origin */
  }
  log("postMessage → top", { ref, targetOrigin });
  w.top!.postMessage({ type: "tr33-kit-branch-changed", ref }, targetOrigin);
}

/** After save/commit/discard: notify Kit to soft-refresh RSC (`router.refresh()`). */
let workspaceNotifyTimer: ReturnType<typeof setTimeout> | null = null;

export function notifyKitParentWorkspaceChanged(): void {
  if (workspaceNotifyTimer) {
    clearTimeout(workspaceNotifyTimer);
  }
  workspaceNotifyTimer = setTimeout(() => {
    workspaceNotifyTimer = null;
    notifyKitParentWorkspaceChangedNow();
  }, 800);
}

function notifyKitParentWorkspaceChangedNow(): void {
  if (typeof BroadcastChannel !== "undefined") {
    try {
      const bc = new BroadcastChannel(TR33_EXTENSION_WORKSPACE_CHANGED_CHANNEL);
      bc.postMessage({ source: "workspace" as const });
      bc.close();
      log(
        "BroadcastChannel → host (workspace)",
        TR33_EXTENSION_WORKSPACE_CHANGED_CHANNEL,
      );
    } catch (e) {
      log("BroadcastChannel workspace failed", e);
    }
  }

  if (typeof globalThis.window === "undefined") {
    return;
  }
  const w = globalThis.window;
  if (w.top === w) {
    return;
  }
  let targetOrigin = "*";
  try {
    targetOrigin = w.top!.location.origin;
  } catch {
    /* cross-origin */
  }
  log("postMessage → top (workspace-changed)", { targetOrigin });
  w.top!.postMessage(
    { type: "tr33-kit-workspace-changed" },
    targetOrigin,
  );
}
