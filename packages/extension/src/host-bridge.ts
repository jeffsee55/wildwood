/**
 * Re-exports from wildwood-shared so extension + kit stay in sync.
 * Do not duplicate channel names / storage keys.
 */
export {
  WILDWOOD_ACTIVE_REF_STORAGE_KEY,
  WILDWOOD_EXTENSION_TO_HOST_REF_CHANNEL,
  WILDWOOD_EXTENSION_WORKSPACE_CHANGED_CHANNEL,
  WILDWOOD_KIT_HOST_REF_CHANNEL,
  generateBranchName,
} from "wildwood-shared";

import {
  WILDWOOD_ACTIVE_REF_STORAGE_KEY as ACTIVE_REF_KEY,
  WILDWOOD_KIT_HOST_REF_CHANNEL as KIT_REF_CHANNEL,
} from "wildwood-shared";

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
  return {
    dispose() {
      bc.close();
    },
  };
}
