import { afterEach, expect, test } from "vitest";
import { createClient } from "@libsql/client";
import { collection, createContent, libsql, markdown } from "wildwood-core";
import { z } from "zod";
import { createWeb } from "../src/server";
const clients: ReturnType<typeof createClient>[] = [];
afterEach(() => clients.splice(0).forEach((c) => c.close()));
async function fixture() {
  const client = createClient({ url: ":memory:" });
  clients.push(client);
  const database = libsql(client);
  const engine = createContent({
    database,
    repository: "content-tools",
    version: "1",
    variants: { locale: { options: ["en", "fr"], default: "en", path: "suffix" } },
    collections: {
      pages: collection({
        match: "pages/*.md",
        description: "Site pages",
        parse: markdown(
          z.object({ title: z.string().min(1), author: z.string(), body: z.string() }),
        ),
        filters: ["title"],
        references: { author: "authors" },
      }),
      authors: collection({
        match: "authors/*.md",
        parse: markdown(z.object({ name: z.string(), body: z.string() })),
      }),
    },
  });
  await engine.branch("main");
  await engine.apply({
    ref: "main",
    expectedRevision: 0,
    idempotencyKey: "seed",
    changes: [
      {
        path: "pages/start.md",
        content: "---\ntitle: Welcome\nauthor: /authors/team.md\n---\nOriginal **body**.",
      },
      {
        path: "pages/start.fr.md",
        content: "---\ntitle: Bienvenue\nauthor: /authors/team.md\n---\nBonjour.",
      },
      { path: "authors/team.md", content: "---\nname: Team\n---\nAbout us." },
    ],
  });
  const web = createWeb({
    database,
    engines: { "1": engine },
    version: "1",
    ref: "main",
    origin: "http://localhost:9999",
    development: true,
  });
  const login = await web.handler(
    new Request("http://localhost:9999/cms/local-login", {
      method: "POST",
      headers: { origin: "http://localhost:9999" },
    }),
  );
  const headers = new Headers({ cookie: login.headers.get("set-cookie")!.split(";")[0] });
  const created = await web.command(await web.view(headers), { type: "draft" });
  headers.set("cookie", `${headers.get("cookie")}; ww-view=${created.viewToken}`);
  const view = await web.view(headers);
  const grant = await web.command(view, { type: "agent", write: true, createDrafts: true });
  async function rpc(method: string, params: unknown = {}, token = String(grant.token)) {
    const response = await web.handler(
      new Request("http://localhost:9999/cms/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      }),
    );
    return { status: response.status, body: await response.json() };
  }
  async function call(name: string, args = {}) {
    const { status, body } = await rpc("tools/call", { name, arguments: args });
    expect(status).toBe(200);
    expect(body.error, JSON.stringify(body)).toBeUndefined();
    const result = body.result;
    const data = JSON.parse(result.content[0].text);
    if (result.structuredContent) expect(result.structuredContent).toEqual(data);
    return { ...data, failed: !!result.isError };
  }
  return { engine, database, web, headers, view, grant, rpc, call };
}
test("MCP discovers schemas and resources, searches after locale fallback, and resolves references", async () => {
  const { call, rpc } = await fixture();
  const discovered = await call("discover_content");
  expect(discovered.collections[0].schema.required).toContain("title");
  expect(discovered.collections[0].fieldsEditable).toBe(true);
  const resources = await rpc("resources/read", { uri: "wildwood://schema" });
  expect(JSON.parse(resources.body.result.contents[0].text).repository).toBe("content-tools");
  expect(
    (
      await call("read_documents", {
        collection: "pages",
        search: "welcome",
        variant: { locale: "fr" },
      })
    ).items,
  ).toHaveLength(0);
  const french = await call("read_documents", {
    collection: "pages",
    search: "bonjour",
    variant: { locale: "fr" },
  });
  expect(french.items[0].path).toBe("pages/start.fr.md");
  expect(french.items[0].value.body).toBeUndefined();
  expect(
    (
      await call("resolve_reference", {
        collection: "pages",
        canonical: "pages/start.md",
        field: "author",
      })
    ).document.value.name,
  ).toBe("Team");
});
test("batch writes are atomic; dry runs store nothing; field patches and retries preserve body and audit history", async () => {
  const { engine, database, view, call } = await fixture();
  const initial = await engine.ref(view.ref!.name);
  const counts = async () =>
    (await database.execute("SELECT COUNT(*) AS n FROM ww2_snapshots")).rows[0].n;
  const before = await counts();
  const invalid = [
    { path: "pages/new.md", source: "---\ntitle: New\nauthor: /authors/team.md\n---\nText" },
    { path: "pages/start.md", source: "bad" },
  ];
  expect(
    (await call("validate_changes", { revision: initial.revision, changes: invalid })).valid,
  ).toBe(false);
  expect(await counts()).toBe(before);
  expect(
    (await call("apply_changes", { revision: initial.revision, command: "bad", changes: invalid }))
      .error.code,
  ).toBe("VALIDATION_FAILED");
  expect(await engine.ref(view.ref!.name)).toEqual(initial);
  const args = {
    path: "pages/start.md",
    revision: initial.revision,
    command: "patch",
    fields: { title: "Changed" },
  };
  const first = await call("update_document", args);
  const replay = await call("update_document", args);
  expect(replay).toEqual(first);
  expect((await call("read_source", { path: "pages/start.md" })).source).toContain(
    "Original **body**.",
  );
  expect(
    (await call("update_document", { ...args, fields: { title: "Different" } })).error.code,
  ).toBe("CONFLICT");
  const events = await database.execute("SELECT * FROM ww2_events WHERE repository=? AND ref=?", [
    engine.config.repository,
    view.ref!.name,
  ]);
  expect(events.rows).toHaveLength(1);
  expect(events.rows[0].source).toBe("mcp");
  expect((await engine.query("pages", { ref: "main" })).items[0].value.title).toBe("Welcome");
});
test("content writes cannot escape collections, forge another draft, or overwrite a newer revision", async () => {
  const { call, view, engine } = await fixture();
  expect(
    (await call("write_source", { path: ".env", source: "secret", revision: 0, command: "escape" }))
      .failed,
  ).toBe(true);
  expect((await call("read_source", { path: "../secret.md" })).failed).toBe(true);
  expect(
    (await call("read_documents", { collection: "pages", draft: "someone-elses-draft" })).error
      .code,
  ).toBe("ACCESS_DENIED");
  const one = await call("update_document", {
    path: "pages/start.md",
    revision: 0,
    command: "one",
    fields: { title: "One" },
  });
  expect(one.failed).toBe(false);
  expect(
    (
      await call("update_document", {
        path: "pages/start.md",
        revision: 0,
        command: "two",
        fields: { title: "Two" },
      })
    ).error.code,
  ).toBe("CONFLICT");
  expect((await engine.ref(view.ref!.name)).revision).toBe(1);
});
test("MCP creates pinned previews, submits reviews, and publishes only after an exact human approval", async () => {
  const { call, web, headers, view, engine } = await fixture();
  await call("update_document", {
    path: "pages/start.md",
    revision: 0,
    command: "ready",
    fields: { title: "Ready" },
  });
  const preview = await call("create_preview");
  const landing = await web.handler(new Request(preview.url));
  const shared = await web.view(
    new Headers({ cookie: landing.headers.get("set-cookie")!.split(";")[0] }),
  );
  expect(shared.snapshot).toBe(preview.snapshot);
  expect((await call("get_draft_changes")).changes).toEqual([
    { path: "pages/start.md", status: "modified" },
  ]);
  const review = await call("submit_review");
  const current = await web.view(headers);
  await expect(
    web.command(current, { type: "publish", id: review.id, revision: review.revision }),
  ).rejects.toThrow("Approval required");
  await web.command(current, {
    type: "review-decision",
    id: review.id,
    revision: review.revision,
    decision: "approve",
  });
  await web.command(current, { type: "publish", id: review.id, revision: review.revision });
  expect((await engine.query("pages", { ref: "main" })).items[0].value.title).toBe("Ready");
  expect((await engine.ref(view.ref!.name)).snapshot).toBe(shared.snapshot);
});
test("MCP rejects oversized streams and foreign browser origins", async () => {
  const { web, grant } = await fixture();
  const request = (body: string, origin?: string) =>
    new Request("http://localhost:9999/cms/mcp", {
      method: "POST",
      body,
      headers: { authorization: `Bearer ${grant.token}`, ...(origin ? { origin } : {}) },
    });
  expect((await web.handler(request("x".repeat(1024 * 1024 + 1)))).status).toBe(413);
  expect((await web.handler(request("{}", "https://malicious.example"))).status).toBe(403);
});

test("history restores a previous file as a new revision and rejects unrelated snapshots", async () => {
  const { call, view, engine } = await fixture();
  await call("update_document", {
    path: "pages/start.md",
    revision: 0,
    command: "change",
    fields: { title: "Changed" },
  });
  const history = await call("get_history");
  expect(history.events).toHaveLength(1);
  const restored = await call("restore_document", {
    path: "pages/start.md",
    snapshot: history.events[0].before_snapshot,
    revision: 1,
    command: "restore",
  });
  expect(restored.revision).toBe(2);
  expect((await engine.query("pages", { ref: view.ref!.name })).items[0].value.title).toBe(
    "Welcome",
  );
  expect(
    (
      await call("restore_document", {
        path: "pages/start.md",
        snapshot: "unknown",
        revision: 2,
        command: "forbidden",
      })
    ).failed,
  ).toBe(true);
});

test("publication rejects dangling references and unsubmitted edits without locking the draft", async () => {
  const { call, web, headers, view, engine, database } = await fixture();
  await call("apply_changes", {
    revision: 0,
    command: "delete-author",
    changes: [{ path: "authors/team.md", delete: true }],
  });
  const review = await call("submit_review");
  let current = await web.view(headers);
  await web.command(current, {
    type: "review-decision",
    id: review.id,
    revision: review.revision,
    decision: "approve",
  });
  await expect(
    web.command(current, { type: "publish", id: review.id, revision: review.revision }),
  ).rejects.toThrow("Unresolved author");
  expect(
    (await database.execute("SELECT * FROM ww2_ref_locks WHERE name=?", [view.ref!.name])).rows,
  ).toHaveLength(0);
  const history = await call("get_history");
  await call("restore_document", {
    path: "authors/team.md",
    snapshot: history.events[0].before_snapshot,
    revision: 1,
    command: "repair",
  });
  const repaired = await call("submit_review");
  current = await web.view(headers);
  await web.command(current, {
    type: "review-decision",
    id: repaired.id,
    revision: repaired.revision,
    decision: "approve",
  });
  await call("update_document", {
    path: "pages/start.md",
    revision: 2,
    command: "unreviewed",
    fields: { title: "Unreviewed" },
  });
  await expect(
    web.command(current, { type: "publish", id: repaired.id, revision: repaired.revision }),
  ).rejects.toThrow("unsubmitted");
  expect((await engine.query("pages", { ref: "main" })).items[0].value.title).toBe("Welcome");
});

test("content validation checks all locales without advancing the draft and rejects stale snapshots", async () => {
  const { call, engine, view, database } = await fixture();
  const initial = await call("validate_content");
  expect(initial.valid).toBe(true);
  const removed = await call("apply_changes", {
    revision: 0,
    command: "validation-remove-author",
    changes: [{ path: "authors/team.md", delete: true }],
  });
  const before = await engine.ref(view.ref!.name);
  const events = await database.execute("SELECT COUNT(*) AS count FROM ww2_events");
  const broken = await call("validate_content", { snapshot: removed.snapshot });
  expect(broken.valid).toBe(false);
  expect(broken.failed).toBe(false);
  expect(broken.diagnostics.map((d: { path: string }) => d.path).sort()).toEqual([
    "pages/start.fr.md",
    "pages/start.md",
  ]);
  expect(
    broken.diagnostics.every((d: { message: string }) => d.message.includes("Unresolved author")),
  ).toBe(true);
  expect(await engine.ref(view.ref!.name)).toEqual(before);
  expect(await database.execute("SELECT COUNT(*) AS count FROM ww2_events")).toEqual(events);
  expect((await call("validate_content", { snapshot: initial.snapshot })).error.code).toBe(
    "CONFLICT",
  );
  await call("restore_document", {
    path: "authors/team.md",
    snapshot: initial.snapshot,
    revision: 1,
    command: "validation-repair-author",
  });
  expect((await call("validate_content")).valid).toBe(true);
});

test("simultaneous editors get one winner, and pagination detects a changed ref", async () => {
  const { call, engine, view } = await fixture();
  const before = await call("read_documents", { collection: "pages" });
  const results = await Promise.all(
    ["First", "Second"].map((title) =>
      call("write_source", {
        path: "pages/start.md",
        revision: 0,
        command: title,
        source: `---\ntitle: ${title}\nauthor: /authors/team.md\n---\nBody`,
      }),
    ),
  );
  expect(results.filter((r) => !r.failed)).toHaveLength(1);
  expect(results.filter((r) => r.error?.code === "CONFLICT")).toHaveLength(1);
  expect((await engine.ref(view.ref!.name)).revision).toBe(1);
  expect(
    (await call("read_documents", { collection: "pages", snapshot: before.snapshot })).error.code,
  ).toBe("CONFLICT");
});
