import {
  calculateBlobOid,
  calculateBlobOidFromBytes,
  calculateCommitOid,
  type Gitable,
  type TreeEntries,
  Trees,
} from "tr33-store";
import type { Config } from "@/client/config";
import { type PrInput, type Remote, resolvePrField } from "@/git/remote";
import { isMissingSchemaError, type LibsqlDatabase } from "@/sqlite/database";
import {
  type Commit,
  type FindWorktreeEntriesArgs,
  type Worktree,
  worktreeSchema,
} from "@/types";
import { formatZodErrorForUser } from "@/zod/format-zod-for-user";

export type GitAddResult = {
  files: Record<string, string>;
  rootTreeOid: string;
};

function gitAddTimer(ref: string, onProgress?: (message: string) => void) {
  const started = Date.now();
  let stepAt = started;
  return (step: string) => {
    const now = Date.now();
    console.info(
      `[tr33:git-add] ref=${ref} ${step} +${now - stepAt}ms (${now - started}ms total)`,
    );
    onProgress?.(step);
    stepAt = now;
  };
}

export class Git implements Gitable {
  config: Config;
  db: LibsqlDatabase;
  remote: Remote;
  blobStore = new Map<string, string>();
  trees: Trees;

  constructor(args: {
    config: Config;
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
    const treeOid = String(oid);
    // Cold treeStore cache first (Trees.persistTree writes here when putTree absent).
    // This covers empty-tree OID and intermediate new dirs created by applyEntriesToTree
    // before they are flushed via ensureTrees/batchPut.
    const fromMem = this.trees.treeStore.get(treeOid) as TreeEntries | undefined;
    if (fromMem !== undefined) return fromMem;
    const fromDb = await this.db.trees.get({ oid: treeOid });
    if (fromDb && Object.keys(fromDb).length > 0) {
      this.trees.treeStore.set(treeOid, fromDb as TreeEntries);
      return fromDb;
    }
    const fromRemote = await this.remote.fetchTree({ oid: treeOid });
    if (fromRemote && Object.keys(fromRemote).length > 0) {
      await this.db.trees.batchPut([{ oid: treeOid, entries: fromRemote }]);
      this.trees.treeStore.set(treeOid, fromRemote as TreeEntries);
      return fromRemote;
    }
    return null;
  }

  async getBlob(oid: string): Promise<{ oid: string; content: string } | null> {
    const blobs = await this.db.blobs.batchGet({ oids: [oid] });
    if (blobs.length > 0) {
      return { oid: blobs[0].oid, content: blobs[0].content };
    }
    const fromRemote = await this.remote.fetchBlobs({ oids: [oid] });
    if (fromRemote.length > 0) {
      await this.db.blobs.batchPut(fromRemote);
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
    const started = Date.now();
    await this.ensureRefInDb({ ref: base });
    const refData = await this.db.refs.get({ ref: base });
    if (!refData) throw new Error(`Base ref "${base}" not found`);
    await this.db.refs.updateCommit({ ref: name, commit: refData.commit });
    // New branches start clean — never inherit a sparse overlay from the base ref.
    await this.db.refs.setTreeOid({
      ref: name,
      treeOid: refData.commit.treeOid,
    });
    const v = refData.versions;
    if (v != null && v.length > 0) {
      await this.db.refs.updateVersions({ ref: name, versions: v });
    }
    console.info(
      `[tr33:create-branch] name=${name} base=${base} ${Date.now() - started}ms (no full switch/index)`,
    );
  }

  /** Ensure a ref row + commit exist in Turso without indexing the whole tree. */
  async ensureRefInDb({ ref }: { ref: string }) {
    const worktree = await this.db.refs.get({ ref });
    if (worktree?.commit) {
      return;
    }
    const commit = await this.remote.fetchCommit({ ref });
    await this.db.commits.put(commit);
    await this.db.commits.markPushed({ oid: commit.oid });
    await this.db.refs.updateRemoteCommit({ ref, commit });
  }

  /**
   * Read-only worktree metadata for the VFS / `GET /worktrees/:ref`.
   * Does not run `writeEntries` (full-repo indexing); use `switch()` when mutating.
   */
  async resolveWorktreeForApi(args: { ref: string }): Promise<{
    commit: { oid: string; treeOid: string };
    rootTreeOid: string | null;
  }> {
    let worktree = await this.db.refs.get({ ref: args.ref });

    if (!worktree?.commit) {
      const commit = await this.remote.fetchCommit({ ref: args.ref });
      await this.db.commits.put(commit);
      await this.db.commits.markPushed({ oid: commit.oid });
      await this.db.refs.updateRemoteCommit({ ref: args.ref, commit });
      worktree = await this.db.refs.get({ ref: args.ref });
    }

    if (!worktree?.commit) {
      throw new Error(`Commit not found for ref ${args.ref}`);
    }

    const { commit } = worktree;
    return {
      commit: { oid: commit.oid, treeOid: commit.treeOid },
      rootTreeOid:
        worktree.rootTree?.oid &&
        worktree.rootTree.oid !== commit.treeOid
          ? worktree.rootTree.oid
          : null,
    };
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
    onProgress,
  }: {
    ref: string;
    files: Record<string, string | Uint8Array>;
    onProgress?: (message: string) => void;
  }): Promise<GitAddResult> {
    const tick = gitAddTimer(ref, onProgress);
    const filePaths = Object.keys(files);
    tick(
      filePaths.length === 1
        ? `Preparing ${filePaths[0]}…`
        : `Preparing ${filePaths.length} files…`,
    );

    const entries: { oid: string; path: string; content: string }[] = [];
    const textEntries: { oid: string; path: string }[] = [];
    const blobsToPersist: { oid: string; content: string }[] = [];
    const filesWithOids: Record<string, string> = {};

    for (const [path, content] of Object.entries(files)) {
      const isBinary = content instanceof Uint8Array;
      const oid = isBinary
        ? await calculateBlobOidFromBytes(content)
        : await calculateBlobOid(content);
      filesWithOids[path] = oid;
      const tracked = this.config.matches(path);

      if (tracked && !isBinary) {
        entries.push({ oid, path, content });
        textEntries.push({ oid, path });
        this.blobStore.set(oid, content);
        blobsToPersist.push({ oid, content });
      } else {
        tick(`Uploading ${path} to GitHub…`);
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
      tick("Storing blob in database…");
      await this.db.blobs.batchPut(blobsToPersist);
    }

    const worktree = await this.db.refs.get({ ref });
    if (!worktree) {
      tick(`Loading worktree for ${ref} (first save may take a while)…`);
      await this.switch({ ref });
      return this.add({ ref, files, onProgress });
    }

    const rootTreeOid = worktree.rootTree?.oid || worktree.commit?.treeOid;
    if (!rootTreeOid) {
      throw new Error(`No root tree OID found for ${ref}`);
    }

    tick("Updating repository tree…");
    const trees = await this.trees.applyEntriesToTree({
      rootTreeOid,
      entries,
    });

    await this.writeEntries({
      ref,
      entries: textEntries,
      onProgress: tick,
    });
    tick("Saving tree objects…");
    await this.ensureTrees({ ref, trees });
    tick("Save complete");
    return { files: filesWithOids, rootTreeOid: trees.rootOid };
  }

  /**
   * Persist client-computed worktree state, then index only the saved file(s).
   *
   * - `trees`: only **new** tree objects (leaf + ancestors along changed paths).
   * - `changedFiles`: explicit save list — path cannot be inferred from trees alone.
   */
  async patchWorktree(args: {
    ref: string;
    rootTreeOid: string;
    /** New/changed git tree objects computed on the client. */
    trees: { oid: string; entries: import("tr33-store").TreeEntries }[];
    /** File(s) written this save — drives blob storage + collection index. */
    changedFiles: { path: string; oid: string; content: string }[];
  }): Promise<{ rootTreeOid: string }> {
    const started = Date.now();
    const worktree = await this.db.refs.get({ ref: args.ref });
    if (!worktree) {
      throw new Error(
        `Worktree for ref "${args.ref}" is not loaded. Create or switch to the branch first.`,
      );
    }
    const blobs = args.changedFiles.map(({ oid, content }) => ({
      oid,
      content,
    }));
    if (blobs.length > 0) {
      await this.db.blobs.batchPut(blobs);
    }
    if (args.trees.length > 0) {
      await this.db.trees.batchPut(args.trees);
    }
    await this.db.refs.setTreeOid({
      ref: args.ref,
      treeOid: args.rootTreeOid,
    });
    const indexMs = Date.now();
    await this.indexChangedFiles({
      ref: args.ref,
      changedFiles: args.changedFiles,
    });
    const paths = args.changedFiles.map((f) => f.path).join(", ");
    console.info(
      `[tr33:patch-worktree] ref=${args.ref} files=[${paths}] trees=${args.trees.length} persist=${indexMs - started}ms index=${Date.now() - indexMs}ms total=${Date.now() - started}ms`,
    );
    return { rootTreeOid: args.rootTreeOid };
  }

  async findMany(
    args: FindWorktreeEntriesArgs,
    {
      retrying = false,
      didInit = false,
    }: { retrying?: boolean; didInit?: boolean } = {},
  ): Promise<{
    collection: string;
    commitOid: string;
    items: ReturnType<Config["buildEntry"]>[];
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
        try {
          await this.switch({ ref });
        } catch (e) {
          const msg = e instanceof Error ? e.message : "";
          if (
            msg.includes("No local path found") ||
            msg.includes("Not a git repository")
          ) {
            // Production (Vercel): no local checkout expected. Surface clear message instead of cryptic git error.
            const hasRemoteDb =
              process.env.TR33_DOCS_DATABASE_URL ||
              process.env.LIBSQL_URL ||
              process.env.TURSO_DATABASE_URL;
            throw new Error(
              `Tr33 index missing for ref "${ref}" (version "${this.config.version}"). ` +
                (hasRemoteDb
                  ? `Database at ${hasRemoteDb.slice(0, 40)}… is empty — re-run \`next build\` so the local checkout is indexed into it.`
                  : `No database URL configured and no local checkout found. In production, set TR33_DOCS_DATABASE_URL and build with a local git checkout; in dev, run from a git repo root or set TR33_DOCS_REPO_PATH.`),
            );
          }
          throw e;
        }
        return this.findMany(args, { retrying: true, didInit });
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
          return this.findMany(args, { retrying: true, didInit });
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
      if (!didInit && isMissingSchemaError(e)) {
        await this.db.init();
        // Allow one more schema-init retry, then normal switch fallthrough.
        return this.findMany(args, { retrying: false, didInit: true });
      }
      throw e;
    }
  }

  // First-principles: findFirst is findMany limit 1 with slug/path as real columns.
  async findFirst(
    args: FindWorktreeEntriesArgs,
    {
      retrying = false,
      didInit = false,
    }: { retrying?: boolean; didInit?: boolean } = {},
  ): Promise<{
    collection: string;
    commitOid: string;
    value: ReturnType<Config["buildEntry"]> | null;
    org: string;
    repo: string;
    ref: string;
    version: string;
    name: string;
    commit: string;
  }> {
    const ref = args.ref || this.config.ref;
    try {
      const inner = await this.findMany(
        { ...args, limit: 1, ref } as FindWorktreeEntriesArgs,
        { retrying, didInit },
      );
      const item = inner.items[0] ?? null;
      return {
        collection: args.collection,
        commitOid: inner.commitOid,
        value: item,
        org: this.config.org,
        repo: this.config.repo,
        ref,
        version: this.config.version,
        name: args.collection,
        commit: inner.commitOid,
      };
    } catch (e) {
      if (!didInit && isMissingSchemaError(e)) {
        await this.db.init();
        return this.findFirst(args, { retrying: false, didInit: true });
      }
      throw e;
    }
  }

  async writeEntries(args: {
    ref: string;
    entries: { oid: string; path: string }[];
    onProgress?: (message: string) => void;
  }) {
    const report = (message: string) => args.onProgress?.(message);
    const entries = args.entries
      .map((e) => ({ oid: String(e.oid), path: String(e.path) }))
      .filter((e) => this.config.matches(e.path));
    if (entries.length === 0) {
      return;
    }
    report("Ensuring collection blobs…");
    await this.ensureBlobs({
      oids: entries.map((e) => e.oid),
      onProgress: report,
    });
    const chunks = await this.chunkBlobs({
      blobs: Array.from(entries),
      size: 2,
    });
    const cache = this.createCache();
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      report(
        chunks.length === 1
          ? "Indexing collections…"
          : `Indexing collections (${i + 1}/${chunks.length})…`,
      );
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
    report("Indexed collections");
  }

  /** Index only the saved collection file(s) — content comes from the client. */
  async indexChangedFiles(args: {
    ref: string;
    changedFiles: { path: string; oid: string; content: string }[];
    onProgress?: (message: string) => void;
  }) {
    const report = (message: string) => args.onProgress?.(message);
    const files = args.changedFiles
      .map((f) => ({
        oid: String(f.oid),
        path: String(f.path),
        content: f.content,
      }))
      .filter((f) => this.config.matches(f.path));
    if (files.length === 0) {
      return;
    }
    report(
      files.length === 1
        ? `Indexing ${files[0].path}…`
        : `Indexing ${files.length} collection files…`,
    );
    const cache = this.createCache();
    for (const { oid, path, content } of files) {
      this.config.index({ oid, content, path, ref: args.ref }, cache);
    }
    await this.db.writeCache({
      status: "dirty",
      cache,
      skipSiblingCopy: true,
    });
    report("Indexed collections");
  }

  /** @deprecated Use `indexChangedFiles` for editor saves. */
  async writeEntriesFromContent(args: {
    ref: string;
    entries: { oid: string; path: string; content: string }[];
    onProgress?: (message: string) => void;
  }) {
    return this.indexChangedFiles({
      ref: args.ref,
      changedFiles: args.entries.map((e) => ({
        path: e.path,
        oid: e.oid,
        content: e.content,
      })),
      onProgress: args.onProgress,
    });
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

    const commitTrees: {
      treeOid: string;
      parentTreeOid: string | null;
      paths: { path: string; oid: string; type: "blob" | "tree" }[];
    }[] = [];
    const blobOids = new Set<string>();

    for (const commit of unpushedCommits) {
      const parentCommit = commit.parent
        ? await this.db.commits.get({ oid: commit.parent })
        : null;
      const paths = await this.trees.diffBlobPathsForPush({
        baseTreeOid: parentCommit?.treeOid ?? null,
        treeOid: commit.treeOid,
      });
      commitTrees.push({
        treeOid: commit.treeOid,
        parentTreeOid: parentCommit?.treeOid ?? null,
        paths,
      });
      for (const entry of paths) {
        blobOids.add(entry.oid);
      }
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

    const result = await this.remote.push({
      ref,
      commits: unpushedCommits,
      blobs,
      commitTrees,
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
    const treesToSave = await this.trees.exportTreesForPersist(args.trees.trees);
    if (treesToSave.length > 0) {
      await this.db.trees.batchPut(treesToSave);
    }
    await this.db.refs.setTreeOid({
      ref: args.ref,
      treeOid: args.trees.rootOid,
    });
    await this.db.refs.updateVersions({
      ref: args.ref,
      versions: [this.config.version],
    });
  }

  async ensureBlobs({
    oids,
    onProgress,
  }: {
    oids: string[];
    onProgress?: (message: string) => void;
  }) {
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
    if (blobsToGetFromRemote.length > 0) {
      onProgress?.(
        blobsToGetFromRemote.length === 1
          ? "Fetching blob from GitHub…"
          : `Fetching ${blobsToGetFromRemote.length} blobs from GitHub…`,
      );
    }
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
