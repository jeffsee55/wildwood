/** Optional Node/Git transport. The content engine does not create Git objects on save. */
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ContentEngine } from "./engine";
import type { Collections, FileChange, FileMode } from "./types";
import { hash } from "./storage";

async function run(
  directory: string,
  args: string[],
  input?: Uint8Array | string,
  env: Record<string, string> = {},
): Promise<Buffer> {
  return new Promise((resolveResult, reject) => {
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
    );
    const child = spawn("git", ["-C", directory, ...args], {
      env: { ...inherited, GIT_CONFIG_NOSYSTEM: "1", ...env },
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
      code === 0
        ? resolveResult(Buffer.concat(output))
        : reject(new Error(Buffer.concat(errors).toString() || `git ${args[0]} failed`)),
    );
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
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
