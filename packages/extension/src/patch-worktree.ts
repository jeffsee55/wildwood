import { GIT_EMPTY_TREE_OID } from "@tr33/shared";
import type { TreeEntries } from "tr33-store";

export type ChangedFile = {
  path: string;
  oid: string;
  content: string;
};

export type PatchWorktreePayload = {
  ref: string;
  /** New worktree root after applying the save locally. */
  rootTreeOid: string;
  /** File(s) written this save — path + blob oid + content for index/persist. */
  changedFiles: ChangedFile[];
  /** Only new/changed git tree objects (leaf dir + ancestors), not the full repo. */
  trees: { oid: string; entries: TreeEntries }[];
};

export async function postPatchWorktree(
  apiUrl: string,
  payload: PatchWorktreePayload,
): Promise<{ rootTreeOid: string }> {
  const res = await fetch(`${apiUrl}/patch-worktree`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(
      err.trim() || `Failed to patch worktree (${res.status})`,
    );
  }
  return (await res.json()) as { rootTreeOid: string };
}

/** Dedupe by oid; omit canonical empty tree if already materialized elsewhere. */
export function treesForPatch(
  trees: { oid: string; entries: TreeEntries }[],
  options?: { omitEmptyTree?: boolean },
): { oid: string; entries: TreeEntries }[] {
  const seen = new Set<string>();
  const out: { oid: string; entries: TreeEntries }[] = [];
  for (const tree of trees) {
    if (options?.omitEmptyTree && tree.oid === GIT_EMPTY_TREE_OID) {
      continue;
    }
    if (seen.has(tree.oid)) {
      continue;
    }
    seen.add(tree.oid);
    out.push(tree);
  }
  return out;
}
