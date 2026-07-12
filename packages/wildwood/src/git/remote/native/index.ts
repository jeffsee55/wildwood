import fs from "node:fs";
import { dirname, join } from "node:path";
import {
  type MergePrResult,
  type PrResult,
  type PushResult,
  Remote,
} from "@/git/remote";
import {
  runGit,
  runGitBuffer,
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
  private _hasOriginRemote: boolean | undefined;

  private async hasOriginRemote(): Promise<boolean> {
    if (this._hasOriginRemote !== undefined) return this._hasOriginRemote;
    const result = await this.executeCommand({
      args: ["config", "--get", "remote.origin.url"],
    });
    this._hasOriginRemote = result.isOk() && result.value.trim().length > 0;
    return this._hasOriginRemote;
  }

  async listBranches(): Promise<string[]> {
    const [localResult, remoteResult] = await Promise.all([
      this.executeCommand({
        args: ["branch", "--format=%(refname:short)"],
      }),
      this.executeCommand({
        args: ["branch", "-r", "--format=%(refname:short)"],
      }),
    ]);
    if (localResult.isErr())
      throw new Error(`Failed to list local branches: ${localResult.error}`);
    if (remoteResult.isErr())
      throw new Error(`Failed to list remote branches: ${remoteResult.error}`);
    const normalize = (value: string) =>
      value
        .split("\n")
        .map((b) => b.trim())
        .filter(Boolean)
        .map((b) => b.replace(/^origin\//, ""))
        .filter((b) => b !== "HEAD");
    return [
      ...new Set([...normalize(localResult.value), ...normalize(remoteResult.value)]),
    ];
  }

  async fetchBlobs(args: { oids: string[] }) {
    if (args.oids.length === 0) return [];
    const uniqueOids = [...new Set(args.oids)];
    const result = await this.executeCommandBuffer({
      args: ["cat-file", "--batch"],
      input: uniqueOids.join("\n"),
    });
    if (result.isErr()) throw new Error(`Failed to get blobs: ${result.error}`);

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
        pos = headerEnd + 1 + size + 1;
        continue;
      }
      const contentStart = headerEnd + 1;
      const contentBuffer = output.slice(contentStart, contentStart + size);
      blobs.push({ oid: oid!, content: contentBuffer.toString("utf-8") });
      pos = contentStart + size + 1;
    }
    return blobs;
  }

  async fetchBlobRaw(args: { oid: string }): Promise<Buffer | null> {
    const result = await this.executeCommandBuffer({
      args: ["cat-file", "blob", args.oid],
    });
    if (result.isErr()) return null;
    return result.value as Buffer;
  }

  async fetchCommit(args: { ref: string } | { oid: string }): Promise<Commit> {
    const commitOid = "ref" in args ? await this.resolveRefToOid(args.ref) : args.oid;
    const result = await this.executeCommand({ args: ["cat-file", "commit", commitOid] });
    if (result.isErr()) throw new Error(`Failed to get commit: ${result.error}`);
    return this.parseRawCommitObject(commitOid, result.value);
  }

  private async resolveRefToOid(ref: string): Promise<string> {
    const candidates: string[] = [ref];
    if (!ref.startsWith("refs/remotes/")) {
      const tail = ref.startsWith("origin/")
        ? ref.slice("origin/".length)
        : ref.startsWith("refs/heads/")
          ? ref.slice("refs/heads/".length)
          : ref;
      if ((await this.hasOriginRemote()) && tail.length > 0) {
        if (!ref.startsWith("origin/")) candidates.push(`origin/${tail}`);
        candidates.push(`refs/remotes/origin/${tail}`);
      }
    }
    const tried = new Set<string>();
    let lastErr: string | undefined;
    for (const candidate of candidates) {
      if (tried.has(candidate)) continue;
      tried.add(candidate);
      const result = await this.executeCommand({ args: ["rev-parse", candidate] });
      if (result.isOk()) return result.value.trim();
      lastErr = String(result.error);
    }
    for (const fallback of ["HEAD", process.env.VERCEL_GIT_COMMIT_SHA].filter(
      (v): v is string => Boolean(v?.trim()),
    )) {
      if (tried.has(fallback)) continue;
      tried.add(fallback);
      const result = await this.executeCommand({ args: ["rev-parse", fallback] });
      if (result.isOk()) return result.value.trim();
      lastErr = String(result.error);
    }
    const hasOrigin = await this.hasOriginRemote();
    const summary = lastErr ? gitErrorSummary(lastErr) : "git rev-parse failed";
    const guidance = hasOrigin
      ? "Run `git fetch` if the branch exists on the remote, or create/checkout the branch locally. If your default branch has another name (for example `master`), set `ref` in your Wildwood config to match."
      : "There is no `remote.origin`. Create a local branch named for this ref, or set `ref` in your Wildwood config to a branch that exists (`git branch` lists local branches).";
    throw new Error(`Cannot resolve git ref "${ref}" to a commit (${summary}). ${guidance}`);
  }

  async fetchTree({ oid }: { oid: string }) {
    const result = await this.executeCommand({ args: ["ls-tree", oid] });
    if (result.isErr()) return null;
    const entries = this.parseRawTreeObject(result.value);
    return entries.reduce(
      (acc, entry) => {
        acc[entry.path] = { type: entry.type, oid: entry.oid };
        return acc;
      },
      {} as Record<string, { type: "blob" | "tree"; oid: string }>,
    );
  }

  // ---- internals ----------------------------------------------------------

  private cwd(): string {
    const raw =
      (this.config as { resolvedLocalPath?: string | undefined }).resolvedLocalPath ??
      this.config.localPath ??
      process.cwd();
    // Allow explicit relative paths (e.g. `localPath: "."` from old cookies/tests).
    // Config's `resolvedLocalPath` is already normalized, but raw `localPath` might not be.
    const start = raw.trim() === "" ? process.cwd() : raw;
    const abs =
      raw === "." || raw.trim() === ""
        ? process.cwd()
        : (() => {
            try {
              // eslint-disable-next-line @typescript-eslint/no-require-imports
              const { isAbsolute, resolve } = require("node:path") as typeof import("node:path");
              return isAbsolute(start) ? start : resolve(process.cwd(), start);
            } catch {
              return start;
            }
          })();
    const gitPath = this.getPathToGit(abs);
    if (!gitPath) throw new Error("No local path found");
    return gitPath.endsWith(".git") || gitPath.endsWith(".git/")
      ? dirname(gitPath.replace(/\/$/, ""))
      : gitPath;
  }

  private async executeCommand(args: { args: string[]; input?: string }) {
    return runGit({ cwd: this.cwd(), args: args.args, input: args.input });
  }

  private async executeCommandBuffer(args: {
    args: string[];
    input?: string;
  }) {
    return runGitBuffer({ cwd: this.cwd(), args: args.args, input: args.input });
  }

  private getPathToGit(path: string): string | null {
    if (path === ".") return this.getPathToGit(process.cwd());
    const gp = join(path, ".git/");
    if (fs.existsSync(gp)) return gp;
    const parent = dirname(path);
    if (parent === path) return null;
    return this.getPathToGit(parent);
  }

  private parseRawCommitObject(oid: string, rawCommitObject: string) {
    const lines = rawCommitObject.split("\n");
    const messageStartIndex = lines.findIndex((line) => line === "") + 1;
    let actualMessageStart = messageStartIndex;
    while (
      actualMessageStart < lines.length &&
      lines[actualMessageStart]!.startsWith("gpgsig")
    ) {
      actualMessageStart++;
      while (
        actualMessageStart < lines.length &&
        lines[actualMessageStart]!.startsWith(" ")
      )
        actualMessageStart++;
      if (actualMessageStart < lines.length && lines[actualMessageStart] === "") {
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
      if (line.startsWith("tree ")) treeOid = line.substring(5);
      else if (line.startsWith("parent ")) {
        if (!parent) parent = line.substring(7);
        else if (!secondParent) secondParent = line.substring(7);
      } else if (line.startsWith("author ")) {
        const m = line.match(/author (.+) <(.+)> (\d+) ([+-]\d{4})/);
        if (m) {
          authorName = m[1]!;
          authorEmail = m[2]!;
          authorTimestamp = m[3]!;
          authorTimezoneOffset = this.parseGitTimezone(m[4]!);
        }
      } else if (line.startsWith("committer ")) {
        const m = line.match(/committer (.+) <(.+)> (\d+) ([+-]\d{4})/);
        if (m) {
          committerName = m[1]!;
          committerEmail = m[2]!;
          committerTimestamp = m[3]!;
          committerTimezoneOffset = this.parseGitTimezone(m[4]!);
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

  private parseGitTimezone(tz: string): number {
    const sign = tz[0] === "+" ? -1 : 1;
    const h = Number.parseInt(tz.slice(1, 3));
    const m = Number.parseInt(tz.slice(3, 5));
    return sign * (h * 60 + m);
  }

  private parseRawTreeObject(rawTreeObject: string) {
    const out: { oid: string; path: string; type: "tree" | "blob" }[] = [];
    for (const line of rawTreeObject.split("\n").filter((l) => l.trim() !== "")) {
      const [, type, oidAndPath] = line.split(" ");
      const [entryOid, name] = oidAndPath!.split("\t");
      out.push({ oid: entryOid!, type: type === "tree" ? "tree" : "blob", path: name! });
    }
    return out;
  }

  // Unsupported remote ops -> keep abstract but explicit errors
  async createBlob(args: { content: Uint8Array }): Promise<{ oid: string }> {
    const cwd = this.cwd();
    const res = await runGitBuffer({
      cwd,
      args: ["hash-object", "-w", "--stdin"],
      input: args.content,
    });
    if (res.isErr()) throw new Error(`hash-object failed: ${res.error.message}`);
    return { oid: res.value.toString("utf-8").trim() };
  }

  async push(): Promise<PushResult> {
    throw new Error("push not implemented for NativeRemote");
  }
  async createPr(): Promise<PrResult> {
    throw new Error("createPr not implemented for NativeRemote");
  }
  async updatePr(): Promise<PrResult> {
    throw new Error("updatePr not implemented for NativeRemote");
  }
  async findPr(): Promise<PrResult | null> {
    return null;
  }
  async createPrComment(): Promise<void> {
    throw new Error("createPrComment not implemented for NativeRemote");
  }
  async mergePr(): Promise<MergePrResult> {
    throw new Error("mergePr not implemented for NativeRemote");
  }
}
