import { merge as diff3Merge } from "node-diff3";
import { calculateBlobOid, calculateTreeOid } from "./git-objects";
import type { TreeEntries, TreeStore } from "./types";

export type GetEntriesFn = (oid: string) => Promise<TreeEntries | null>;

export type GetBlobFn = (oid: string) => Promise<{ oid: string; content: string } | null>;

export type PathEntry = {
  path: string;
  oid: string;
  type: "blob" | "tree";
};

export type TreeDiff = {
  added: PathEntry[];
  deleted: PathEntry[];
  modified: { path: string; oldOid: string; newOid: string }[];
};

export type MergeConflict =
  | {
      type: "add-add";
      path: string;
      ours: string;
      theirs: string;
    }
  | {
      type: "modify-delete";
      path: string;
      base: string;
      ours: string | null;
      theirs: string | null;
    }
  | {
      type: "content";
      path: string;
      base: string;
      ours: string;
      theirs: string;
      reason: "missing-blob" | "binary-file";
    }
  | {
      type: "content";
      path: string;
      base: string;
      ours: string;
      theirs: string;
      reason: "conflicting-changes";
      content: string;
    };

export type NewBlob = {
  path: string;
  oid: string;
  content: string;
};

export type MergeOrtResult = {
  clean: boolean;
  rootOid: string;
  store: TreeStore;
  conflicts: MergeConflict[];
  newBlobs: NewBlob[];
};

export type MergeResult = MergeOrtResult & {
  mergeBaseOids: string[];
};

type TreeEntryChild = { type: "blob" | "tree"; oid: string };

export type ContentMergeResult =
  | { status: "identical"; oid: string }
  | { status: "merged"; content: string }
  | { status: "conflict"; reason: "missing-blob" }
  | { status: "conflict"; reason: "binary-file" }
  | { status: "conflict"; reason: "conflicting-changes"; content: string };

export async function tryContentMerge(args: {
  path: string;
  baseOid: string;
  oursOid: string;
  theirsOid: string;
  getBlob: GetBlobFn;
}): Promise<ContentMergeResult> {
  const { baseOid, oursOid, theirsOid, getBlob } = args;

  if (oursOid === theirsOid) {
    return { status: "identical", oid: oursOid };
  }

  const [base, ours, theirs] = await Promise.all([
    getBlob(baseOid),
    getBlob(oursOid),
    getBlob(theirsOid),
  ]);

  if (!base || !ours || !theirs) {
    return { status: "conflict", reason: "missing-blob" };
  }

  if (
    isBinaryContent(base.content) ||
    isBinaryContent(ours.content) ||
    isBinaryContent(theirs.content)
  ) {
    return { status: "conflict", reason: "binary-file" };
  }

  const baseLines = base.content.split("\n");
  const oursLines = ours.content.split("\n");
  const theirsLines = theirs.content.split("\n");

  const result = threeWayMergeLines(baseLines, oursLines, theirsLines);

  if (result.conflict) {
    return {
      status: "conflict",
      reason: "conflicting-changes",
      content: result.merged.join("\n"),
    };
  }

  return {
    status: "merged",
    content: result.merged.join("\n"),
  };
}

function threeWayMergeLines(
  base: string[],
  ours: string[],
  theirs: string[],
): { conflict: boolean; merged: string[] } {
  const result = diff3Merge(ours, base, theirs);
  return {
    conflict: result.conflict,
    merged: result.result,
  };
}

function isBinaryContent(content: string): boolean {
  const sample = content.slice(0, 8000);
  return sample.includes("\0");
}

export async function mergeOrt(args: {
  baseTreeOid: string;
  oursTreeOid: string;
  theirsTreeOid: string;
  getEntries: GetEntriesFn;
  getBlob: GetBlobFn;
}): Promise<MergeOrtResult> {
  const { baseTreeOid, oursTreeOid, theirsTreeOid, getEntries, getBlob } = args;

  const conflicts: MergeConflict[] = [];
  const newBlobs: NewBlob[] = [];
  const store: TreeStore = {};

  if (baseTreeOid === oursTreeOid && oursTreeOid === theirsTreeOid) {
    const entries = await getEntries(oursTreeOid);
    if (entries) store[oursTreeOid] = { ...entries };
    return {
      clean: true,
      rootOid: oursTreeOid,
      store,
      conflicts: [],
      newBlobs: [],
    };
  }

  async function mergeAtLevel(
    baseOid: string,
    oursOid: string,
    theirsOid: string,
    pathPrefix: string,
  ): Promise<Record<string, TreeEntryChild> | null> {
    if (baseOid === oursOid && oursOid === theirsOid) {
      const entries = await getEntries(baseOid);
      if (entries) store[baseOid] = { ...entries };
      return null;
    }

    const [baseEntries, oursEntries, theirsEntries] = await Promise.all([
      getEntries(baseOid),
      getEntries(oursOid),
      getEntries(theirsOid),
    ]);

    const baseE = baseEntries ?? {};
    const oursE = oursEntries ?? {};
    const theirsE = theirsEntries ?? {};

    const allNames = new Set([
      ...Object.keys(baseE),
      ...Object.keys(oursE),
      ...Object.keys(theirsE),
    ]);

    const resultEntries: Record<string, TreeEntryChild> = {};

    for (const name of allNames) {
      const baseEntry = baseE[name];
      const oursEntry = oursE[name];
      const theirsEntry = theirsE[name];
      const path = pathPrefix ? `${pathPrefix}/${name}` : name;

      if (!baseEntry && !theirsEntry && oursEntry) {
        resultEntries[name] = oursEntry;
        continue;
      }
      if (!baseEntry && !oursEntry && theirsEntry) {
        resultEntries[name] = theirsEntry;
        continue;
      }
      if (!baseEntry && oursEntry && theirsEntry) {
        if (oursEntry.oid === theirsEntry.oid) {
          resultEntries[name] = oursEntry;
        } else {
          conflicts.push({
            type: "add-add",
            path,
            ours: oursEntry.oid,
            theirs: theirsEntry.oid,
          });
        }
        continue;
      }
      if (baseEntry && !oursEntry && !theirsEntry) {
        continue;
      }
      if (baseEntry && oursEntry && !theirsEntry) {
        if (oursEntry.oid === baseEntry.oid) {
          continue;
        }
        conflicts.push({
          type: "modify-delete",
          path,
          base: baseEntry.oid,
          ours: oursEntry.oid,
          theirs: null,
        });
        continue;
      }
      if (baseEntry && !oursEntry && theirsEntry) {
        if (theirsEntry.oid === baseEntry.oid) {
          continue;
        }
        conflicts.push({
          type: "modify-delete",
          path,
          base: baseEntry.oid,
          ours: null,
          theirs: theirsEntry.oid,
        });
        continue;
      }

      if (baseEntry && oursEntry && theirsEntry) {
        const baseO = baseEntry.oid;
        const oursO = oursEntry.oid;
        const theirsO = theirsEntry.oid;

        if (baseO === oursO && oursO === theirsO) {
          resultEntries[name] = oursEntry;
          continue;
        }
        if (oursO === theirsO) {
          resultEntries[name] = oursEntry;
          continue;
        }
        if (baseO === oursO) {
          resultEntries[name] = theirsEntry;
          continue;
        }
        if (baseO === theirsO) {
          resultEntries[name] = oursEntry;
          continue;
        }

        const allBlobs =
          baseEntry.type === "blob" && oursEntry.type === "blob" && theirsEntry.type === "blob";
        const allTrees =
          baseEntry.type === "tree" && oursEntry.type === "tree" && theirsEntry.type === "tree";

        if (allBlobs) {
          const mergeResult = await tryContentMerge({
            path,
            baseOid: baseO,
            oursOid: oursO,
            theirsOid: theirsO,
            getBlob,
          });
          switch (mergeResult.status) {
            case "identical":
              resultEntries[name] = {
                type: "blob",
                oid: mergeResult.oid,
              };
              break;
            case "merged": {
              const oid = await calculateBlobOid(mergeResult.content);
              resultEntries[name] = { type: "blob", oid };
              newBlobs.push({
                path,
                oid,
                content: mergeResult.content,
              });
              break;
            }
            case "conflict":
              if (mergeResult.reason === "conflicting-changes") {
                conflicts.push({
                  type: "content",
                  path,
                  base: baseO,
                  ours: oursO,
                  theirs: theirsO,
                  reason: mergeResult.reason,
                  content: mergeResult.content,
                });
              } else {
                conflicts.push({
                  type: "content",
                  path,
                  base: baseO,
                  ours: oursO,
                  theirs: theirsO,
                  reason: mergeResult.reason,
                });
              }
              break;
          }
          continue;
        }

        if (allTrees) {
          const childResult = await mergeAtLevel(baseO, oursO, theirsO, path);
          if (childResult === null) {
            resultEntries[name] = oursEntry;
          } else {
            const newOid = await calculateTreeOid(childResult);
            store[newOid] = { ...childResult };
            resultEntries[name] = { type: "tree", oid: newOid };
          }
          continue;
        }

        conflicts.push({
          type: "content",
          path,
          base: baseO,
          ours: oursO,
          theirs: theirsO,
          reason: "missing-blob",
        });
      }
    }

    return resultEntries;
  }

  const rootEntries = await mergeAtLevel(baseTreeOid, oursTreeOid, theirsTreeOid, "");

  if (rootEntries === null) {
    return {
      clean: conflicts.length === 0,
      rootOid: oursTreeOid,
      store,
      conflicts,
      newBlobs,
    };
  }

  const newRootOid = await calculateTreeOid(rootEntries);
  store[newRootOid] = { ...rootEntries };

  return {
    clean: conflicts.length === 0,
    rootOid: newRootOid,
    store,
    conflicts,
    newBlobs,
  };
}
