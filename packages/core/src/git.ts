/** Optional Node/Git transport. The content engine does not create Git objects on save. */
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ContentEngine } from "./engine";
import type { Collections, FileChange, FileMode } from "./types";
import { hash } from "./storage";

async function invoke(
  directory: string,
  args: string[],
  input?: Uint8Array | string,
  env: Record<string, string> = {},
  conflicts = false,
): Promise<{ code: number; output: Buffer }> {
  return new Promise((resolveResult, reject) => {
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
    );
    const child = spawn(process.env.WILDWOOD_GIT_EXECUTABLE || "git", ["-C", directory, ...args], {
      env: {
        ...inherited,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        ...env,
      },
      stdio: "pipe",
    });
    const output: Buffer[] = [],
      errors: Buffer[] = [];
    let size = 0;
    const capture = (target: Buffer[], chunk: Buffer) => {
      size += chunk.length;
      if (size > 256 * 1024 * 1024) {
        child.kill();
        reject(
          new Error(
            "Git adapter buffer limit exceeded (256 MiB); use a streaming transport for larger repositories",
          ),
        );
      } else target.push(chunk);
    };
    child.stdout.on("data", (chunk) => capture(output, chunk));
    child.stderr.on("data", (chunk) => capture(errors, chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 || (conflicts && code === 1)
        ? resolveResult({ code: code!, output: Buffer.concat(output) })
        : reject(new Error(Buffer.concat(errors).toString() || `git ${args[0]} failed`)),
    );
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Git operation timed out"));
    }, 45000);
    child.once("close", () => clearTimeout(timeout));
    child.once("error", () => clearTimeout(timeout));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
async function run(
  directory: string,
  args: string[],
  input?: Uint8Array | string,
  env?: Record<string, string>,
) {
  return (await invoke(directory, args, input, env)).output;
}
async function metadata<C extends Collections>(engine: ContentEngine<C>) {
  await engine.ready();
  await engine.database.execute(`CREATE TABLE IF NOT EXISTS ww2_git_commits (
    repository TEXT NOT NULL, snapshot TEXT NOT NULL, oid TEXT NOT NULL, archive TEXT NOT NULL,
    PRIMARY KEY(repository,snapshot))`);
}

/** Import exact file bytes/modes and retain the original commit ancestry as a pack. */
export async function importGit<C extends Collections>(
  engine: ContentEngine<C>,
  args: { directory: string; ref?: string; targetRef: string },
) {
  await metadata(engine);
  if (
    (await run(args.directory, ["rev-parse", "--show-object-format"])).toString().trim() !== "sha1"
  ) {
    throw new Error("This Git adapter currently supports SHA-1 repositories only");
  }
  const oid = (
    await run(args.directory, [
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${args.ref ?? "HEAD"}^{commit}`,
    ])
  )
    .toString()
    .trim();
  const listing = await run(args.directory, ["ls-tree", "-r", "-z", oid]);
  const changes: FileChange[] = [];
  for (const entry of new TextDecoder("utf-8", { fatal: true })
    .decode(listing)
    .split("\0")
    .filter(Boolean)) {
    const tab = entry.indexOf("\t"),
      [mode, type, blob] = entry.slice(0, tab).split(" ");
    if (type !== "blob" || !["100644", "100755", "120000"].includes(mode))
      throw new Error(
        "Git import currently supports regular files, executable files, and symlinks; submodules require a future adapter",
      );
    changes.push({
      path: entry.slice(tab + 1),
      content: await run(args.directory, ["cat-file", "blob", blob]),
      mode: mode as FileMode,
    });
  }
  const pack = await run(args.directory, ["pack-objects", "--stdout", "--revs"], `${oid}\n`);
  const archive = hash(pack);
  await engine.blobs.put(archive, pack);
  const head = await engine.branch(args.targetRef);
  const result = await engine.apply({
    ref: head.name,
    expectedRevision: head.revision,
    changes,
    idempotencyKey: `import:${head.name}:${oid}`,
  });
  await engine.database.execute(
    "INSERT INTO ww2_git_commits(repository,snapshot,oid,archive) VALUES(?,?,?,?) ON CONFLICT DO NOTHING",
    [engine.config.repository, result.snapshot, oid, archive],
  );
  return { ...result, commit: oid };
}

/** Hydrate a bare Git repository on demand. Imported history retains exact OIDs. */
export async function exportGit<C extends Collections>(
  engine: ContentEngine<C>,
  args: {
    snapshot: string;
    directory: string;
    branch?: string;
    message: string;
    author: { name: string; email: string; timestamp?: number };
  },
) {
  await metadata(engine);
  const branch = args.branch ?? "main";
  // Git itself is the ref-format authority.
  await run(process.cwd(), ["check-ref-format", `refs/heads/${branch}`]);
  if (
    Array.from(args.author.name + args.author.email).some(
      (char) => char.charCodeAt(0) < 32 || char === "<" || char === ">",
    )
  )
    throw new Error("Invalid Git author");
  const files = await engine.files(args.snapshot);
  const temp = await mkdtemp(join(tmpdir(), "wildwood-git-"));
  try {
    const exists = await stat(args.directory).then(
      () => true,
      (error) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    );
    if (exists) {
      if (
        (await run(args.directory, ["rev-parse", "--is-bare-repository"])).toString().trim() !==
        "true"
      )
        throw new Error("Export destination must be a bare Git repository");
    } else await run(process.cwd(), ["init", "--bare", resolve(args.directory)]);
    const refs = (
      await run(args.directory, [
        "for-each-ref",
        "--format=%(refname) %(objectname)",
        `refs/heads/${branch}`,
      ])
    )
      .toString()
      .trim()
      .split("\n");
    const oldOid =
      refs.find((line) => line.startsWith(`refs/heads/${branch} `))?.split(" ")[1] ??
      "0".repeat(40);
    const ancestry = await engine.database.execute(
      `WITH RECURSIVE chain(id,depth) AS (
      SELECT id,0 FROM ww2_snapshots WHERE id=? AND repository=?
      UNION ALL SELECT s.parent,c.depth+1 FROM chain c JOIN ww2_snapshots s ON s.id=c.id WHERE s.parent IS NOT NULL
    ) SELECT g.* FROM chain c JOIN ww2_git_commits g ON g.snapshot=c.id WHERE g.repository=? ORDER BY c.depth LIMIT 1`,
      [args.snapshot, engine.config.repository, engine.config.repository],
    );
    const parent = ancestry.rows[0];
    if (parent)
      await run(
        args.directory,
        ["index-pack", "--stdin"],
        await engine.bytes(String(parent.archive)),
      );
    let oid: string;
    if (parent?.snapshot === args.snapshot) {
      oid = String(parent.oid);
    } else {
      const env = { GIT_INDEX_FILE: join(temp, "index") };
      await run(args.directory, ["read-tree", "--empty"], undefined, env);
      const index: string[] = [];
      for (const file of files) {
        const blob = (
          await run(args.directory, ["hash-object", "-w", "--stdin"], await engine.bytes(file.blob))
        )
          .toString()
          .trim();
        index.push(`${file.mode} ${blob}\t${file.path}\0`);
      }
      await run(args.directory, ["update-index", "-z", "--index-info"], index.join(""), env);
      const tree = (await run(args.directory, ["write-tree"], undefined, env)).toString().trim();
      const date = `${args.author.timestamp ?? Math.floor(Date.now() / 1000)} +0000`;
      oid = (
        await run(
          args.directory,
          ["commit-tree", tree, ...(parent ? ["-p", String(parent.oid)] : [])],
          args.message,
          {
            GIT_AUTHOR_NAME: args.author.name,
            GIT_AUTHOR_EMAIL: args.author.email,
            GIT_AUTHOR_DATE: date,
            GIT_COMMITTER_NAME: args.author.name,
            GIT_COMMITTER_EMAIL: args.author.email,
            GIT_COMMITTER_DATE: date,
          },
        )
      )
        .toString()
        .trim();
      const pack = await run(args.directory, ["pack-objects", "--stdout", "--revs"], `${oid}\n`);
      const archive = hash(pack);
      await engine.blobs.put(archive, pack);
      const saved = await engine.database.execute(
        "INSERT INTO ww2_git_commits(repository,snapshot,oid,archive) VALUES(?,?,?,?) ON CONFLICT DO NOTHING",
        [engine.config.repository, args.snapshot, oid, archive],
      );
      if (!saved.changes) {
        const winner = await engine.database.execute(
          "SELECT oid,archive FROM ww2_git_commits WHERE repository=? AND snapshot=?",
          [engine.config.repository, args.snapshot],
        );
        oid = String(winner.rows[0].oid);
        await run(
          args.directory,
          ["index-pack", "--stdin"],
          await engine.bytes(String(winner.rows[0].archive)),
        );
      }
    }
    await run(args.directory, ["update-ref", `refs/heads/${branch}`, oid, oldOid]);
    await run(args.directory, ["symbolic-ref", "HEAD", `refs/heads/${branch}`]);
    return { oid, snapshot: args.snapshot, directory: resolve(args.directory) };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

/**
 * Smart HTTP clone/fetch for ONE authorized repository. Requires native Git and
 * persistent local storage; not a Vercel function. Repository-level authority is
 * mandatory: Git fetch exposes reachable history, not just one content ref.
 * Receive-pack is deliberately unavailable until transactional ingestion exists.
 */
export function createGitHandler(options: {
  directory: string;
  authorize: (request: Request) => Promise<boolean>;
}) {
  return async (request: Request): Promise<Response> => {
    if (!(await options.authorize(request)))
      return new Response("Unauthorized", {
        status: 401,
        headers: { "cache-control": "no-store", "www-authenticate": 'Basic realm="Wildwood Git"' },
      });
    const url = new URL(request.url);
    const discovery =
      url.pathname.endsWith("/info/refs") &&
      url.searchParams.get("service") === "git-upload-pack" &&
      request.method === "GET";
    const upload = url.pathname.endsWith("/git-upload-pack") && request.method === "POST";
    if (!discovery && !upload)
      return new Response("Only smart HTTP clone/fetch is enabled", { status: 403 });
    if (upload && request.headers.get("content-type") !== "application/x-git-upload-pack-request")
      return new Response("Invalid Git content type", { status: 415 });
    const chunks: Uint8Array[] = [];
    let length = 0;
    if (request.body) {
      const reader = request.body.getReader();
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          length += chunk.value.length;
          if (length > 8 * 1024 * 1024) {
            await reader.cancel();
            return new Response("Request too large", { status: 413 });
          }
          chunks.push(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }
    }
    const input = Buffer.concat(chunks);
    const raw = await run(
      options.directory,
      ["-c", "http.receivepack=false", "-c", "http.getanyfile=false", "http-backend"],
      input,
      {
        GIT_PROJECT_ROOT: resolve(options.directory),
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: discovery ? "/info/refs" : "/git-upload-pack",
        REQUEST_METHOD: request.method,
        QUERY_STRING: discovery ? "service=git-upload-pack" : "",
        CONTENT_TYPE: request.headers.get("content-type") ?? "",
        CONTENT_LENGTH: String(input.length),
        GIT_PROTOCOL: request.headers.get("git-protocol") ?? "",
        REMOTE_USER: "wildwood",
      },
    );
    const split = raw.indexOf("\r\n\r\n");
    if (split < 0) throw new Error("Invalid Git CGI response");
    const headers = new Headers({ "cache-control": "private, no-store" });
    let status = 200;
    for (const line of raw.subarray(0, split).toString().split("\r\n")) {
      const colon = line.indexOf(":");
      if (colon < 0) continue;
      const name = line.slice(0, colon),
        value = line.slice(colon + 1).trim();
      if (name.toLowerCase() === "status") status = Number(value.slice(0, 3));
      else if (name.toLowerCase() !== "cache-control") headers.set(name, value);
    }
    return new Response(new Uint8Array(raw.subarray(split + 4)), { status, headers });
  };
}

export type GitMergeStage = { path: string; mode: FileMode; oid: string; stage: number };
export type GitMergePlan = {
  id: string;
  base: string;
  ours: string;
  theirs: string;
  oursCommit: string;
  theirsCommit: string;
  tree: string;
  archive: string;
  clean: boolean;
  stages: GitMergeStage[];
  messages: { paths: string[]; type: string; message: string }[];
  created: number;
};
export type GitResolution =
  | { path: string; side: "ours" | "theirs" }
  | { path: string; source: string }
  | { path: string; delete: true };
async function mergeMetadata<C extends Collections>(engine: ContentEngine<C>) {
  await metadata(engine);
  await engine.database.execute(
    "CREATE TABLE IF NOT EXISTS ww2_git_merges(repository TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(repository,id))",
  );
}
export async function readGitMerge<C extends Collections>(
  engine: ContentEngine<C>,
  id: string,
): Promise<GitMergePlan> {
  await mergeMetadata(engine);
  const row = (
    await engine.database.execute("SELECT data FROM ww2_git_merges WHERE repository=? AND id=?", [
      engine.config.repository,
      id,
    ])
  ).rows[0];
  if (!row) throw new Error("Merge plan unavailable");
  return JSON.parse(String(row.data));
}
/** Actual Git ort merge. All durable objects live in the configured blob store; the bare repo is disposable. */
export async function planGitMerge<C extends Collections>(
  engine: ContentEngine<C>,
  input: { base: string; ours: string; theirs: string },
) {
  await mergeMetadata(engine);
  const id = hash(
    JSON.stringify([
      engine.config.repository,
      engine.config.version,
      input.base,
      input.ours,
      input.theirs,
    ]),
  );
  const existing = (
    await engine.database.execute("SELECT data FROM ww2_git_merges WHERE repository=? AND id=?", [
      engine.config.repository,
      id,
    ])
  ).rows[0];
  if (existing) return JSON.parse(String(existing.data)) as GitMergePlan;
  const temp = await mkdtemp(join(tmpdir(), "wildwood-merge-"));
  const directory = join(temp, "repo.git");
  try {
    const author = { name: "Wildwood", email: "content@wildwood.invalid", timestamp: 1700000000 };
    await exportGit(engine, {
      snapshot: input.base,
      directory,
      branch: "base",
      message: "Content base\n",
      author,
    });
    const ours = await exportGit(engine, {
      snapshot: input.ours,
      directory,
      branch: "agent",
      message: "Agent draft\n",
      author,
    });
    const theirs = await exportGit(engine, {
      snapshot: input.theirs,
      directory,
      branch: "published",
      message: "Published content\n",
      author,
    });
    const result = await invoke(
      directory,
      [
        "-c",
        "merge.conflictStyle=diff3",
        "merge-tree",
        "--write-tree",
        "--messages",
        "-z",
        ours.oid,
        theirs.oid,
      ],
      undefined,
      {},
      true,
    );
    const parts = new TextDecoder("utf-8", { fatal: true }).decode(result.output).split("\0");
    const tree = parts.shift()!;
    if (!/^[a-f0-9]{40}$/.test(tree)) throw new Error("Unexpected Git merge output");
    const stages: GitMergeStage[] = [];
    while (parts[0]) {
      const match = /^(\d+) ([a-f0-9]{40}) ([123])\t([\s\S]+)$/.exec(parts.shift()!);
      if (!match) throw new Error("Unexpected Git conflict stage");
      if (!["100644", "100755", "120000"].includes(match[1]))
        throw new Error("Submodule merges are not supported");
      stages.push({
        mode: match[1] as FileMode,
        oid: match[2],
        stage: Number(match[3]),
        path: match[4],
      });
    }
    parts.shift();
    const messages: GitMergePlan["messages"] = [];
    while (parts[0]) {
      const count = Number(parts.shift());
      if (!Number.isSafeInteger(count) || count < 0 || count > parts.length - 2)
        throw new Error("Unexpected Git merge messages");
      const paths = parts.splice(0, count),
        type = parts.shift()!,
        message = parts.shift()!;
      messages.push({ paths, type, message });
    }
    const pack = await run(
      directory,
      ["pack-objects", "--stdout", "--revs"],
      `${ours.oid}\n${theirs.oid}\n${tree}\n`,
    );
    const archive = hash(pack);
    await engine.blobs.put(archive, pack);
    const plan: GitMergePlan = {
      id,
      ...input,
      oursCommit: ours.oid,
      theirsCommit: theirs.oid,
      tree,
      archive,
      clean: result.code === 0,
      stages,
      messages,
      created: Math.floor(Date.now() / 1000),
    };
    await engine.database.execute(
      "INSERT INTO ww2_git_merges(repository,id,data) VALUES(?,?,?) ON CONFLICT DO NOTHING",
      [engine.config.repository, id, JSON.stringify(plan)],
    );
    return readGitMerge(engine, id);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
async function hydrated<C extends Collections, T>(
  engine: ContentEngine<C>,
  plan: GitMergePlan,
  fn: (directory: string, temp: string) => Promise<T>,
) {
  const temp = await mkdtemp(join(tmpdir(), "wildwood-resolve-")),
    directory = join(temp, "repo.git");
  try {
    await run(temp, ["init", "--bare", directory]);
    await run(directory, ["index-pack", "--stdin"], await engine.bytes(plan.archive));
    return await fn(directory, temp);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
async function treeFiles(directory: string, tree: string) {
  const rows = (await run(directory, ["ls-tree", "-r", "-z", tree]))
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  return rows.map((row) => {
    const tab = row.indexOf("\t"),
      [mode, type, oid] = row.slice(0, tab).split(" ");
    if (type !== "blob" || !["100644", "100755", "120000"].includes(mode))
      throw new Error("Unsupported Git tree entry");
    return { path: row.slice(tab + 1), mode: mode as FileMode, oid };
  });
}
export async function readGitConflict<C extends Collections>(
  engine: ContentEngine<C>,
  id: string,
  path: string,
) {
  const plan = await readGitMerge(engine, id);
  if (!plan.stages.some((s) => s.path === path))
    throw new Error("Path is not conflicted in this merge");
  return hydrated(engine, plan, async (directory) => {
    const merged = (await treeFiles(directory, plan.tree)).find((f) => f.path === path);
    const content = async (oid?: string) => {
      if (!oid) return null;
      const size = Number((await run(directory, ["cat-file", "-s", oid])).toString());
      if (size > 128 * 1024) return { source: null, size, binary: false, tooLarge: true };
      const bytes = await run(directory, ["cat-file", "blob", oid]);
      try {
        const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        return {
          source: source.includes("\0") ? null : source,
          size,
          binary: source.includes("\0"),
        };
      } catch {
        return { source: null, size, binary: true };
      }
    };
    return {
      path,
      base: await content(plan.stages.find((s) => s.path === path && s.stage === 1)?.oid),
      ours: await content(plan.stages.find((s) => s.path === path && s.stage === 2)?.oid),
      theirs: await content(plan.stages.find((s) => s.path === path && s.stage === 3)?.oid),
      merged: await content(merged?.oid),
    };
  });
}
/** Resolve Git's staged conflicts, create a two-parent commit, and return a validated-engine input.
 * Does not move a content ref. The caller commits the ref and Git mapping atomically. */
export async function resolveGitMerge<C extends Collections>(
  engine: ContentEngine<C>,
  id: string,
  resolutions: GitResolution[],
  confirmConflicts = false,
) {
  const plan = await readGitMerge(engine, id);
  const required = new Set(plan.stages.map((s) => s.path)),
    seen = new Set<string>();
  if (!plan.clean && !confirmConflicts)
    throw new Error("Review and confirm Git's conflict messages before completing the merge");
  for (const r of resolutions) {
    if (!required.has(r.path) || seen.has(r.path))
      throw new Error("Unknown or duplicate conflict resolution");
    seen.add(r.path);
  }
  if ([...required].some((path) => !seen.has(path)))
    throw new Error("Resolve every conflicted path before updating the draft");
  return hydrated(engine, plan, async (directory, temp) => {
    const env = { GIT_INDEX_FILE: join(temp, "index") };
    await run(directory, ["read-tree", plan.tree], undefined, env);
    const merged = new Map((await treeFiles(directory, plan.tree)).map((f) => [f.path, f]));
    for (const resolution of resolutions) {
      let entry: { oid: string; mode: FileMode } | undefined;
      if ("side" in resolution)
        entry = plan.stages.find(
          (s) => s.path === resolution.path && s.stage === (resolution.side === "ours" ? 2 : 3),
        );
      else if ("source" in resolution) {
        if (Buffer.byteLength(resolution.source) > 128 * 1024)
          throw new Error("Resolution exceeds editing limit");
        if (/^(?:<{7}|={7}|>{7}|\|{7})(?: |$)/m.test(resolution.source))
          throw new Error("Remove conflict markers before saving the resolution");
        entry = {
          mode: merged.get(resolution.path)?.mode ?? "100644",
          oid: (await run(directory, ["hash-object", "-w", "--stdin"], resolution.source))
            .toString()
            .trim(),
        };
      }
      await run(
        directory,
        ["update-index", "-z", "--index-info"],
        entry
          ? `${entry.mode} ${entry.oid}\t${resolution.path}\0`
          : `0 ${"0".repeat(40)}\t${resolution.path}\0`,
        env,
      );
    }
    const tree = (await run(directory, ["write-tree"], undefined, env)).toString().trim();
    const date = `${plan.created} +0000`;
    const commit = (
      await run(
        directory,
        ["commit-tree", tree, "-p", plan.oursCommit, "-p", plan.theirsCommit],
        "Merge published content into agent branch\n",
        {
          GIT_AUTHOR_NAME: "Wildwood",
          GIT_AUTHOR_EMAIL: "content@wildwood.invalid",
          GIT_AUTHOR_DATE: date,
          GIT_COMMITTER_NAME: "Wildwood",
          GIT_COMMITTER_EMAIL: "content@wildwood.invalid",
          GIT_COMMITTER_DATE: date,
        },
      )
    )
      .toString()
      .trim();
    const files = await treeFiles(directory, tree),
      before = new Map((await engine.files(plan.ours)).map((f) => [f.path, f]));
    const changes: FileChange[] = [];
    for (const file of files) {
      const content = await run(directory, ["cat-file", "blob", file.oid]);
      const old = before.get(file.path);
      if (!old || old.blob !== hash(content) || old.mode !== file.mode)
        changes.push({ path: file.path, content, mode: file.mode });
      before.delete(file.path);
    }
    for (const path of before.keys()) changes.push({ path, delete: true });
    const pack = await run(directory, ["pack-objects", "--stdout", "--revs"], `${commit}\n`),
      archive = hash(pack);
    await engine.blobs.put(archive, pack);
    return { commit, archive, changes };
  });
}

export async function gitVersion() {
  return (await run(process.cwd(), ["--version"])).toString().trim();
}
