import fs from "node:fs";
import { dirname, join } from "node:path";
import {
  type MergePrResult,
  type PrResult,
  type PushResult,
  Remote,
} from "@/git/remote";

import {
  _runGitCommand,
  _runGitCommand2,
  _runGitCommandBuffer,
} from "@/git/remote/native/run-git-command";
import { type Commit, commitSchema } from "@/types";

function gitErrorSummary(message: string): string {
  const lines = message
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const fatal = lines.find((l) => l.startsWith("fatal:"));
  const raw = fatal
    ? fatal.replace(/^fatal:\s*/i, "").trim()
    : (lines[0] ?? message);
  return raw.length > 200 ? `${raw.slice(0, 197)}…` : raw;
}

export class NativeRemote extends Remote {
  /** Cached: whether `remote.origin.url` is set (undefined = not yet checked). */
  private _hasOriginRemote: boolean | undefined;

  private async hasOriginRemote(): Promise<boolean> {
    if (this._hasOriginRemote !== undefined) {
      return this._hasOriginRemote;
    }
    const result = await this.executeCommand({
      command: "config --get remote.origin.url",
    });
    this._hasOriginRemote = result.isOk() && result.value.trim().length > 0;
    return this._hasOriginRemote;
  }

  async listBranches(): Promise<string[]> {
    const [localResult, remoteResult] = await Promise.all([
      this.executeCommand({
        command: "branch --format='%(refname:short)'",
      }),
      this.executeCommand({
        command: "branch -r --format='%(refname:short)'",
      }),
    ]);
    if (localResult.isErr()) {
      throw new Error(`Failed to list local branches: ${localResult.error}`);
    }
    if (remoteResult.isErr()) {
      throw new Error(`Failed to list remote branches: ${remoteResult.error}`);
    }
    const normalize = (value: string) =>
      value
        .split("\n")
        .map((branch) => branch.trim())
        .filter(Boolean)
        .map((branch) => branch.replace(/^origin\//, ""))
        .filter((branch) => branch !== "HEAD");
    return [
      ...new Set([
        ...normalize(localResult.value),
        ...normalize(remoteResult.value),
      ]),
    ];
  }

  async fetchBlobs(args: { oids: string[] }) {
    if (args.oids.length === 0) {
      return [];
    }

    const uniqueOids = [...new Set(args.oids)];

    const result = await this.executeCommandBuffer({
      command: "cat-file --batch",
      stdinInput: uniqueOids.join("\n"),
    });
    if (result.isErr()) {
      throw new Error(`Failed to get blobs: ${result.error}`);
    }

    const blobs: { oid: string; content: string }[] = [];
    const output = result.value;
    let pos = 0;

    while (pos < output.length) {
      const headerEnd = output.indexOf(0x0a, pos);
      if (headerEnd === -1) break;

      const headerLine = output.slice(pos, headerEnd).toString("utf-8");
      if (!headerLine.trim()) {
        pos = headerEnd + 1;
        continue;
      }

      const parts = headerLine.split(" ");
      const oid = parts[0];
      const type = parts[1];
      const size = Number.parseInt(parts[2] || "0");

      if (type === "missing") {
        pos = headerEnd + 1;
        continue;
      }

      if (type !== "blob") {
        const contentStart = headerEnd + 1;
        pos = contentStart + size + 1;
        continue;
      }

      const contentStart = headerEnd + 1;
      const contentBuffer = output.slice(contentStart, contentStart + size);
      const content = contentBuffer.toString("utf-8");

      blobs.push({ oid, content });
      pos = contentStart + size + 1;
    }

    return blobs;
  }

  async fetchBlobRaw(args: { oid: string }): Promise<Buffer | null> {
    const result = await this.executeCommandBuffer({
      command: `cat-file blob ${args.oid}`,
    });
    if (result.isErr()) return null;
    return result.value;
  }

  async fetchCommit(args: { ref: string } | { oid: string }): Promise<Commit> {
    let commitOid: string;
    if ("ref" in args) {
      commitOid = await this.resolveRefToOid(args.ref);
    } else {
      commitOid = args.oid;
    }
    const result2 = await this.executeCommand({
      command: `cat-file commit ${commitOid}`,
    });
    if (result2.isErr()) {
      throw new Error(`Failed to get commit: ${result2.error}`);
    }
    return this.parseRawCommitObject(commitOid, result2.value);
  }

  /**
   * `git branch -r` lists `origin/foo` which we often show as `foo`. Plain
   * `git rev-parse foo` fails without a local branch; remote-tracking refs
   * resolve as `origin/...` or `refs/remotes/origin/...` when `origin` exists.
   */
  private async resolveRefToOid(ref: string): Promise<string> {
    const candidates: string[] = [ref];
    if (!ref.startsWith("refs/remotes/")) {
      const tail = ref.startsWith("origin/")
        ? ref.slice("origin/".length)
        : ref.startsWith("refs/heads/")
          ? ref.slice("refs/heads/".length)
          : ref;
      if ((await this.hasOriginRemote()) && tail.length > 0) {
        if (!ref.startsWith("origin/")) {
          candidates.push(`origin/${tail}`);
        }
        candidates.push(`refs/remotes/origin/${tail}`);
      }
    }
    const tried = new Set<string>();
    let lastErr: string | undefined;
    for (const candidate of candidates) {
      if (tried.has(candidate)) continue;
      tried.add(candidate);
      const result = await this.executeCommand({
        command: `rev-parse ${candidate}`,
      });
      if (result.isOk()) {
        return result.value.trim();
      }
      lastErr = String(result.error);
    }
    for (const fallback of ["HEAD", process.env.VERCEL_GIT_COMMIT_SHA].filter(
      (value): value is string => Boolean(value?.trim()),
    )) {
      if (tried.has(fallback)) continue;
      tried.add(fallback);
      const result = await this.executeCommand({
        command: `rev-parse ${fallback}`,
      });
      if (result.isOk()) {
        return result.value.trim();
      }
      lastErr = String(result.error);
    }
    const hasOrigin = await this.hasOriginRemote();
    const summary = lastErr ? gitErrorSummary(lastErr) : "git rev-parse failed";
    const guidance = hasOrigin
      ? "Run `git fetch` if the branch exists on the remote, or create/checkout the branch locally. If your default branch has another name (for example `master`), set `ref` in your Tr33 config to match."
      : "There is no `remote.origin`. Create a local branch named for this ref, or set `ref` in your Tr33 config to a branch that exists (`git branch` lists local branches).";
    throw new Error(
      `Cannot resolve git ref "${ref}" to a commit (${summary}). ${guidance}`,
    );
  }

  async fetchTree({ oid }: { oid: string }) {
    const result = await this.executeCommand({
      command: `ls-tree ${oid}`,
    });
    if (result.isErr()) {
      return null;
    }
    const entries = this.parseRawTreeObject(result.value);
    return entries.reduce(
      (acc, entry) => {
        acc[entry.path] = { type: entry.type, oid: entry.oid };
        return acc;
      },
      {} as Record<string, { type: "blob" | "tree"; oid: string }>,
    );
  }

  private async executeCommand(args: { command: string; stdinInput?: string }) {
    const gitPath = this.getPathToGit(this.config.localPath || process.cwd());
    if (!gitPath) {
      throw new Error("No local path found");
    }
    const cwd =
      gitPath.endsWith(".git") || gitPath.endsWith(".git/")
        ? dirname(gitPath.replace(/\/$/, ""))
        : gitPath;
    return await _runGitCommand({
      command: args.command,
      cwd,
      stdinInput: args.stdinInput,
    });
  }

  private isAbsolutePath(path: string): boolean {
    return path.startsWith("/");
  }

  private getPathToGit(path: string): string | null {
    if (path === ".") {
      return this.getPathToGit(process.cwd());
    }
    const gitPath = join(path, ".git/");
    if (fs.existsSync(gitPath)) {
      return gitPath;
    }
    const parentPath = dirname(path);
    if (parentPath === path) {
      return null;
    }
    return this.getPathToGit(parentPath);
  }

  private parseRawCommitObject(oid: string, rawCommitObject: string) {
    const lines = rawCommitObject.split("\n");
    const messageStartIndex = lines.findIndex((line) => line === "") + 1;

    let actualMessageStart = messageStartIndex;
    while (
      actualMessageStart < lines.length &&
      lines[actualMessageStart].startsWith("gpgsig")
    ) {
      actualMessageStart++;
      while (
        actualMessageStart < lines.length &&
        lines[actualMessageStart].startsWith(" ")
      ) {
        actualMessageStart++;
      }
      if (
        actualMessageStart < lines.length &&
        lines[actualMessageStart] === ""
      ) {
        actualMessageStart++;
        break;
      }
    }

    let treeOid = "";
    let parent: string | null = null;
    let secondParent: string | null = null;
    let authorName = "";
    let authorEmail = "";
    let authorTimestamp = "";
    let authorTimezoneOffset = 0;
    let committerName = "";
    let committerEmail = "";
    let committerTimestamp = "";
    let committerTimezoneOffset = 0;

    for (const line of lines) {
      if (line.startsWith("tree ")) {
        treeOid = line.substring(5);
      } else if (line.startsWith("parent ")) {
        if (!parent) {
          parent = line.substring(7);
        } else if (!secondParent) {
          secondParent = line.substring(7);
        }
      } else if (line.startsWith("author ")) {
        const match = line.match(/author (.+) <(.+)> (\d+) ([+-]\d{4})/);
        if (match) {
          authorName = match[1];
          authorEmail = match[2];
          authorTimestamp = match[3];
          authorTimezoneOffset = this.parseGitTimezone(match[4]);
        }
      } else if (line.startsWith("committer ")) {
        const match = line.match(/committer (.+) <(.+)> (\d+) ([+-]\d{4})/);
        if (match) {
          committerName = match[1];
          committerEmail = match[2];
          committerTimestamp = match[3];
          committerTimezoneOffset = this.parseGitTimezone(match[4]);
        }
      }
    }

    const message = lines.slice(actualMessageStart).join("\n");

    return commitSchema.parse({
      oid,
      message,
      author: {
        name: authorName,
        email: authorEmail,
        timestamp: Number.parseInt(authorTimestamp),
        timezoneOffset: authorTimezoneOffset,
      },
      committer: {
        name: committerName,
        email: committerEmail,
        timestamp: Number.parseInt(committerTimestamp),
        timezoneOffset: committerTimezoneOffset,
      },
      parent,
      secondParent,
      treeOid,
    });
  }

  private parseGitTimezone(gitTimezone: string): number {
    const sign = gitTimezone[0] === "+" ? -1 : 1;
    const hours = Number.parseInt(gitTimezone.slice(1, 3));
    const minutes = Number.parseInt(gitTimezone.slice(3, 5));
    return sign * (hours * 60 + minutes);
  }

  private parseRawTreeObject(rawTreeObject: string) {
    const treesEntriesToPut: {
      oid: string;
      path: string;
      type: "tree" | "blob";
    }[] = [];
    const lines = rawTreeObject.split("\n");
    for (const line of lines.filter((line) => line.trim() !== "")) {
      const [, type, oidAndPath] = line.split(" ");
      const [entryOid, name] = oidAndPath.split("\t");
      treesEntriesToPut.push({
        oid: entryOid,
        type: type === "tree" ? "tree" : "blob",
        path: name,
      });
    }
    return treesEntriesToPut;
  }

  private async executeCommandBuffer(args: {
    command: string;
    stdinInput?: string;
  }) {
    const gitPath = this.getPathToGit(this.config.localPath || process.cwd());
    if (!gitPath) {
      throw new Error("No local path found");
    }
    const cwd =
      gitPath.endsWith(".git") || gitPath.endsWith(".git/")
        ? dirname(gitPath.replace(/\/$/, ""))
        : gitPath;
    return await _runGitCommandBuffer({
      command: args.command,
      cwd,
      stdinInput: args.stdinInput,
    });
  }

  async createBlob(args: { content: Uint8Array }): Promise<{ oid: string }> {
    const gitPath = this.getPathToGit(this.config.localPath || process.cwd());
    if (!gitPath) throw new Error("No local path found");
    const cwd =
      gitPath.endsWith(".git") || gitPath.endsWith(".git/")
        ? dirname(gitPath.replace(/\/$/, ""))
        : gitPath;
    const oid = await _runGitCommand2({
      command: "hash-object -w --stdin",
      cwd,
      stdinInput: Buffer.from(args.content),
    });
    return { oid: oid.trim() };
  }

  async push(_args: Parameters<Remote["push"]>[0]): Promise<PushResult> {
    throw new Error("push not implemented for NativeRemote");
  }

  async createPr(_args: Parameters<Remote["createPr"]>[0]): Promise<PrResult> {
    throw new Error("createPr not implemented for NativeRemote");
  }

  async updatePr(_args: Parameters<Remote["updatePr"]>[0]): Promise<PrResult> {
    throw new Error("updatePr not implemented for NativeRemote");
  }

  async findPr(
    _args: Parameters<Remote["findPr"]>[0],
  ): Promise<PrResult | null> {
    throw new Error("findPr not implemented for NativeRemote");
  }

  async mergePr(
    _args: Parameters<Remote["mergePr"]>[0],
  ): Promise<MergePrResult> {
    throw new Error("mergePr not implemented for NativeRemote");
  }

  async createPrComment(
    _args: Parameters<Remote["createPrComment"]>[0],
  ): Promise<void> {
    throw new Error("createPrComment not implemented for NativeRemote");
  }
}
