import { createClient } from "@libsql/client";
import { createContent, collection, markdown, libsql } from "wildwood-core";
import { z } from "zod";
import { test, expect, afterEach, vi } from "vitest";
import { createWeb, sourcemap, withSourcemap, assets } from "../src/server";
import { wildwoodWellKnown, withWildwood } from "../src/next/config";
const clients: ReturnType<typeof createClient>[] = [];
afterEach(() => clients.splice(0).forEach((c) => c.close()));
async function setup(external = false, publishedRef = "main") {
  const client = createClient({ url: ":memory:" });
  clients.push(client);
  const database = libsql(client);
  const engine = createContent({
    repository: "web",
    version: "1",
    database,
    variants: { locale: { options: ["en", "fr"], default: "en", path: "suffix" } },
    collections: {
      docs: collection({
        match: "*.md",
        parse: markdown(z.object({ title: z.string(), body: z.string() })),
        filters: ["title"],
      }),
    },
  });
  await engine.branch(publishedRef);
  await engine.apply({
    ref: publishedRef,
    expectedRevision: 0,
    idempotencyKey: "seed",
    changes: [{ path: "a.md", content: "---\ntitle: Original\n---\nBody" }],
  });
  const web = createWeb({
    database,
    engines: { "1": engine },
    version: "1",
    origin: "http://localhost:9999",
    development: true,
    ref: publishedRef,
    ...(external ? { reviewAuthority: { kind: "external" as const, label: "GitHub" } } : {}),
    variant: { locale: "en" },
  });
  const login = await web.handler(
    new Request("http://localhost:9999/cms/local-login", {
      method: "POST",
      headers: { origin: "http://localhost:9999" },
    }),
  );
  const headers = new Headers({ cookie: login.headers.get("set-cookie")!.split(";")[0] });
  const start = await web.command(await web.view(headers), { type: "draft" });
  headers.set("cookie", headers.get("cookie") + `; ww-view=${start.viewToken}`);
  return { web, engine, headers, database };
}
test("a source-mapped edit validates on the server, preserves published content, and rejects stale maps", async () => {
  const { web, engine, headers } = await setup();
  const view = await web.view(headers);
  const doc = (await engine.query("docs", { snapshot: view.snapshot })).items[0];
  const map = sourcemap(withSourcemap("web", doc), "title")["data-ww-contentmap"]!;
  const loaded = await web.command(view, { type: "document", map });
  expect(loaded.source).toContain("Original");
  await expect(
    web.command(view, {
      type: "save",
      map,
      source: "Missing title",
      revision: view.ref!.revision,
      command: "bad",
    }),
  ).rejects.toThrow();
  expect((await web.view(headers)).snapshot).toBe(view.snapshot);
  await web.command(view, {
    type: "save",
    map,
    source: "---\ntitle: Changed\n---\nBody",
    revision: view.ref!.revision,
    command: "good",
  });
  expect((await engine.query("docs", { ref: "main" })).items[0].value.title).toBe("Original");
  const updated = await web.view(headers);
  expect((await engine.query("docs", { snapshot: updated.snapshot })).items[0].value.title).toBe(
    "Changed",
  );
  await expect(web.command(updated, { type: "document", map })).rejects.toThrow("stale");
  const forged = JSON.stringify({ ...JSON.parse(map), repository: "another" });
  await expect(web.command(updated, { type: "document", map: forged })).rejects.toThrow();
});
test("share exchange pins variant and generation, grants no writes, and revocation invalidates an existing session", async () => {
  const { web, headers } = await setup();
  const view = await web.view(headers, { variant: { locale: "fr" } });
  const shared = await web.command(view, { type: "share", minutes: 60 });
  const response = await web.handler(new Request(String(shared.url)));
  expect(response.status).toBe(303);
  const recipient = new Headers({ cookie: response.headers.get("set-cookie")!.split(";")[0] });
  const pinned = await web.view(recipient, { variant: { locale: "en" } });
  expect(pinned.mode).toBe("pinned");
  expect(pinned.variant.locale).toBe("fr");
  await expect(web.command(pinned, { type: "draft" })).rejects.toThrow("Sign in");
  await web.command(view, { type: "revoke", id: shared.id });
  expect((await web.view(recipient)).mode).toBe("published");
});
test("reviews require revision-bound approval and publish idempotently", async () => {
  const { web, engine, headers } = await setup();
  const view = await web.view(headers);
  const created = await web.command(view, { type: "review" });
  const id = created.id,
    revision = created.revision;
  await expect(web.command(view, { type: "publish", id, revision })).rejects.toThrow(
    "Approval required",
  );
  await web.command(view, { type: "review-decision", id, revision, decision: "approve" });
  const first = await web.command(view, { type: "publish", id, revision });
  expect(first.published).toBe(view.snapshot);
  expect(await web.command(view, { type: "publish", id, revision })).toEqual(first);
  expect((await engine.ref("main")).revision).toBe(2);
  expect((await web.view(headers)).mode).toBe("published");
  const state = await web.state(await web.view(headers));
  expect(state.drafts).toHaveLength(0);
  expect(state.completed).toHaveLength(1);
  await expect(web.command(view, { type: "resume", id: view.viewId })).rejects.toThrow("read-only");
  await expect(
    engine.apply({
      ref: view.ref!.name,
      expectedRevision: view.ref!.revision,
      changes: [{ path: "a.md", content: "---\ntitle: Forbidden\n---\nBody" }],
      idempotencyKey: "after-publish",
    }),
  ).rejects.toThrow("read-only");
  await expect(
    engine.moveRef({
      ref: view.ref!.name,
      expectedRevision: view.ref!.revision,
      expectedSnapshot: view.snapshot,
      snapshot: view.snapshot,
      idempotencyKey: "move-completed",
    }),
  ).rejects.toThrow("read-only");
});
test("new revisions retain discussion and cannot reuse an earlier approval", async () => {
  const { web, engine, headers } = await setup();
  const view = await web.view(headers);
  const first = await web.command(view, { type: "review" });
  await web.command(view, {
    type: "review-decision",
    id: first.id,
    revision: first.revision,
    decision: "approve",
  });
  await engine.apply({
    ref: view.ref!.name,
    expectedRevision: view.ref!.revision,
    idempotencyKey: "next",
    changes: [{ path: "a.md", content: "---\ntitle: Next\n---\nNew body" }],
  });
  const second = await web.command(await web.view(headers), { type: "review" });
  expect(second.id).toBe(first.id);
  expect(second.revision).not.toBe(first.revision);
  await expect(
    web.command(view, { type: "publish", id: second.id, revision: second.revision }),
  ).rejects.toThrow("Approval required");
  await expect(
    web.command(view, { type: "publish", id: first.id, revision: first.revision }),
  ).rejects.toThrow("newer revision");
  const data = await web.handler(
    new Request(`http://localhost:9999/cms/review/data?id=${first.id}`, { headers }),
  );
  const body = await data.json();
  expect(body.revisions).toHaveLength(2);
  expect(body.activity).toHaveLength(1);
  await web.command(view, {
    type: "review-decision",
    id: second.id,
    revision: second.revision,
    decision: "approve",
  });
  await engine.apply({
    ref: "main",
    expectedRevision: 1,
    idempotencyKey: "external",
    changes: [{ path: "b.md", content: "---\ntitle: External\n---\nBody" }],
  });
  await expect(
    web.command(view, { type: "publish", id: second.id, revision: second.revision }),
  ).rejects.toThrow("Destination advanced");
});
test("review invitations bind one identity and keep commenting separate from approval", async () => {
  const { web, headers } = await setup();
  const view = await web.view(headers);
  const created = await web.command(view, { type: "review" });
  const invite = await web.command(view, {
    type: "review-invite",
    id: created.id,
    scope: "comment",
    minutes: 60,
  });
  const token = new URL(String(invite.url)).searchParams.get("invite");
  const guest = { ...view, actor: { id: "guest", name: "Guest", role: "reader" as const } };
  await expect(
    web.command(guest, {
      type: "review-decision",
      id: created.id,
      revision: created.revision,
      decision: "comment",
      body: "Before grant",
    }),
  ).rejects.toThrow("denied");
  await web.command(guest, { type: "review-claim", token });
  await web.command(guest, {
    type: "review-decision",
    id: created.id,
    revision: created.revision,
    decision: "comment",
    body: "Looks readable",
  });
  await expect(
    web.command(guest, {
      type: "review-decision",
      id: created.id,
      revision: created.revision,
      decision: "approve",
    }),
  ).rejects.toThrow("permission");
  await expect(
    web.command(
      { ...guest, actor: { ...guest.actor, id: "other" } },
      { type: "review-claim", token },
    ),
  ).rejects.toThrow("already claimed");
  const data = await (
    await web.handler(
      new Request(`http://localhost:9999/cms/review/data?id=${created.id}`, { headers }),
    )
  ).json();
  await web.command(view, { type: "review-revoke", id: created.id, grant: data.grants[0].id });
  await expect(
    web.command(guest, {
      type: "review-decision",
      id: created.id,
      revision: created.revision,
      decision: "comment",
      body: "After revocation",
    }),
  ).rejects.toThrow("denied");
  await expect(web.command(guest, { type: "review-claim", token })).rejects.toThrow("expired");
});
test("assets are immutable, ETagged and independent of auth; discovery wrapper preserves existing routing", async () => {
  const { web } = await setup();
  const url = `http://localhost:9999/cms/assets/${assets["toolbar.js"].path}`;
  const response = await web.handler(new Request(url));
  expect(response.headers.get("cache-control")).toContain("immutable");
  expect(await response.text()).toContain("customElements");
  expect(
    (
      await web.handler(
        new Request(url, { headers: { "if-none-match": response.headers.get("etag")! } }),
      )
    ).status,
  ).toBe(304);
  const old = { rewrites: async () => [{ source: "/a", destination: "/b" }] };
  expect(withWildwood(old)).toBe(old);
  const merged = await withWildwood(old, { mcpDiscovery: true }).rewrites!();
  expect(merged).toEqual({
    beforeFiles: wildwoodWellKnown(),
    afterFiles: await old.rewrites(),
    fallback: [],
  });
});
test("mutation endpoints reject foreign origins; anonymous MCP clients receive a discovery challenge", async () => {
  const { web } = await setup();
  const response = await web.handler(
    new Request("http://localhost:9999/cms/local-login", {
      method: "POST",
      headers: { origin: "https://evil.test" },
    }),
  );
  expect(response.status).toBe(400);
  const mcp = await web.handler(new Request("http://localhost:9999/cms/mcp", { method: "POST" }));
  expect(mcp.status).toBe(401);
  expect(mcp.headers.get("www-authenticate")).toContain("oauth-protected-resource");
});
test("a delegated MCP credential reads only its draft and stops working after revocation", async () => {
  const { web, headers } = await setup();
  const current = await web.view(headers);
  const grant = await web.command(current, {
    type: "agent",
    createDrafts: false,
    write: false,
    minutes: 15,
  });
  const request = () =>
    new Request("http://localhost:9999/cms/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${grant.token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
  const response = await web.handler(request());
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.result.tools.map((t: { name: string }) => t.name)).toEqual([
    "validate_content",
    "discover_content",
    "list_files",
    "read_file",
    "read_documents",
    "read_source",
    "resolve_reference",
    "get_draft_changes",
    "get_history",
  ]);
  await web.command(current, { type: "revoke", id: grant.id });
  expect((await web.handler(request())).status).toBe(401);
});

test("expired shares cannot be exchanged and expired delegated credentials are rejected", async () => {
  const { web, headers, database } = await setup();
  const view = await web.view(headers);
  const share = await web.command(view, { type: "share", minutes: 1 });
  const agent = await web.command(view, {
    type: "agent",
    createDrafts: false,
    minutes: 1,
    write: true,
  });
  await database.execute(
    "UPDATE ww_web_records SET expires=0 WHERE repository='web' AND kind IN ('share','agent')",
  );
  expect((await web.handler(new Request(String(share.url)))).status).toBe(403);
  const response = await web.handler(
    new Request("http://localhost:9999/cms/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${agent.token}` },
    }),
  );
  expect(response.status).toBe(401);
});

test("another account cannot resume a private draft or turn a preview into edit access", async () => {
  const { web, headers, database, engine } = await setup();
  const current = await web.view(headers);
  const state = await web.state(current);
  const identity = {
    user: async () => ({
      id: "other",
      name: "Other editor",
      email: "other@example.com",
      emailVerified: true,
    }),
    handler: async () => new Response(),
  };
  const other = createWeb({
    ref: "main",
    database,
    engines: { "1": engine },
    version: "1",
    origin: "http://localhost:9999",
    identity,
    ownerEmail: "other@example.com",
  });
  const otherView = await other.view(headers);
  expect(otherView.mode).toBe("published");
  await expect(
    other.command(otherView, { type: "resume", id: state.drafts[0].id }),
  ).rejects.toThrow("Draft not available");
});

test("MCP writes use the delegated ref and revision checks, never a client-supplied destination", async () => {
  const { web, headers, engine } = await setup();
  const current = await web.view(headers);
  const grant = await web.command(current, {
    type: "agent",
    createDrafts: false,
    minutes: 15,
    write: true,
  });
  const call = (revision: number, key: string) =>
    web.handler(
      new Request("http://localhost:9999/cms/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${grant.token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "write_source",
            arguments: {
              path: "a.md",
              source: "---\ntitle: Agent edit\n---\nBody",
              revision,
              command: key,
            },
          },
        }),
      }),
    );
  const result = await (await call(0, "first")).json();
  expect(result.result.isError).not.toBe(true);
  expect((await engine.query("docs", { ref: current.ref!.name })).items[0].value.title).toBe(
    "Agent edit",
  );
  expect((await engine.query("docs", { ref: "main" })).items[0].value.title).toBe("Original");
  const stale = await (await call(0, "second")).json();
  expect(stale.result.isError).toBe(true);
});

test("discovery dispatch accepts the original URL preserved by a Next rewrite", async () => {
  const { web } = await setup();
  const response = await web.handler(
    new Request("http://localhost:9999/.well-known/oauth-protected-resource/cms/mcp"),
  );
  expect(response.status).toBe(200);
  expect((await response.json()).resource).toBe("http://localhost:9999/cms/mcp");
  expect(
    (await web.handler(new Request("http://localhost:9999/.well-known/oauth-protected-resource")))
      .status,
  ).toBe(404);
});

test("review files are scoped to a revision and reviewer previews stay identity-bound", async () => {
  const { web, headers } = await setup();
  const view = await web.view(headers);
  const r = await web.command(view, { type: "review" });
  const missing = await web.handler(
    new Request(
      `http://localhost:9999/cms/review/file?id=${r.id}&revision=${r.revision}&path=not-in-review`,
      { headers },
    ),
  );
  expect(missing.status).toBe(400);
  const preview = await web.handler(
    new Request(
      `http://localhost:9999/cms/review/preview?id=${r.id}&revision=${r.revision}&side=after`,
      { headers },
    ),
  );
  expect(preview.status).toBe(303);
  const exchange = await web.handler(
    new Request(new URL(preview.headers.get("location")!, "http://localhost:9999"), { headers }),
  );
  const shareCookie = exchange.headers.get("set-cookie")!.split(";")[0];
  expect((await web.view(new Headers({ cookie: shareCookie }))).mode).toBe("published");
  const ownerCookie = headers.get("cookie")!.split(";")[0];
  expect((await web.view(new Headers({ cookie: `${ownerCookie}; ${shareCookie}` }))).snapshot).toBe(
    view.snapshot,
  );
});
test("publication credentials expose only exact-review MCP tools and retry one operation", async () => {
  const { web, engine, headers } = await setup();
  const view = await web.view(headers);
  const r = await web.command(view, { type: "review" });
  await expect(
    web.command(view, { type: "review-handoff", id: r.id, revision: r.revision }),
  ).rejects.toThrow("approved");
  await web.command(view, {
    type: "review-decision",
    id: r.id,
    revision: r.revision,
    decision: "approve",
  });
  const g = await web.command(view, { type: "review-handoff", id: r.id, revision: r.revision });
  const call = async (method: string, params: unknown) =>
    web.handler(
      new Request("http://localhost:9999/cms/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${g.token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      }),
    );
  const listed = await (await call("tools/list", {})).json();
  expect(listed.result.tools.map((t: { name: string }) => t.name)).toEqual([
    "get_review",
    "publish_review",
  ]);
  const first = await (await call("tools/call", { name: "publish_review", arguments: {} })).json();
  expect(first.result.isError).not.toBe(true);
  const second = await (await call("tools/call", { name: "publish_review", arguments: {} })).json();
  expect(second.result).toEqual(first.result);
  expect((await engine.ref("main")).revision).toBe(2);
  await web.command(view, { type: "review-handoff-revoke", id: r.id, grant: g.grant });
  expect((await call("tools/list", {})).status).toBe(401);
});

test("external authority blocks local publication and publication grants", async () => {
  const { web, headers, engine } = await setup(true);
  const view = await web.view(headers);
  const r = await web.command(view, { type: "review" });
  await web.command(view, {
    type: "review-decision",
    id: r.id,
    revision: r.revision,
    decision: "approve",
  });
  await expect(
    web.command(view, { type: "publish", id: r.id, revision: r.revision }),
  ).rejects.toThrow("controlled externally");
  await expect(
    web.command(view, { type: "review-handoff", id: r.id, revision: r.revision }),
  ).rejects.toThrow();
  expect((await engine.ref("main")).revision).toBe(1);
});

test("edit page context is scoped to files and immutable review revisions, with pinned route previews", async () => {
  const { web, engine, headers } = await setup();
  async function save(title: string, pageUrl: string) {
    const view = await web.view(headers);
    const doc = (await engine.query("docs", { snapshot: view.snapshot })).items[0];
    return web.command(view, {
      type: "save",
      map: sourcemap(withSourcemap("web", doc), "title")["data-ww-contentmap"],
      source: `---\ntitle: ${title}\n---\nBody`,
      revision: view.ref!.revision,
      command: title,
      pageUrl,
    });
  }
  const original = (await web.view(headers)).snapshot;
  await expect(save("Rejected", "https://elsewhere.example/docs")).rejects.toThrow("this site");
  expect((await web.view(headers)).snapshot).toBe(original);
  await save("First", "http://localhost:9999/docs/a?locale=en&token=secret#section");
  const firstView = await web.view(headers);
  const first = await web.command(firstView, { type: "review" });
  async function data(revision: unknown) {
    return (
      await web.handler(
        new Request(`http://localhost:9999/cms/review/data?id=${first.id}&revision=${revision}`, {
          headers,
        }),
      )
    ).json();
  }
  const page = {
    url: "http://localhost:9999/docs/a?locale=en#section",
    version: "1",
    variant: { locale: "en" },
  };
  expect((await data(first.revision)).revision.changes[0].pages).toEqual([page]);
  await save("Second", "http://localhost:9999/home");
  await save("Third", "http://localhost:9999/home");
  const second = await web.command(await web.view(headers), { type: "review" });
  expect((await data(second.revision)).revision.changes[0].pages).toEqual([
    page,
    { ...page, url: "http://localhost:9999/home" },
  ]);
  expect((await data(first.revision)).revision.changes[0].pages).toEqual([page]);
  for (const side of ["before", "after"]) {
    const preview = await web.handler(
      new Request(
        `http://localhost:9999/cms/review/preview?id=${first.id}&revision=${first.revision}&path=a.md&page=0&side=${side}`,
        { headers },
      ),
    );
    expect(preview.status).toBe(303);
    const exchange = await web.handler(
      new Request(new URL(preview.headers.get("location")!, "http://localhost:9999"), { headers }),
    );
    expect(exchange.headers.get("location")).toBe(page.url);
    const ownerCookie = headers.get("cookie")!.split(";")[0];
    const previewView = await web.view(
      new Headers({
        cookie: `${ownerCookie}; ${exchange.headers.get("set-cookie")!.split(";")[0]}`,
      }),
    );
    expect(previewView.snapshot).toBe(
      side === "after" ? firstView.snapshot : (await engine.ref("main")).snapshot,
    );
    expect(previewView.variant).toEqual(page.variant);
  }
  const invalid = await web.handler(
    new Request(
      `http://localhost:9999/cms/review/preview?id=${first.id}&revision=${first.revision}&path=other.md&page=0`,
      { headers },
    ),
  );
  expect(invalid.status).toBe(400);
});

test("configured published ref is the source and destination of drafts", async () => {
  const { web, engine, headers } = await setup(false, "production");
  const view = await web.view(headers);
  expect(view.snapshot).toBe((await engine.ref("production")).snapshot);
  const review = await web.command(view, { type: "review" });
  await web.command(view, {
    type: "review-decision",
    id: review.id,
    revision: review.revision,
    decision: "approve",
  });
  await web.command(view, { type: "publish", id: review.id, revision: review.revision });
  expect((await web.view(headers)).ref!.name).toBe("production");
  expect((await engine.ref("production")).revision).toBe(2);
  await expect(engine.ref("main")).rejects.toThrow("Unknown ref");
});

test("drafts sort by last content edit, fall back to creation, and resuming does not bump activity", async () => {
  const { web, engine, headers, database } = await setup();
  const view = await web.view(headers);
  await database.execute("UPDATE ww2_snapshots SET created_at=?", ["2020-01-01T00:00:00.000Z"]);
  const initial = await web.state(view);
  expect(initial.drafts[0].updatedAt).toBe(initial.drafts[0].data.created);
  await web.command(view, { type: "draft" });
  await engine.apply({
    ref: view.ref!.name,
    expectedRevision: view.ref!.revision,
    changes: [{ path: "a.md", content: "---\ntitle: Edited\n---\nBody" }],
    idempotencyKey: "sort-edit",
  });
  const edited = await engine.ref(view.ref!.name);
  const editedAt = Date.now() + 1000;
  await database.execute("UPDATE ww2_snapshots SET created_at=? WHERE id=?", [
    new Date(editedAt).toISOString(),
    edited.snapshot,
  ]);
  const state = await web.state(await web.view(headers));
  expect(state.drafts).toHaveLength(2);
  expect(state.drafts[0].id).toBe(view.viewId);
  expect(state.drafts[0].updatedAt).toBe(editedAt);
  await web.command(view, { type: "resume", id: state.drafts[1].id });
  expect((await web.state(view)).drafts.map((d) => [d.id, d.updatedAt])).toEqual(
    state.drafts.map((d) => [d.id, d.updatedAt]),
  );
});

test("agent access defaults to writes, has no expiry, and ends when the draft is published", async () => {
  const { web, headers, database } = await setup();
  const view = await web.view(headers);
  const grant = await web.command(view, { type: "agent", createDrafts: false });
  const row = (
    await database.execute("SELECT expires,data FROM ww_web_records WHERE id=?", [String(grant.id)])
  ).rows[0];
  expect(row.expires).toBeNull();
  expect(JSON.parse(String(row.data)).write).toBe(true);
  const request = () =>
    new Request("http://localhost:9999/cms/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${grant.token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
  const tools = await (await web.handler(request())).json();
  expect(tools.result.tools.map((t: { name: string }) => t.name)).toContain("write_source");
  const review = await web.command(view, { type: "review" });
  await web.command(view, {
    type: "review-decision",
    id: review.id,
    revision: review.revision,
    decision: "approve",
  });
  await web.command(view, { type: "publish", id: review.id, revision: review.revision });
  expect((await web.handler(request())).status).toBe(401);
});

test("agent creation permission defaults on, retries safely, and grants access only to its own drafts", async () => {
  const { web, headers, engine } = await setup();
  const view = await web.view(headers);
  const grant = await web.command(view, { type: "agent" });
  async function call(name: string, args: Record<string, unknown> = {}, token = grant.token) {
    return (
      await web.handler(
        new Request("http://localhost:9999/cms/mcp", {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name, arguments: args },
          }),
        }),
      )
    ).json();
  }
  const first = await call("create_draft", { command: "new" });
  expect(first.result.isError).not.toBe(true);
  const draft = JSON.parse(first.result.content[0].text);
  expect(draft.snapshot).toBe((await engine.ref("main")).snapshot);
  expect(await call("create_draft", { command: "new" })).toEqual(first);
  const write = await call("write_source", {
    draft: draft.draft,
    path: "a.md",
    source: "---\ntitle: New draft\n---\nBody",
    revision: 0,
    command: "write",
  });
  expect(write.result.isError).not.toBe(true);
  expect((await engine.query("docs", { ref: draft.ref })).items[0].value.title).toBe("New draft");
  expect((await engine.query("docs", { ref: view.ref!.name })).items[0].value.title).toBe(
    "Original",
  );
  const another = await web.command(view, { type: "agent" });
  expect(
    (await call("read_source", { draft: draft.draft, path: "a.md" }, another.token)).result.isError,
  ).toBe(true);
  const restricted = await web.command(view, { type: "agent", createDrafts: false });
  expect(
    (await call("create_draft", { command: "blocked" }, restricted.token)).result.isError,
  ).toBe(true);
  const review = await web.command(view, { type: "review" });
  await web.command(view, {
    type: "review-decision",
    id: review.id,
    revision: review.revision,
    decision: "approve",
  });
  await web.command(view, { type: "publish", id: review.id, revision: review.revision });
  expect((await call("create_draft", { command: "after-completion" })).result.isError).not.toBe(
    true,
  );
  expect(
    (
      await call("write_source", {
        path: "a.md",
        source: "---\ntitle: Blocked\n---\nBody",
        revision: 0,
        command: "completed",
      })
    ).result.isError,
  ).toBe(true);
  await web.command(await web.view(headers), { type: "revoke", id: grant.id });
  expect((await call("list_drafts")).error).toBeDefined();
});

test("editor saves reconcile a lost response after the view advances, including variant overrides", async () => {
  const { web, engine, headers, database } = await setup();
  const view = await web.view(headers, { variant: { locale: "fr" } });
  const doc = (await engine.query("docs", { snapshot: view.snapshot, variant: view.variant }))
    .items[0];
  const map = sourcemap(withSourcemap("web", doc), "body")["data-ww-contentmap"]!;
  const input = {
    type: "save",
    map,
    source: "---\ntitle: Bonjour\n---\nTexte",
    revision: view.ref!.revision,
    command: "uncertain",
    override: true,
    pageUrl: "http://localhost:9999/docs/a?locale=fr",
  };
  const first = await web.command(view, input);
  const advanced = await web.view(headers, { variant: { locale: "fr" } });
  expect(await web.command(advanced, input)).toEqual(first);
  expect((await engine.ref(view.ref!.name)).revision).toBe(view.ref!.revision + 1);
  expect((await database.execute("SELECT * FROM ww_web_edit_context")).rows).toHaveLength(1);
  await expect(
    web.command(advanced, { ...input, source: input.source + " changed" }),
  ).rejects.toThrow("different content");
  await expect(web.command(advanced, { ...input, command: "new-key" })).rejects.toThrow("stale");
  const anotherView = await web.view(headers);
  await expect(web.command(anotherView, input)).rejects.toThrow("different content or view");
});

test("review feedback retries reconcile one event and reject changed payloads", async () => {
  const { web, headers } = await setup();
  const view = await web.view(headers);
  const review = await web.command(view, { type: "review" });
  const action = {
    type: "review-decision",
    id: review.id,
    revision: review.revision,
    decision: "comment",
    body: "A single comment",
    command: "feedback-once",
  };
  const first = await web.command(view, action);
  expect(await web.command(view, action)).toEqual(first);
  await expect(web.command(view, { ...action, body: "Changed" })).rejects.toThrow(
    "different feedback",
  );
  const data = await (
    await web.handler(
      new Request(`http://localhost:9999/cms/review/data?id=${review.id}`, { headers }),
    )
  ).json();
  expect(data.activity).toHaveLength(1);
});

test("all lazy browser chunks are served immutably without authentication", async () => {
  const { web } = await setup();
  const chunks = Object.values(assets).filter((a) => a.path.startsWith("js/"));
  expect(chunks.length).toBeGreaterThan(2);
  for (const chunk of chunks) {
    const response = await web.handler(
      new Request(`http://localhost:9999/cms/assets/${chunk.path}`),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("immutable");
    expect(await response.text()).toBe(chunk.body);
  }
});

test("editor ref, navigation context, and retry receipt roll back together", async () => {
  const { web, engine, headers, database } = await setup();
  const view = await web.view(headers);
  const doc = (await engine.query("docs", { snapshot: view.snapshot })).items[0];
  const input = {
    type: "save",
    map: sourcemap(withSourcemap("web", doc), "title")["data-ww-contentmap"],
    source: "---\ntitle: Transactional\n---\nBody",
    revision: view.ref!.revision,
    command: "atomic-context",
    pageUrl: "http://localhost:9999/docs/a",
  };
  // Initialize review metadata before injecting a failure in the content commit.
  await web.command(view, { type: "review" });
  const transaction = database.transaction.bind(database);
  database.transaction = (fn) =>
    transaction((tx) =>
      fn({
        execute: (sql, params) => {
          if (sql.startsWith("INSERT OR IGNORE INTO ww_web_edit_context"))
            throw new Error("Injected metadata failure");
          return tx.execute(sql, params);
        },
      }),
    );
  await expect(web.command(view, input)).rejects.toThrow("Injected metadata failure");
  database.transaction = transaction;
  expect(await engine.ref(view.ref!.name)).toEqual(view.ref);
  expect(
    (await database.execute("SELECT id FROM ww_web_records WHERE kind='editor-save'")).rows,
  ).toHaveLength(0);
  await web.command(view, input);
  expect((await engine.ref(view.ref!.name)).revision).toBe(view.ref!.revision + 1);
});

test("toolbar state batches draft metadata without changing ownership boundaries", async () => {
  const { web, headers, database } = await setup();
  const current = await web.view(headers);
  await web.state(current); // Initialize review storage before counting steady-state work.
  for (let i = 0; i < 12; i++) await web.command(current, { type: "draft" });
  const execute = vi.spyOn(database, "execute");
  const state = await web.state(current);
  expect(state.drafts).toHaveLength(13);
  expect(execute.mock.calls).toHaveLength(3);
  expect(state.drafts.every((draft) => draft.status === "open")).toBe(true);
  const anonymous = await web.view(new Headers());
  expect((await web.state(anonymous)).drafts).toHaveLength(0);
});

test("draft view resolves in bounded reads and revoked drafts fall back to published", async () => {
  const { web, headers, database } = await setup();
  const before = await web.view(headers);
  const execute = vi.spyOn(database, "execute");
  expect(await web.view(headers)).toEqual(before);
  expect(execute.mock.calls).toHaveLength(3);
  await database.execute("UPDATE ww_web_records SET revoked=1 WHERE repository=? AND id=?", [
    "web",
    before.viewId!,
  ]);
  expect((await web.view(headers)).mode).toBe("published");
});
