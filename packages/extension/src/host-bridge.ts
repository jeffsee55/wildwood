/**
 * Re-exports from @tr33/shared so extension + kit stay in sync.
 * Do not duplicate channel names / storage keys.
 */
export {
  TR33_ACTIVE_REF_STORAGE_KEY,
  TR33_EXTENSION_TO_HOST_REF_CHANNEL,
  TR33_EXTENSION_WORKSPACE_CHANGED_CHANNEL,
  TR33_KIT_HOST_REF_CHANNEL,
  generateBranchName,
} from "@tr33/shared";

import {
  TR33_ACTIVE_REF_STORAGE_KEY as ACTIVE_REF_KEY,
  TR33_KIT_HOST_REF_CHANNEL as KIT_REF_CHANNEL,
} from "@tr33/shared";

export function readActiveRefFromStorage(): string | undefined {
  if (typeof localStorage === "undefined") return undefined;
  try {
    const ref = localStorage.getItem(ACTIVE_REF_KEY)?.trim();
    return ref && ref.length > 0 ? ref : undefined;
  } catch {
    return undefined;
  }
}

export function writeActiveRefToStorage(ref: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(ACTIVE_REF_KEY, ref);
  } catch {
    /* private mode / blocked storage */
  }
}

export type HostRefMessage = { ref: string };

export function subscribeHostRef(onRef: (ref: string) => void): { dispose(): void } {
  if (typeof BroadcastChannel === "undefined") return { dispose() {} };
  const bc = new BroadcastChannel(KIT_REF_CHANNEL);
  bc.onmessage = (ev: MessageEvent<HostRefMessage>) => {
    const r = ev.data?.ref;
    if (typeof r === "string" && r.length > 0) onRef(r);
  };
  return { dispose() { bc.close(); } };
}
