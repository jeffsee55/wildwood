import { createClient } from "@libsql/client";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, chmod, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { afterEach, expect, test } from "vitest";
import { z } from "zod";
import { collection, createContent, libsql, markdown } from "../src";
import {
  createGitHandler,
  exportGit,
  importGit,
  planGitMerge,
  readGitConflict,
  resolveGitMerge,
} from "../src/git";
const exec = promisify(execFile);
const roots: string[] = [],
  clients: ReturnType<typeof createClient>[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "ww-v2-test-"));
  roots.push(root);
  const source = join(root, "source");
  await mkdir(source);
  await exec("git", ["init", "-b", "main", source]);
  await exec("git", ["-C", source, "config", "user.name", "Test"]);
  await exec("git", ["-C", source, "config", "user.email", "test@example.com"]);
  await mkdir(join(source, "docs"));
  await writeFile(join(source, "docs/a.md"), "---\ntitle: Original\n---\nBody");
  await writeFile(join(source, "image.bin"), Buffer.from([0, 255, 1, 128]));
  await writeFile(join(source, "script.sh"), "#!/bin/sh\necho hi\n");
  await chmod(join(source, "script.sh"), 0o755);
  await symlink("docs/a.md", join(source, "link"));
  await exec("git", ["-C", source, "add", "."]);
  await exec("git", ["-C", source, "commit", "-m", "Initial"]);
  const oid = (await exec("git", ["-C", source, "rev-parse", "HEAD"])).stdout.trim();
  const client = createClient({ url: ":memory:" });
  clients.push(client);
  const engine = createContent({
    repository: "git",
    version: "1",
    database: libsql(client),
    collections: {
      docs: collection({
        match: "docs/*.md",
        parse: markdown(z.object({ title: z.string(), body: z.string() })),
        filters: ["title"],
      }),
    },
  });
  return { root, source, engine, oid };
}
test("Git import/export preserves commit identity, binary bytes and file modes; edited commit retains parent", async () => {
  const { root, source, engine, oid } = await setup();
  const imported = await importGit(engine, { directory: source, targetRef: "main" });
  const bare = join(root, "export.git");
  const author = { name: "Agent", email: "agent@example.com", timestamp: 1700000000 };
  const exported = await exportGit(engine, {
    snapshot: imported.snapshot,
    directory: bare,
    message: "Ignored for existing commit",
    author,
  });
  expect(exported.oid).toBe(oid);
  expect((await exec("git", ["-C", bare, "ls-tree", "-r", "HEAD"])).stdout).toBe(
    (await exec("git", ["-C", source, "ls-tree", "-r", "HEAD"])).stdout,
  );
  const edited = await engine.apply({
    ref: "main",
    expectedRevision: imported.revision,
    idempotencyKey: "edit",
    changes: [{ path: "docs/a.md", content: "---\ntitle: Updated\n---\nBody" }],
  });
  const next = await exportGit(engine, {
    snapshot: edited.snapshot,
    directory: bare,
    message: "Edit\n",
    author,
  });
  expect((await exec("git", ["-C", bare, "rev-parse", "HEAD^"])).stdout.trim()).toBe(oid);
  expect((await exec("git", ["-C", bare, "show", "HEAD:docs/a.md"])).stdout).toContain("Updated");
  await exec("git", ["-C", bare, "fsck", "--strict"]);
  expect(next.oid).not.toBe(oid);
  const clone = join(root, "clone");
  await exec("git", ["clone", bare, clone]);
  expect(await readFile(join(clone, "image.bin"))).toEqual(Buffer.from([0, 255, 1, 128]));
});

test("Smart HTTP supports a real clone and denies unauthorized fetches and pushes", async () => {
  const { root, source, engine } = await setup();
  const imported = await importGit(engine, { directory: source, targetRef: "main" });
  const bare = join(root, "served.git");
  await exportGit(engine, {
    snapshot: imported.snapshot,
    directory: bare,
    message: "Snapshot",
    author: { name: "Test", email: "test@example.com" },
  });
  const handler = createGitHandler({
    directory: bare,
    authorize: async (req) => req.headers.get("x-test-access") === "yes",
  });
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const request = new Request(`http://localhost${req.url}`, {
        method: req.method,
        headers: req.headers as Record<string, string>,
        ...(req.method === "POST" ? { body: Buffer.concat(chunks) } : {}),
      });
      const response = await handler(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      res.writeHead(500);
      res.end(String(error));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}/repo.git`;
  try {
    expect((await fetch(`${url}/info/refs?service=git-upload-pack`)).status).toBe(401);
    expect(
      (
        await fetch(`${url}/info/refs?service=git-receive-pack`, {
          headers: { "x-test-access": "yes" },
        })
      ).status,
    ).toBe(403);
    const clone = join(root, "http-clone");
    await exec("git", ["-c", "http.extraHeader=x-test-access: yes", "clone", url, clone], {
      timeout: 15000,
    });
    expect(await readFile(join(clone, "docs/a.md"), "utf8")).toContain("Original");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("native Git merges separate edits in one file and retains both commit parents", async () => {
  const { engine, source, root } = await setup();
  const base = await importGit(engine, { directory: source, targetRef: "main" });
  await engine.branch("agent/a", { snapshot: base.snapshot });
  await engine.branch("agent/b", { snapshot: base.snapshot });
  const a = await engine.apply({
    ref: "agent/a",
    expectedRevision: 0,
    idempotencyKey: "a",
    changes: [{ path: "docs/a.md", content: "---\ntitle: Agent title\n---\nBody" }],
  });
  const b = await engine.apply({
    ref: "agent/b",
    expectedRevision: 0,
    idempotencyKey: "b",
    changes: [{ path: "docs/a.md", content: "---\ntitle: Original\n---\nUpdated body" }],
  });
  const plan = await planGitMerge(engine, {
    base: base.snapshot,
    ours: a.snapshot,
    theirs: b.snapshot,
  });
  expect(plan.clean).toBe(true);
  expect(
    await planGitMerge(engine, { base: base.snapshot, ours: a.snapshot, theirs: b.snapshot }),
  ).toEqual(plan);
  const resolved = await resolveGitMerge(engine, plan.id, []);
  const change = resolved.changes.find((c) => c.path === "docs/a.md")!;
  expect("content" in change && Buffer.from(change.content).toString()).toContain("Agent title");
  expect("content" in change && Buffer.from(change.content).toString()).toContain("Updated body");
  const bare = join(root, "merged.git");
  await exec("git", ["init", "--bare", bare]);
  const { spawn } = await import("node:child_process");
  const bytes = await engine.bytes(resolved.archive);
  await new Promise<void>((resolve, reject) => {
    const c = spawn("git", ["-C", bare, "index-pack", "--stdin"]);
    c.stdin.end(bytes);
    c.on("close", (code) => (code === 0 ? resolve() : reject(new Error("index-pack failed"))));
    c.on("error", reject);
  });
  expect(
    (await exec("git", ["-C", bare, "show", "-s", "--format=%P", resolved.commit])).stdout.trim(),
  ).toBe(`${plan.oursCommit} ${plan.theirsCommit}`);
  await exec("git", ["-C", bare, "fsck", "--strict", "--no-reflogs", resolved.commit]);
});

test("Git conflict plans survive retries, require all resolutions, and preserve conflict-marker source", async () => {
  const { engine, source } = await setup();
  const base = await importGit(engine, { directory: source, targetRef: "main" });
  await engine.branch("agent/a", { snapshot: base.snapshot });
  await engine.branch("agent/b", { snapshot: base.snapshot });
  const a = await engine.apply({
    ref: "agent/a",
    expectedRevision: 0,
    idempotencyKey: "a",
    changes: [{ path: "docs/a.md", content: "---\ntitle: Our title\n---\nBody" }],
  });
  const b = await engine.apply({
    ref: "agent/b",
    expectedRevision: 0,
    idempotencyKey: "b",
    changes: [{ path: "docs/a.md", content: "---\ntitle: Their title\n---\nBody" }],
  });
  const plan = await planGitMerge(engine, {
    base: base.snapshot,
    ours: a.snapshot,
    theirs: b.snapshot,
  });
  expect(plan.clean).toBe(false);
  expect(plan.messages.some((m) => m.type === "CONFLICT (contents)")).toBe(true);
  const file = await readGitConflict(engine, plan.id, "docs/a.md");
  expect(file.merged?.source).toContain("<<<<<<<");
  expect(file.base?.source).toContain("Original");
  await expect(resolveGitMerge(engine, plan.id, [], true)).rejects.toThrow("every conflicted path");
  await expect(
    resolveGitMerge(engine, plan.id, [{ path: "docs/a.md", source: file.merged!.source! }], true),
  ).rejects.toThrow("conflict markers");
  const result = await resolveGitMerge(
    engine,
    plan.id,
    [{ path: "docs/a.md", side: "theirs" }],
    true,
  );
  expect(result.changes).toHaveLength(1);
  expect(Buffer.from((result.changes[0] as { content: Uint8Array }).content).toString()).toContain(
    "Their title",
  );
  expect((await engine.ref("agent/a")).snapshot).toBe(a.snapshot);
});

test("Git detects a rename and combines it with the other branch's edit", async () => {
  const { engine, source } = await setup();
  const base = await importGit(engine, { directory: source, targetRef: "main" });
  await engine.branch("agent", { snapshot: base.snapshot });
  const ours = await engine.apply({
    ref: "agent",
    expectedRevision: 0,
    idempotencyKey: "rename",
    changes: [
      { path: "docs/a.md", delete: true },
      { path: "docs/renamed.md", content: "---\ntitle: Original\n---\nBody" },
    ],
  });
  const theirs = await engine.apply({
    ref: "main",
    expectedRevision: base.revision,
    idempotencyKey: "edit",
    changes: [{ path: "docs/a.md", content: "---\ntitle: Updated\n---\nBody" }],
  });
  const plan = await planGitMerge(engine, {
    base: base.snapshot,
    ours: ours.snapshot,
    theirs: theirs.snapshot,
  });
  expect(plan.clean).toBe(true);
  const result = await resolveGitMerge(engine, plan.id, []);
  expect(result.changes.map((c) => c.path)).toEqual(["docs/renamed.md"]);
});

test("Git handles modify/delete and binary conflicts with explicit whole-file resolutions", async () => {
  const { engine, source } = await setup();
  const base = await importGit(engine, { directory: source, targetRef: "main" });
  await engine.branch("agent", { snapshot: base.snapshot });
  const ours = await engine.apply({
    ref: "agent",
    expectedRevision: 0,
    idempotencyKey: "ours",
    changes: [
      { path: "docs/a.md", delete: true },
      { path: "image.bin", content: new Uint8Array([0, 1, 2]) },
    ],
  });
  const theirs = await engine.apply({
    ref: "main",
    expectedRevision: base.revision,
    idempotencyKey: "theirs",
    changes: [
      { path: "docs/a.md", content: "---\ntitle: Published\n---\nBody" },
      { path: "image.bin", content: new Uint8Array([0, 3, 4]) },
    ],
  });
  const plan = await planGitMerge(engine, {
    base: base.snapshot,
    ours: ours.snapshot,
    theirs: theirs.snapshot,
  });
  expect(plan.clean).toBe(false);
  expect(plan.messages.some((m) => m.type === "CONFLICT (modify/delete)")).toBe(true);
  expect((await readGitConflict(engine, plan.id, "image.bin")).merged?.binary).toBe(true);
  const result = await resolveGitMerge(
    engine,
    plan.id,
    [
      { path: "docs/a.md", side: "ours" },
      { path: "image.bin", side: "theirs" },
    ],
    true,
  );
  expect(result.changes).toHaveLength(1);
  expect((result.changes[0] as { content: Uint8Array }).content).toEqual(Buffer.from([0, 3, 4]));
});

test("Git rename/rename conflicts retain both destinations until an explicit resolution", async () => {
  const { engine, source } = await setup();
  const base = await importGit(engine, { directory: source, targetRef: "main" });
  await engine.branch("agent", { snapshot: base.snapshot });
  const sourceText = "---\ntitle: Original\n---\nBody";
  const ours = await engine.apply({
    ref: "agent",
    expectedRevision: 0,
    idempotencyKey: "ours",
    changes: [
      { path: "docs/a.md", delete: true },
      { path: "docs/ours.md", content: sourceText },
    ],
  });
  const theirs = await engine.apply({
    ref: "main",
    expectedRevision: base.revision,
    idempotencyKey: "theirs",
    changes: [
      { path: "docs/a.md", delete: true },
      { path: "docs/theirs.md", content: sourceText },
    ],
  });
  const plan = await planGitMerge(engine, {
    base: base.snapshot,
    ours: ours.snapshot,
    theirs: theirs.snapshot,
  });
  expect(plan.clean).toBe(false);
  expect(plan.messages.some((m) => m.type === "CONFLICT (rename/rename)")).toBe(true);
  const result = await resolveGitMerge(
    engine,
    plan.id,
    [...new Set(plan.stages.map((s) => s.path))].map((path) => ({ path, side: "ours" as const })),
    true,
  );
  expect(result.changes).toHaveLength(0);
});
