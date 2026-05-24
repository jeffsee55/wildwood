import {
  calculateBlobOid,
  calculateBlobOidFromBytes,
  calculateCommitOid,
  type Gitable,
  type TreeEntries,
  Trees,
} from "tr33-store";
import type { Config, ConfigInput } from "@/client/config";
import { type PrInput, type Remote, resolvePrField } from "@/git/remote";
import { isMissingSchemaError, type LibsqlDatabase } from "@/sqlite/database";
import {
  type Commit,
  type FindWorktreeEntriesArgs,
  type Worktree,
  worktreeSchema,
} from "@/types";
import { formatZodErrorForUser } from "@/zod/format-zod-for-user";

export class Git implements Gitable {
  config: Config<ConfigInput>;
  db: LibsqlDatabase;
  remote: Remote;
  blobStore = new Map<string, string>();
  trees: Trees;

  constructor(args: {
    config: Config<ConfigInput>;
    remote: Remote;
    db: LibsqlDatabase;
  }) {
    this.config = args.config;
    this.db = args.db;
    this.remote = args.remote;
    this.trees = new Trees({ gitable: this });
  }

  // --- Gitable implementation (db + remote, no treeStore) ---

  get paths(): string[] {
    return this.config.paths;
  }

  async getTree(oid: string): Promise<TreeEntries | null> {
    return (
      (await this.db.trees.get({ oid })) ??
      (await this.remote.fetchTree({ oid })) ??
      null
    );
  }

  async getBlob(oid: string): Promise<{ oid: string; content: string } | null> {
    const blobs = await this.db.blobs.batchGet({ oids: [oid] });
    if (blobs.length > 0) {
      return { oid: blobs[0].oid, content: blobs[0].content };
    }
    const fromRemote = await this.remote.fetchBlobs({ oids: [oid] });
    if (fromRemote.length > 0) {
      return fromRemote[0];
    }
    return null;
  }

  async getCommit(oid: string): Promise<Commit | null> {
    const fromDb = await this.db.commits.get({ oid });
    if (fromDb) return fromDb;
    try {
      return await this.remote.fetchCommit({ oid });
    } catch {
      return null;
    }
  }

  // --- Core operations ---

  async createBranch({ name, base }: { name: string; base: string }) {
    const baseRef = await this.db.refs.get({ ref: base });
    if (!baseRef) {
      await this.switch({ ref: base });
    }
    const refData = await this.db.refs.get({ ref: base });
    if (!refData) throw new Error(`Base ref "${base}" not found`);
    await this.db.refs.updateCommit({ ref: name, commit: refData.commit });
    if (refData.rootTree) {
      await this.db.refs.setTreeOid({
        ref: name,
        treeOid: refData.rootTree.oid,
      });
      const v = refData.versions;
      if (v != null && v.length > 0) {
        await this.db.refs.updateVersions({ ref: name, versions: v });
      }
    }
    await this.switch({ ref: name });
  }

  async switch(args: { ref: string }) {
    const worktree = await this.db.refs.get({
      ref: args.ref,
    });
    if (worktree?.rootTree) {
      const rootTreeOid = String(worktree.rootTree.oid);
      await this.writeEntries({
        ref: args.ref,
        entries: await this.trees.entriesFromTree({
          oid: rootTreeOid,
        }),
      });
      const prev = worktree.versions ?? [];
      const versions = prev.includes(this.config.version)
        ? prev
        : [...prev, this.config.version];
      await this.db.refs.updateVersions({
        ref: args.ref,
        versions,
      });
      return;
    }
    let commit: Commit;
    if (worktree?.commit) {
      commit = worktree.commit;
    } else {
      const remoteCommit = await this.remote.fetchCommit({
        ref: args.ref,
      });
      commit = remoteCommit;
    }

    await this.db.refs.updateRemoteCommit({
      ref: args.ref,
      commit,
    });
    await this.db.commits.put(commit);
    await this.db.commits.markPushed({ oid: commit.oid });

    await this.writeEntries({
      ref: args.ref,
      entries: await this.trees.entriesFromTree({
        oid: commit.treeOid,
      }),
    });
    await this.db.refs.setTreeOid({
      ref: args.ref,
      treeOid: commit.treeOid,
    });
    const indexed = await this.db.refs.get({ ref: args.ref });
    const prev = indexed?.versions ?? [];
    const versions = prev.includes(this.config.version)
      ? prev
      : [...prev, this.config.version];
    await this.db.refs.updateVersions({
      ref: args.ref,
      versions,
    });
  }

  async add({
    ref,
    files,
  }: {
    ref: string;
    files: Record<string, string | Uint8Array>;
  }): Promise<void> {
    const entries: { oid: string; path: string; content: string }[] = [];
    const textEntries: { oid: string; path: string }[] = [];
    const blobsToPersist: { oid: string; content: string }[] = [];

    for (const [path, content] of Object.entries(files)) {
      const isBinary = content instanceof Uint8Array;
      const oid = isBinary
        ? await calculateBlobOidFromBytes(content)
        : await calculateBlobOid(content);
      const tracked = this.config.matches(path);

      if (tracked && !isBinary) {
        entries.push({ oid, path, content });
        textEntries.push({ oid, path });
        this.blobStore.set(oid, content);
        blobsToPersist.push({ oid, content });
      } else {
        await this.remote.createBlob({
          content: isBinary ? content : new TextEncoder().encode(content),
        });
        entries.push({ oid, path, content: isBinary ? "" : content });
        if (!isBinary) {
          this.blobStore.set(oid, content);
          textEntries.push({ oid, path });
        }
      }
    }

    if (blobsToPersist.length > 0) {
      await this.db.blobs.batchPut(blobsToPersist);
    }

    const worktree = await this.db.refs.get({ ref });
    if (!worktree) {
      await this.switch({ ref });
      return this.add({ ref, files });
    }

    const rootTreeOid = worktree.rootTree?.oid || worktree.commit?.treeOid;
    if (!rootTreeOid) {
      throw new Error(`No root tree OID found for ${ref}`);
    }

    const trees = await this.trees.applyEntriesToTree({
      rootTreeOid,
      entries,
    });

    await this.writeEntries({ ref, entries: textEntries });
    await this.ensureTrees({ ref, trees });
  }

  async findMany(
    args: FindWorktreeEntriesArgs,
    { retrying = false }: { retrying?: boolean } = {},
  ): Promise<{
    collection: string;
    commitOid: string;
    items: ReturnType<Config<ConfigInput>["buildEntry"]>[];
  }> {
    const { where, ...rest } = args;
    try {
      const ref = args.ref || this.config.ref;

      const result = (await this.db.refs.findFirst({
        where: {
          ...(where || {}),
        },
        ...rest,
      })) as Worktree;

      if (!result && !retrying) {
        await this.switch({ ref });
        return this.findMany(args, { retrying: true });
      }

      if (!result) {
        return {
          collection: args.collection,
          commitOid: "abv",
          items: [],
        };
      }
      if (result.rootTree && !retrying) {
        if (!result.versions?.includes(this.config.version)) {
          await this.switch({ ref });
          return this.findMany(args, { retrying: true });
        }
      }

      const parsed = worktreeSchema.safeParse(result);
      if (!parsed.success) {
        throw new Error(formatZodErrorForUser(parsed.error, "worktree"));
      }
      const parsedResult = parsed.data;
      const items = [];
      for (const entry of parsedResult.entries) {
        items.push(this.config.buildEntry(entry, false));
      }
      return {
        collection: args.collection,
        commitOid: result.commitOid,
        items,
      };
    } catch (e) {
      if (!retrying && isMissingSchemaError(e)) {
        await this.db.init();
        return this.findMany(args, { retrying: true });
      }
      throw e;
    }
  }

  async writeEntries(args: {
    ref: string;
    entries: { oid: string; path: string }[];
  }) {
    const entries = args.entries
      .map((e) => ({ oid: String(e.oid), path: String(e.path) }))
      .filter((e) => this.config.matches(e.path));
    await this.ensureBlobs({ oids: entries.map((e) => e.oid) });
    const chunks = await this.chunkBlobs({
      blobs: Array.from(entries),
      size: 2,
    });
    const cache = this.createCache();
    for (const chunk of chunks) {
      const blobs = await this.db.blobs.batchGet({
        oids: chunk.map((b) => b.oid),
      });
      const blobMap = blobs.reduce(
        (acc, blob) => {
          acc[blob.oid] = blob.content;
          return acc;
        },
        {} as Record<string, string>,
      );
      for (const { oid, path } of chunk) {
        const content = blobMap[oid];
        if (content) {
          const indexed = await this.config.index(
            {
              oid,
              content,
              path,
              ref: args.ref,
            },
            cache,
          );
          if (!indexed.indexed) {
            // skipped
          }
        }
      }
    }
    await this.db.writeCache({ status: "dirty", cache });
  }

  async commit(args: {
    ref: string;
    commit: Omit<
      Commit,
      "oid" | "treeOid" | "parent" | "secondParent" | "committer" | "author"
    > & {
      author: { name: string; email: string };
      committer?: { name: string; email: string };
    };
  }) {
    const ref = await this.db.refs.get({ ref: args.ref });
    const now = Math.floor(Date.now() / 1000);
    const timezoneOffset = 0;
    const treeOid = ref?.rootTree?.oid;
    if (!treeOid) {
      throw new Error(`No tree OID found for ${args.ref}`);
    }
    const { author, committer } = args.commit;
    const commit = await this.db.commits.put({
      treeOid,
      message: args.commit.message,
      parent: ref?.commit.oid ?? null,
      secondParent: null,
      oid: null,
      author: {
        name: author.name,
        email: author.email,
        timestamp: now,
        timezoneOffset,
      },
      committer: {
        name: committer?.name ?? author.name,
        email: committer?.email ?? author.email,
        timestamp: now,
        timezoneOffset,
      },
    });

    await this.db.refs.updateCommit({
      ref: args.ref,
      commit,
    });

    return commit;
  }

  async discard({ ref }: { ref: string }) {
    const refData = await this.db.refs.get({ ref });
    if (!refData) {
      throw new Error(`No ref found for ${ref}`);
    }
    await this.db.refs.setTreeOid({ ref, treeOid: refData.commit.treeOid });
  }

  async push({ ref, pr }: { ref: string; pr?: PrInput }) {
    const refData = await this.db.refs.get({ ref });
    if (!refData) {
      throw new Error(`No ref found for ${ref}`);
    }

    const unpushedCommits: Commit[] = [];
    const visited = new Set<string>();

    const collectUnpushed = async (commit: Commit) => {
      if (visited.has(commit.oid)) return;
      visited.add(commit.oid);
      const raw = await this.db.commits.getRaw({ oid: commit.oid });
      if (raw?.pushedAt) return;

      for (const parentOid of [commit.parent, commit.secondParent]) {
        if (parentOid && !visited.has(parentOid)) {
          const parentCommit = await this.db.commits.get({ oid: parentOid });
          if (parentCommit) await collectUnpushed(parentCommit);
        }
      }
      unpushedCommits.push(commit);
    };
    await collectUnpushed(refData.commit);

    if (unpushedCommits.length === 0) {
      throw new Error("No unpushed commits found");
    }

    const pushTrees: {
      oid: string;
      entries: Record<string, { type: "blob" | "tree"; oid: string }>;
    }[] = [];
    const blobOids = new Set<string>();
    const collectedTreeOids = new Set<string>();

    const collectTree = async (oid: string, path: string) => {
      if (collectedTreeOids.has(oid)) return;
      collectedTreeOids.add(oid);

      const entries = await this.trees.getTree(oid);
      if (!entries) {
        throw new Error(
          `Tree ${oid} not found in local DB at "${path}" — cannot push without all trees locally`,
        );
      }
      pushTrees.push({ oid, entries });
      for (const [name, entry] of Object.entries(entries)) {
        const childPath = path ? `${path}/${name}` : name;
        if (entry.type === "tree") {
          await collectTree(entry.oid, childPath);
        } else {
          blobOids.add(entry.oid);
        }
      }
    };

    for (const commit of unpushedCommits) {
      await collectTree(commit.treeOid, "");
    }

    // Only push blobs we have locally (DB or in-memory store).
    // Blobs not found locally were either written directly to the remote
    // via createBlob() (binary/untracked files) or already exist in the
    // remote's history — no need to re-upload them.
    const dbBlobs = await this.db.blobs.batchGet({
      oids: [...blobOids],
    });
    const dbBlobMap = new Map(dbBlobs.map((b) => [b.oid, b.content]));
    const blobs: { oid: string; content: string }[] = [];
    for (const oid of blobOids) {
      const content = dbBlobMap.get(oid) ?? this.blobStore.get(oid);
      if (content !== undefined) {
        blobs.push({ oid, content });
      }
    }

    pushTrees.reverse();

    const result = await this.remote.push({
      ref,
      commits: unpushedCommits,
      blobs,
      trees: pushTrees,
    });

    await this.db.refs.setRemoteCommitOid({
      ref,
      remoteCommitOid: result.commitOid,
    });
    for (const commit of unpushedCommits) {
      await this.db.commits.markPushed({ oid: commit.oid });
    }

    if (pr && ref !== this.config.ref) {
      const existing = await this.remote.findPr({
        head: ref,
        base: this.config.ref,
      });
      if (existing) {
        const title = resolvePrField(pr.title, existing.title);
        const body = resolvePrField(pr.body, existing.body);
        const labels = pr.labels
          ? resolvePrField(pr.labels, existing.labels)
          : undefined;
        result.pr = await this.remote.updatePr({
          pr: existing.number,
          title,
          body,
          labels,
        });
      } else {
        const title = resolvePrField(pr.title, "");
        const body = resolvePrField(pr.body, "");
        const labels = pr.labels ? resolvePrField(pr.labels, []) : undefined;
        result.pr = await this.remote.createPr({
          head: ref,
          base: this.config.ref,
          title,
          body,
          labels,
        });
      }
    }

    return result;
  }

  async pull({ ref }: { ref: string }) {
    return this.merge({ ours: ref, theirs: `origin/${ref}` });
  }

  async merge({
    ours,
    theirs,
    message: messageOverride,
  }: {
    ours: string;
    theirs: string;
    message?: string;
  }): Promise<
    | { type: "success"; commit: Commit }
    | { type: "conflict"; diff: import("tr33-store").DiffTreesResult }
  > {
    const ourCommit = await this.resolveCommit({ ref: ours });
    const theirCommit = await this.resolveCommit({ ref: theirs });
    if (!ourCommit) {
      throw new Error(`Commit not found for ${ours}`);
    }
    if (!theirCommit) {
      throw new Error(`Commit not found for ${theirs}`);
    }
    const mergeBase = await this.trees.findMergeBase({
      oursOid: ourCommit.oid,
      theirsOid: theirCommit.oid,
    });
    if (!mergeBase) {
      throw new Error(`No merge base found for ${ours} and ${theirs}`);
    }

    const diff = await this.trees.diffTrees({
      baseTreeOid: mergeBase.treeOid,
      oursTreeOid: ourCommit.treeOid,
      theirsTreeOid: theirCommit.treeOid,
    });
    if (diff.conflicts.length > 0) {
      return { type: "conflict", diff };
    }
    await this.ensureTrees({
      ref: ours,
      trees: diff.trees,
    });
    for (const b of diff.newBlobs) {
      this.blobStore.set(b.oid, b.content);
    }
    const entries = await this.trees.entriesFromTree({
      oid: diff.trees.rootOid,
    });
    await this.writeEntries({
      ref: ours,
      entries,
    });

    const commitPayload = {
      treeOid: diff.trees.rootOid,
      message: messageOverride?.trim() || `Merge "${theirs}" into "${ours}"`,
      parent: ourCommit.oid,
      secondParent: theirCommit.oid,
      author: ourCommit.author,
      committer: ourCommit.committer,
    };
    const commitOid = await calculateCommitOid(commitPayload);
    await this.db.commits.put({
      ...commitPayload,
      oid: commitOid,
    });
    return { type: "success", commit: { ...commitPayload, oid: commitOid } };
  }

  // --- Helpers ---

  createCache() {
    return {
      filters: [],
      entries: [],
      connections: [],
    };
  }

  async chunkBlobs({
    blobs,
    size = 1000,
  }: {
    blobs: { oid: string; path: string }[];
    size?: number;
  }) {
    const chunks = [];
    for (let i = 0; i < blobs.length; i += size) {
      chunks.push(blobs.slice(i, i + size));
    }
    return chunks;
  }

  async ensureTrees(args: {
    ref: string;
    trees: import("tr33-store").ApplyTreesResult;
  }) {
    const treesToSave: {
      oid: string;
      entries: Record<string, { type: "blob" | "tree"; oid: string }>;
    }[] = [];
    await Promise.all(
      args.trees.trees.map(async (oid) => {
        const tree = await this.trees.getTree(oid);
        if (tree) {
          treesToSave.push({ oid, entries: tree });
        }
      }),
    );
    await this.db.trees.batchPut(treesToSave);
    await this.db.refs.setTreeOid({
      ref: args.ref,
      treeOid: args.trees.rootOid,
    });
    await this.db.refs.updateVersions({
      ref: args.ref,
      versions: [this.config.version],
    });
  }

  async ensureBlobs({ oids }: { oids: string[] }) {
    const dbBlobs = await this.db.blobs.batchGet({
      oids,
    });
    const blobsToGetFromRemote = oids.filter((oid) => {
      const localBlob = this.blobStore.get(oid);
      if (localBlob) return false;
      const dbBlob = dbBlobs.find((b) => b.oid === oid);
      if (dbBlob) return false;
      return true;
    });
    const blobsFromRemote = await this.remote.fetchBlobs({
      oids: blobsToGetFromRemote,
    });
    const blobsToSave: { oid: string; content: string }[] = [];
    for (const oid of oids) {
      const localBlob = this.blobStore.get(oid);
      if (localBlob) blobsToSave.push({ oid, content: localBlob });
      const remoteBlob = blobsFromRemote.find((b) => b.oid === oid);
      if (remoteBlob) blobsToSave.push({ oid, content: remoteBlob.content });
    }
    // `_blobs` is keyed by (org, repo, oid). `batchGet` is oid-only, so it may
    // find a row from a *previous* org/repo. We skipped the remote, but
    // `batchPut` must still materialize a row for the *current* namespace;
    // otherwise `writeEntries` can index `entries` with no join target (blob is null).
    for (const oid of oids) {
      if (blobsToSave.some((b) => b.oid === oid)) {
        continue;
      }
      const fromOtherNamespace = dbBlobs.find((b) => b.oid === oid);
      if (fromOtherNamespace) {
        blobsToSave.push({ oid, content: fromOtherNamespace.content });
      }
    }

    await this.db.blobs.batchPut(blobsToSave);
  }

  async resolveCommit(args: { oid: string } | { ref: string }) {
    let oid: string;
    if ("ref" in args) {
      if (args.ref.startsWith("origin/")) {
        const remoteCommit = await this.remote.fetchCommit({
          ref: args.ref.slice(7),
        });
        if (remoteCommit) {
          oid = remoteCommit.oid;
        } else {
          throw new Error(`Commit not found for ${args.ref}`);
        }
      } else {
        const ref = await this.db.refs.get({ ref: args.ref });
        if (ref) {
          oid = ref.commit.oid;
        } else {
          const remoteCommit = await this.remote.fetchCommit({ ref: args.ref });
          if (remoteCommit) {
            oid = remoteCommit.oid;
          } else {
            throw new Error(`Commit not found for ${args.ref}`);
          }
        }
      }
    } else {
      oid = args.oid;
    }

    return this.getCommit(oid);
  }
}
