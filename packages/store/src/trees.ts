import {
  calculateBlobOid,
  calculateTreeOid,
  GIT_EMPTY_TREE_OID,
} from "./git-objects";
import { tryContentMerge } from "./merge";
import type {
	CommitAuthor,
	CommitNode,
	TreeEntries,
} from "./types";

export type { CommitAuthor, CommitNode };

export interface Gitable {
  getTree(oid: string): Promise<TreeEntries | null>;
  getBlob(oid: string): Promise<{ oid: string; content: string } | null>;
  getCommit(oid: string): Promise<CommitNode | null>;
  paths: string[];
}


export type DiffEntry =
  | { status: "added"; path: string; theirsOid: string }
  | { status: "removed"; path: string; oursOid: string }
  | {
      status: "modified";
      path: string;
      oursOid: string;
      theirsOid: string;
      oid: string;
    };

export type DiffTreesConflict = {
  path: string;
  oursOid: string | undefined;
  theirsOid: string | undefined;
  message: string;
  value: string;
};

export type NewBlob = { path: string; oid: string; content: string };

export type ApplyTreesResult = { rootOid: string; trees: string[] };

export type DiffTreesResult = {
  entries: DiffEntry[];
  conflicts: DiffTreesConflict[];
  newBlobs: NewBlob[];
  trees: ApplyTreesResult;
};

export type ResolveResult =
  | { type: "tree"; oid: string; entries: TreeEntries }
  | { type: "blob"; oid: string; content: string };

export type LookupResult =
  | { type: "tree"; oid: string }
  | { type: "blob"; oid: string };

export type Diff2Entry =
  | { status: "added"; path: string; oid: string }
  | { status: "removed"; path: string; oid: string }
  | { status: "modified"; path: string; baseOid: string; currentOid: string };

export class Trees {
	private gitable: Gitable;
	treeStore = new Map<string, TreeEntries>();
	private emptyTreeOid: string | null = null;

	constructor(args: { gitable: Gitable }) {
		this.gitable = args.gitable;
	}

  async getTree(oid: string): Promise<TreeEntries | null> {
    const cached = this.treeStore.get(oid);
    if (cached) return cached;

    const tree = await this.gitable.getTree(oid);
    if (tree) {
      this.treeStore.set(oid, tree);
      return tree;
    }
    return null;
  }

  /** In-memory trees produced by `applyEntriesToTree` for persistence without re-fetching. */
  exportTreesForPersist(oids: string[]): { oid: string; entries: TreeEntries }[] {
    const out: { oid: string; entries: TreeEntries }[] = [];
    for (const oid of oids) {
      const entries = this.treeStore.get(oid);
      if (entries !== undefined) {
        out.push({ oid, entries });
      }
    }
    return out;
  }

  async resolve(
    rootOid: string,
    path: string,
  ): Promise<ResolveResult | null> {
    const segments = path.split("/").filter(Boolean);

    if (segments.length === 0) {
      const entries = await this.getTree(rootOid);
      if (!entries) return null;
      return { type: "tree", oid: rootOid, entries };
    }

    let treeOid = rootOid;
    for (let i = 0; i < segments.length; i++) {
      const tree = await this.getTree(treeOid);
      if (!tree) return null;
      const child = tree[segments[i]];
      if (!child) return null;

      if (i === segments.length - 1) {
        if (child.type === "tree") {
          const entries = await this.getTree(child.oid);
          if (!entries) return null;
          return { type: "tree", oid: child.oid, entries };
        }
        const blob = await this.gitable.getBlob(child.oid);
        if (!blob) return null;
        return { type: "blob", oid: child.oid, content: blob.content };
      }

      if (child.type !== "tree") return null;
      treeOid = child.oid;
    }
    return null;
  }

  /** Walk the tree without fetching blob content — for stat-like operations. */
  async lookup(
    rootOid: string,
    path: string,
  ): Promise<LookupResult | null> {
    const segments = path.split("/").filter(Boolean);
    if (segments.length === 0) {
      const entries = await this.getTree(rootOid);
      if (!entries) return null;
      return { type: "tree", oid: rootOid };
    }

    let treeOid = rootOid;
    for (let i = 0; i < segments.length; i++) {
      const tree = await this.getTree(treeOid);
      if (!tree) return null;
      const child = tree[segments[i]];
      if (!child) return null;

      if (i === segments.length - 1) {
        return { type: child.type, oid: child.oid };
      }
      if (child.type !== "tree") return null;
      treeOid = child.oid;
    }
    return null;
  }

  async diff2(args: {
    baseTreeOid: string;
    currentTreeOid: string;
    pathPrefix?: string;
  }): Promise<Diff2Entry[]> {
    const { baseTreeOid, currentTreeOid, pathPrefix = "" } = args;
    if (baseTreeOid === currentTreeOid) return [];

    const baseEntries = (await this.getTree(baseTreeOid)) ?? {};
    const currentEntries = (await this.getTree(currentTreeOid)) ?? {};
    const allNames = new Set([
      ...Object.keys(baseEntries),
      ...Object.keys(currentEntries),
    ]);

    const result: Diff2Entry[] = [];

    for (const name of allNames) {
      const base = baseEntries[name];
      const current = currentEntries[name];
      const path = pathPrefix ? `${pathPrefix}/${name}` : name;

      if (!base && current) {
        if (current.type === "tree") {
          const sub = await this.diff2({ baseTreeOid: await this.getEmptyTreeOid(), currentTreeOid: current.oid, pathPrefix: path });
          result.push(...sub);
        } else {
          result.push({ status: "added", path, oid: current.oid });
        }
      } else if (base && !current) {
        if (base.type === "tree") {
          const sub = await this.diff2({ baseTreeOid: base.oid, currentTreeOid: await this.getEmptyTreeOid(), pathPrefix: path });
          result.push(...sub);
        } else {
          result.push({ status: "removed", path, oid: base.oid });
        }
      } else if (base && current && base.oid !== current.oid) {
        if (base.type === "tree" && current.type === "tree") {
          const sub = await this.diff2({ baseTreeOid: base.oid, currentTreeOid: current.oid, pathPrefix: path });
          result.push(...sub);
        } else if (base.type === "blob" && current.type === "blob") {
          result.push({ status: "modified", path, baseOid: base.oid, currentOid: current.oid });
        } else {
          if (base.type === "blob") {
            result.push({ status: "removed", path, oid: base.oid });
          }
          if (current.type === "blob") {
            result.push({ status: "added", path, oid: current.oid });
          }
        }
      }
    }

    return result;
  }

  private async getEmptyTreeOid(): Promise<string> {
    if (!this.emptyTreeOid) {
      this.emptyTreeOid = GIT_EMPTY_TREE_OID;
      this.treeStore.set(this.emptyTreeOid, {});
    }
    return this.emptyTreeOid;
  }

  async walk({
    oid,
    path = "",
    callback,
  }: {
    oid: string;
    path?: string;
    callback: (entry: {
      oid: string;
      path: string;
      type: "blob" | "tree";
    }) => Promise<void>;
  }) {
    const tree = await this.getTree(oid);
    if (!tree) return;
    for (const [name, entry] of Object.entries(tree)) {
      const fullPath = path ? `${path}/${name}` : name;
      if (entry.type === "tree") {
        await this.walk({ oid: entry.oid, path: fullPath, callback });
      } else {
        await callback({
          oid: String(entry.oid),
          path: String(fullPath),
          type: "blob",
        });
      }
    }
  }

  async entriesFromTree({ oid }: { oid: string }) {
    const entries: { oid: string; path: string; type: "blob" | "tree" }[] = [];
    await this.walk({
      oid,
      callback: async (entry) => {
        entries.push({ oid: entry.oid, path: entry.path, type: entry.type });
      },
    });
    return entries;
  }

  /** Blob paths that differ from the parent commit tree (for GitHub `base_tree` push). */
  async diffBlobPathsForPush(args: {
    baseTreeOid: string | null;
    treeOid: string;
  }): Promise<{ path: string; oid: string; type: "blob" | "tree" }[]> {
    const childBlobs = (await this.entriesFromTree({ oid: args.treeOid })).filter(
      (e) => e.type === "blob",
    );
    if (!args.baseTreeOid) {
      return childBlobs;
    }
    const parentBlobs = (
      await this.entriesFromTree({ oid: args.baseTreeOid })
    ).filter((e) => e.type === "blob");
    const parentByPath = new Map(parentBlobs.map((e) => [e.path, e.oid]));
    return childBlobs.filter((e) => parentByPath.get(e.path) !== e.oid);
  }

  private async buildConflictValue(args: {
    path: string;
    oursOid: string | undefined;
    theirsOid: string | undefined;
  }): Promise<string> {
    const oursContent =
      args.oursOid != null
        ? ((await this.gitable.getBlob(args.oursOid))?.content ??
          "(unable to load)")
        : "(deleted)";
    const theirsContent =
      args.theirsOid != null
        ? ((await this.gitable.getBlob(args.theirsOid))?.content ??
          "(unable to load)")
        : "(deleted)";
    return `<<<<<<< ours\n${oursContent}\n=======\n${theirsContent}\n>>>>>>> theirs`;
  }

  async diffTrees(args: {
    baseTreeOid: string;
    oursTreeOid: string;
    theirsTreeOid: string;
    pathPrefix?: string;
    newBlobs?: NewBlob[];
  }): Promise<DiffTreesResult> {
    const {
      baseTreeOid,
      oursTreeOid,
      theirsTreeOid,
      pathPrefix = "",
      newBlobs: newBlobsArg,
    } = args;
    const newBlobs = newBlobsArg ?? [];

    if (baseTreeOid === oursTreeOid && oursTreeOid === theirsTreeOid) {
      return {
        entries: [],
        conflicts: [],
        trees: { rootOid: oursTreeOid, trees: [oursTreeOid] },
        newBlobs: [],
      };
    }

    const baseEntries = (await this.getTree(baseTreeOid)) ?? {};
    const oursEntries = (await this.getTree(oursTreeOid)) ?? {};
    const theirsEntries = (await this.getTree(theirsTreeOid)) ?? {};

    const allNames = new Set([
      ...Object.keys(baseEntries),
      ...Object.keys(oursEntries),
      ...Object.keys(theirsEntries),
    ]);

    const entries: DiffEntry[] = [];
    const conflicts: DiffTreesConflict[] = [];

    for (const name of allNames) {
      const baseEntry = baseEntries[name];
      const oursEntry = oursEntries[name];
      const theirsEntry = theirsEntries[name];
      const path = pathPrefix ? `${pathPrefix}${name}` : name;

      const baseOid = baseEntry?.oid;
      const oursOid = oursEntry?.oid;
      const theirsOid = theirsEntry?.oid;

      if (
        baseOid !== undefined &&
        oursOid === baseOid &&
        theirsOid === baseOid
      ) {
        continue;
      }

      const anyIsTree =
        baseEntry?.type === "tree" ||
        oursEntry?.type === "tree" ||
        theirsEntry?.type === "tree";

      if (anyIsTree) {
        const emptyOid = await this.getEmptyTreeOid();
        const subResult = await this.diffTrees({
          baseTreeOid: baseEntry?.type === "tree" ? baseEntry.oid : emptyOid,
          oursTreeOid: oursEntry?.type === "tree" ? oursEntry.oid : emptyOid,
          theirsTreeOid: theirsEntry?.type === "tree" ? theirsEntry.oid : emptyOid,
          pathPrefix: `${path}/`,
          newBlobs,
        });
        entries.push(...subResult.entries);
        conflicts.push(...subResult.conflicts);
        continue;
      }

      const inBase = baseOid !== undefined;
      const inOurs = oursOid !== undefined;
      const inTheirs = theirsOid !== undefined;

      if (
        !inBase &&
        inOurs &&
        inTheirs &&
        oursOid !== theirsOid &&
        theirsOid !== undefined
      ) {
        entries.push({ status: "added", path, theirsOid });
        conflicts.push({
          path,
          oursOid,
          theirsOid,
          message: `Merge conflict (add-add): both sides added "${path}" with different content`,
          value: await this.buildConflictValue({
            path,
            oursOid,
            theirsOid,
          }),
        });
        continue;
      }
      if (inBase && inOurs !== inTheirs) {
        if (inOurs && oursOid !== undefined) {
          entries.push({ status: "removed", path, oursOid });
        } else if (inTheirs && theirsOid !== undefined) {
          entries.push({ status: "added", path, theirsOid });
        }
        conflicts.push({
          path,
          oursOid,
          theirsOid,
          message: `Merge conflict (modify-delete): "${path}" was ${inOurs ? "modified on ours and deleted on theirs" : "deleted on ours and modified on theirs"}`,
          value: await this.buildConflictValue({
            path,
            oursOid,
            theirsOid,
          }),
        });
        continue;
      }
      if (
        inBase &&
        inOurs &&
        inTheirs &&
        oursOid !== baseOid &&
        theirsOid !== baseOid &&
        oursOid !== theirsOid &&
        baseOid !== undefined &&
        oursOid !== undefined &&
        theirsOid !== undefined
      ) {
        const contentMerge = await tryContentMerge({
          path,
          baseOid,
          oursOid,
          theirsOid,
          getBlob: (oid) => this.gitable.getBlob(oid),
        });
        if (contentMerge.status === "identical") {
          entries.push({
            status: "modified",
            path,
            oursOid,
            theirsOid,
            oid: contentMerge.oid,
          });
          continue;
        }
        if (contentMerge.status === "merged") {
          const mergedOid = await calculateBlobOid(contentMerge.content);
          entries.push({
            status: "modified",
            path,
            oursOid,
            theirsOid,
            oid: mergedOid,
          });
          newBlobs.push({
            path,
            oid: mergedOid,
            content: contentMerge.content,
          });
          continue;
        }
        entries.push({
          status: "modified",
          path,
          oursOid,
          theirsOid,
          oid: oursOid,
        });
        conflicts.push({
          path,
          oursOid,
          theirsOid,
          message: `Merge conflict (both modified): both sides modified "${path}"`,
          value: await this.buildConflictValue({
            path,
            oursOid,
            theirsOid,
          }),
        });
        continue;
      }

      if (!inOurs && inTheirs && theirsOid !== undefined) {
        entries.push({ status: "added", path, theirsOid });
      } else if (inBase && inOurs && !inTheirs && oursOid !== undefined) {
        entries.push({ status: "removed", path, oursOid });
      } else if (
        inOurs &&
        inTheirs &&
        oursOid !== undefined &&
        theirsOid !== undefined &&
        baseOid !== undefined &&
        oursOid !== theirsOid
      ) {
        const oid = oursOid !== baseOid ? oursOid : theirsOid;
        entries.push({
          status: "modified",
          path,
          oursOid,
          theirsOid,
          oid,
        });
      }
    }

    if (pathPrefix === "") {
      const baseOid = oursTreeOid ?? (await this.getEmptyTreeOid());
      const newTreeOids: string[] = [];
      const rootOid = await this.applyDiffToTree(
        baseOid,
        entries,
        "",
        newTreeOids,
      );
      return {
        entries,
        conflicts,
        trees: { rootOid, trees: newTreeOids },
        newBlobs: newBlobs ?? [],
      };
    }

    return {
      entries,
      conflicts,
      trees: { rootOid: oursTreeOid, trees: [oursTreeOid] },
      newBlobs: [],
    };
  }

  private async applyDiffToTree(
    oursTreeOid: string,
    diffEntries: DiffEntry[],
    pathPrefix: string,
    newTreeOids: string[],
  ): Promise<string> {
    const ours = (await this.getTree(oursTreeOid)) ?? {};
    const result: TreeEntries = { ...ours };

    const relPath = (p: string) =>
      pathPrefix ? p.slice(pathPrefix.length + 1) : p;
    const fullPath = (name: string) =>
      pathPrefix ? `${pathPrefix}/${name}` : name;

    for (const entry of diffEntries) {
      const isUnder = pathPrefix
        ? entry.path.startsWith(`${pathPrefix}/`) || entry.path === pathPrefix
        : true;
      if (!isUnder) continue;

      const rel = relPath(entry.path);
      const segments = rel.split("/");
      const name = segments[0];
      if (segments.length === 1) {
        if (entry.status === "removed") delete result[name];
        else if (entry.status === "added") {
          result[name] = { type: "blob", oid: entry.theirsOid };
        } else if (entry.status === "modified") {
          result[name] = { type: "blob", oid: entry.oid };
        }
      }
    }

    const toRecurse = new Set<string>();
    for (const entry of diffEntries) {
      const rel = relPath(entry.path);
      const segs = rel.split("/");
      if (segs.length > 1) toRecurse.add(segs[0]);
    }
    for (const name of Object.keys(ours)) {
      if (ours[name]?.type === "tree") toRecurse.add(name);
    }

    for (const name of toRecurse) {
      const childFullPath = fullPath(name);
      const oursChild = ours[name];
      const oursChildOid = oursChild?.type === "tree" ? oursChild.oid : null;
      const baseOid = oursChildOid ?? (await this.getEmptyTreeOid());
      const subEntries = diffEntries.filter(
        (e) =>
          e.path === childFullPath || e.path.startsWith(`${childFullPath}/`),
      );
      const oid = await this.applyDiffToTree(
        baseOid,
        subEntries,
        childFullPath,
        newTreeOids,
      );
      result[name] = { type: "tree", oid };
    }

    const oid = await calculateTreeOid(result);
    this.treeStore.set(oid, result);
    newTreeOids.push(oid);
    return oid;
  }

  async applyEntriesToTree({
    rootTreeOid,
    entries,
  }: {
    rootTreeOid: string;
    entries: { oid: string; path: string }[];
  }): Promise<ApplyTreesResult> {
    /** `trees` in the result lists only **new** oids (leaf, ancestors, optional empty dir). */
    let rootOid = rootTreeOid;
    const newOids: string[] = [];

    for (const entry of entries) {
      const segments = entry.path.split("/");
      const fileName = segments[segments.length - 1];
      const dirs = segments.slice(0, -1);

      const chain: { oid: string; name: string }[] = [];
      let treeOid = rootOid;
      for (const name of dirs) {
        const tree = await this.getTree(treeOid);
        if (!tree) {
          throw new Error(
            `Tree not found while applying entry "${entry.path}" at "${name}" (${treeOid})`,
          );
        }

        const child = tree[name];
        if (child && child.type === "tree") {
          chain.push({ oid: treeOid, name });
          treeOid = child.oid;
        } else {
          const emptyOid = GIT_EMPTY_TREE_OID;
          if (!this.treeStore.has(emptyOid)) {
            this.treeStore.set(emptyOid, {});
          }
          newOids.push(emptyOid);
          chain.push({ oid: treeOid, name });
          treeOid = emptyOid;
        }
      }

      const leaf = await this.getTree(treeOid);
      if (!leaf) {
        throw new Error(
          `Tree not found while applying entry "${entry.path}" (${treeOid})`,
        );
      }
      const updated = {
        ...leaf,
        [fileName]: { type: "blob" as const, oid: entry.oid },
      };
      let newOid = await calculateTreeOid(updated);
      this.treeStore.set(newOid, updated);
      newOids.push(newOid);

      for (let i = chain.length - 1; i >= 0; i--) {
        const { oid: parentOid, name } = chain[i];
        const parent = this.treeStore.get(parentOid);
        if (!parent) throw new Error(`Parent not found: ${parentOid}`);
        const updatedParent = {
          ...parent,
          [name]: { type: "tree" as const, oid: newOid },
        };
        newOid = await calculateTreeOid(updatedParent);
        this.treeStore.set(newOid, updatedParent);
        newOids.push(newOid);
      }
      rootOid = newOid;
    }

    return { rootOid, trees: newOids };
  }

  async findMergeBase(args: {
    oursOid: string;
    theirsOid: string;
  }): Promise<CommitNode | null> {
    const { oursOid, theirsOid } = args;
    const getCommit = (oid: string) => this.gitable.getCommit(oid);

    if (oursOid === theirsOid) {
      return getCommit(oursOid);
    }

    const commitCache = new Map<string, CommitNode>();
    const getCached = async (oid: string): Promise<CommitNode | null> => {
      const cached = commitCache.get(oid);
      if (cached) return cached;
      const commit = await getCommit(oid);
      if (commit) commitCache.set(oid, commit);
      return commit;
    };

    const oursAncestors = new Set<string>([oursOid]);
    const theirsAncestors = new Set<string>([theirsOid]);
    const oursQueue: string[] = [oursOid];
    const theirsQueue: string[] = [theirsOid];
    const commonAncestors = new Set<string>();

    const maxIterations = 1000;
    let iterations = 0;

    while (
      (oursQueue.length > 0 || theirsQueue.length > 0) &&
      iterations < maxIterations
    ) {
      iterations++;

      if (oursQueue.length > 0) {
        const current = oursQueue.shift()!;
        if (theirsAncestors.has(current)) {
          commonAncestors.add(current);
          continue;
        }
        const commit = await getCached(current);
        if (commit) {
          for (const p of [commit.parent, commit.secondParent]) {
            if (p && !oursAncestors.has(p)) {
              oursAncestors.add(p);
              oursQueue.push(p);
            }
          }
        }
      }

      if (theirsQueue.length > 0) {
        const current = theirsQueue.shift()!;
        if (oursAncestors.has(current)) {
          commonAncestors.add(current);
          continue;
        }
        const commit = await getCached(current);
        if (commit) {
          for (const p of [commit.parent, commit.secondParent]) {
            if (p && !theirsAncestors.has(p)) {
              theirsAncestors.add(p);
              theirsQueue.push(p);
            }
          }
        }
      }
    }

    if (commonAncestors.size === 0) return null;

    const candidates = Array.from(commonAncestors);
    if (candidates.length === 1) return getCommit(candidates[0]);

    const best = this.filterToBestMergeBases(candidates, commitCache);
    return getCommit(best[0]);
  }

  private filterToBestMergeBases(
    candidates: string[],
    commitCache: Map<string, CommitNode>,
  ): string[] {
    if (candidates.length <= 1) return candidates;

    const candidateSet = new Set(candidates);
    const dominated = new Set<string>();

    for (const candidate of candidates) {
      if (dominated.has(candidate)) continue;
      for (const other of candidates) {
        if (candidate === other || dominated.has(other)) continue;
        if (
          this.isReachableViaParents(
            candidate,
            other,
            candidateSet,
            commitCache,
          )
        ) {
          dominated.add(candidate);
          break;
        }
      }
    }

    return candidates.filter((c) => !dominated.has(c));
  }

  private isReachableViaParents(
    target: string,
    start: string,
    stopAtCandidates: Set<string>,
    commitCache: Map<string, CommitNode>,
  ): boolean {
    if (target === start) return false;

    const visited = new Set<string>();
    const queue: Array<[string, number]> = [];
    const maxDepth = 100;

    const startCommit = commitCache.get(start);
    if (!startCommit) return false;

    if (startCommit.parent) queue.push([startCommit.parent, 1]);
    if (startCommit.secondParent) queue.push([startCommit.secondParent, 1]);

    while (queue.length > 0) {
      const [current, depth] = queue.shift()!;

      if (current === target) return true;
      if (visited.has(current) || depth > maxDepth) continue;
      visited.add(current);

      if (stopAtCandidates.has(current)) continue;

      const commit = commitCache.get(current);
      if (commit) {
        if (commit.parent) queue.push([commit.parent, depth + 1]);
        if (commit.secondParent) queue.push([commit.secondParent, depth + 1]);
      }
    }

    return false;
  }
}
