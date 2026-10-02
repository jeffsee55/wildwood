import { createClient } from "@libsql/client";
import { afterEach, expect, test, vi } from "vitest";
import { z } from "zod";
import {
  collection,
  ConflictError,
  createContent,
  json,
  libsql,
  markdown,
  ValidationError,
} from "../src";

const clients: ReturnType<typeof createClient>[] = [];
test("body-only Markdown edits preserve frontmatter bytes for Git merging", () => {
  const codec = markdown(z.object({ title: z.string().optional(), body: z.string() }));
  const prefix = '\uFEFF---\r\n# Keep formatting\r\ntitle: "Quoted title"\r\n---\r\n';
  expect(codec.patch!(prefix + "Original body", { body: "New body" })).toBe(prefix + "New body");
  expect(codec.patch!(prefix, { body: "New body" })).toBe(prefix + "New body");
  expect(codec.patch!("Plain Markdown", { body: "New body" })).toBe("New body");
  expect(codec.patch!(prefix + "Original body", {})).toBe(prefix + "Original body");
});
afterEach(() => {
  for (const c of clients.splice(0)) c.close();
});
function setup(version = "1", database?: ReturnType<typeof libsql>) {
  if (!database) {
    const client = createClient({ url: ":memory:" });
    clients.push(client);
    database = libsql(client);
  }
  const engine = createContent({
    repository: "test",
    version,
    database,
    variants: { locale: { options: ["en", "fr"], default: "en", path: "suffix" } },
    collections: {
      authors: collection({
        match: "authors/*.json",
        parse: json(z.object({ name: z.string(), country: z.string() })),
        filters: ["name", "country"],
      }),
      docs: collection({
        match: "docs/*.md",
        parse: markdown(
          z.object({
            title: z.string(),
            category: z.string().optional(),
            score: z.number().optional(),
            author: z.string().optional(),
            body: z.string(),
          }),
        ),
        filters: ["title", "category", "score"],
        references: { author: "authors" },
      }),
    },
  });
  return engine;
}
const doc = (title: string, category = "news", author = "alice") =>
  `---\ntitle: ${title}\ncategory: ${category}\nauthor: ../authors/${author}.json\n---\nBody`;
async function seed(engine = setup()) {
  await engine.branch("main");
  const head = await engine.apply({
    ref: "main",
    expectedRevision: 0,
    idempotencyKey: "seed",
    changes: [
      { path: "docs/a.md", content: doc("A") },
      { path: "docs/b.md", content: doc("B", "guides", "bob") },
      {
        path: "authors/alice.json",
        content: JSON.stringify({ name: "Alice", country: "England" }),
      },
      { path: "authors/bob.json", content: JSON.stringify({ name: "Bob", country: "France" }) },
    ],
  });
  return { engine, head };
}
async function count(engine: ReturnType<typeof setup>, table: string) {
  return Number((await engine.database.execute(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);
}

test("branch is a pointer; edits append only changed memberships and projections", async () => {
  const { engine, head } = await seed();
  const before = await count(engine, "ww2_changes"),
    projections = await count(engine, "ww2_projections");
  const branch = await engine.branch("feature", { ref: "main" });
  expect(branch.snapshot).toBe(head.snapshot);
  expect(await count(engine, "ww2_changes")).toBe(before);
  await engine.apply({
    ref: "feature",
    expectedRevision: 0,
    idempotencyKey: "edit",
    changes: [{ path: "docs/a.md", content: doc("New") }],
  });
  expect(await count(engine, "ww2_changes")).toBe(before + 1);
  expect(await count(engine, "ww2_projections")).toBe(projections + 1);
  expect((await engine.query("docs", { ref: "main" })).items[0].value.title).toBe("A");
  expect((await engine.query("docs", { ref: "feature" })).items[0].value.title).toBe("New");
});

test("old snapshots stay stable; deleted and overridden facts do not reappear", async () => {
  const { engine, head } = await seed();
  await engine.apply({
    ref: "main",
    expectedRevision: 1,
    idempotencyKey: "edit",
    changes: [
      { path: "docs/a.md", content: "---\ntitle: New\n---\nBody" },
      { path: "docs/b.md", delete: true },
    ],
  });
  expect(
    (await engine.query("docs", { where: { field: "category", eq: "news" } })).items,
  ).toHaveLength(0);
  expect((await engine.query("docs")).items).toHaveLength(1);
  expect((await engine.query("docs", { snapshot: head.snapshot })).items).toHaveLength(2);
});

test("unchanged source follows changed target for filtering, sorting, and hydration", async () => {
  const { engine } = await seed();
  await engine.branch("feature", { ref: "main" });
  await engine.apply({
    ref: "feature",
    expectedRevision: 0,
    idempotencyKey: "author",
    changes: [
      { path: "authors/alice.json", content: JSON.stringify({ name: "Zoe", country: "France" }) },
    ],
  });
  const options = {
    where: { reference: "author", where: { field: "country", eq: "France" } },
    orderBy: { reference: "author", field: "name" },
  } as const;
  const main = await engine.query("docs", options),
    feature = await engine.query("docs", { ...options, ref: "feature" });
  expect(main.items.map((d) => d.value.title)).toEqual(["B"]);
  expect(feature.items.map((d) => d.value.title)).toEqual(["B", "A"]);
  expect((await engine.resolveReference(feature.items[1], "author"))?.value).toEqual({
    name: "Zoe",
    country: "France",
  });
});

test("retargeting references replaces their meaning", async () => {
  const { engine } = await seed();
  await engine.apply({
    ref: "main",
    expectedRevision: 1,
    idempotencyKey: "target",
    changes: [{ path: "docs/a.md", content: doc("A", "news", "bob") }],
  });
  const a = (await engine.query("docs")).items[0];
  expect((await engine.resolveReference(a, "author"))?.value).toMatchObject({ name: "Bob" });
});

test("variants resolve before predicates, including reference targets", async () => {
  const { engine } = await seed();
  await engine.apply({
    ref: "main",
    expectedRevision: 1,
    idempotencyKey: "french",
    changes: [
      { path: "docs/a.fr.md", content: doc("French", "guides") },
      { path: "authors/alice.fr.json", content: '{"name":"Alicia","country":"France"}' },
    ],
  });
  expect(
    (
      await engine.query("docs", {
        variant: { locale: "fr" },
        where: { field: "category", eq: "news" },
      })
    ).items,
  ).toHaveLength(0);
  expect(
    (
      await engine.query("docs", {
        variant: { locale: "en" },
        where: { field: "category", eq: "news" },
      })
    ).items,
  ).toHaveLength(1);
  const french = await engine.query("docs", {
    variant: { locale: "fr" },
    where: { reference: "author", where: { field: "country", eq: "France" } },
  });
  expect(french.items).toHaveLength(2);
});

test("invalid content never advances a ref and exposes diagnostics", async () => {
  const { engine, head } = await seed();
  await expect(
    engine.apply({
      ref: "main",
      expectedRevision: 1,
      idempotencyKey: "bad",
      changes: [{ path: "docs/a.md", content: "---\ntitle: 42\n---\nBody" }],
    }),
  ).rejects.toBeInstanceOf(ValidationError);
  expect(await engine.ref("main")).toEqual(head);
  expect((await engine.query("docs")).items[0].value.title).toBe("A");
});

test("idempotency replays and stale writes conflict", async () => {
  const { engine } = await seed();
  const command = {
    ref: "main",
    expectedRevision: 1,
    idempotencyKey: "same",
    changes: [{ path: "docs/a.md", content: doc("Updated") }],
  };
  const result = await engine.apply(command);
  expect(await engine.apply(command)).toEqual(result);
  await expect(engine.apply({ ...command, idempotencyKey: "stale" })).rejects.toBeInstanceOf(
    ConflictError,
  );
  await expect(engine.apply({ ...command, changes: [] })).rejects.toBeInstanceOf(ConflictError);
});

test("schema generations prepare without duplicating snapshots or membership", async () => {
  const { engine, head } = await seed();
  const before = await count(engine, "ww2_changes");
  const v2 = setup("2", engine.database);
  expect((await v2.query("docs")).version).toBe("2");
  expect(await count(engine, "ww2_changes")).toBe(before);
  expect((await engine.query("docs", { snapshot: head.snapshot })).version).toBe("1");
  expect(await count(engine, "ww2_projections")).toBe(8);
});

test("empty queries do not rebuild; checkpoints preserve results and descendant deletion", async () => {
  const { engine, head } = await seed();
  const before = await count(engine, "ww2_projections");
  expect(
    (await engine.query("docs", { where: { field: "title", eq: "missing" } })).items,
  ).toHaveLength(0);
  expect(await count(engine, "ww2_projections")).toBe(before);
  const old = await engine.query("docs");
  await engine.checkpoint(head.snapshot);
  expect(await engine.query("docs")).toEqual(old);
  await engine.apply({
    ref: "main",
    expectedRevision: 1,
    idempotencyKey: "delete",
    changes: [{ path: "docs/a.md", delete: true }],
  });
  expect((await engine.query("docs")).items.map((d) => d.value.title)).toEqual(["B"]);
});

test("numeric sort and filtering use numbers, not text order", async () => {
  const { engine } = await seed();
  await engine.apply({
    ref: "main",
    expectedRevision: 1,
    idempotencyKey: "scores",
    changes: [
      { path: "docs/a.md", content: "---\ntitle: A\nscore: 10\n---\n" },
      { path: "docs/b.md", content: "---\ntitle: B\nscore: 2\n---\n" },
    ],
  });
  expect(
    (await engine.query("docs", { orderBy: { field: "score" } })).items.map((d) => d.value.score),
  ).toEqual([2, 10]);
  expect(
    (await engine.query("docs", { where: { field: "score", gt: 3 } })).items.map(
      (d) => d.value.score,
    ),
  ).toEqual([10]);
});

test("failed blob writes and unsafe paths never advance the ref", async () => {
  const { engine, head } = await seed();
  await expect(
    engine.apply({
      ref: "main",
      expectedRevision: 1,
      idempotencyKey: "path",
      changes: [{ path: "../bad", content: "bad" }],
    }),
  ).rejects.toThrow("Invalid repository path");
  const put = vi.spyOn(engine.blobs, "put").mockRejectedValueOnce(new Error("offline"));
  await expect(
    engine.apply({
      ref: "main",
      expectedRevision: 1,
      idempotencyKey: "offline",
      changes: [{ path: "docs/a.md", content: doc("New") }],
    }),
  ).rejects.toThrow("offline");
  put.mockRestore();
  expect(await engine.ref("main")).toEqual(head);
});

test("concurrent commands cannot lose an update", async () => {
  const { engine } = await seed();
  const results = await Promise.allSettled([
    engine.apply({
      ref: "main",
      expectedRevision: 1,
      idempotencyKey: "race-a",
      changes: [{ path: "docs/a.md", content: doc("First") }],
    }),
    engine.apply({
      ref: "main",
      expectedRevision: 1,
      idempotencyKey: "race-b",
      changes: [{ path: "docs/b.md", content: doc("Second") }],
    }),
  ]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(
    results.filter((result) => result.status === "rejected").map((result) => result.reason),
  ).toEqual([expect.any(ConflictError)]);
  expect((await engine.ref("main")).revision).toBe(2);
});

test("reference hydration preserves the source variant and schema", async () => {
  const { engine } = await seed();
  await engine.apply({
    ref: "main",
    expectedRevision: 1,
    idempotencyKey: "fr-author",
    changes: [{ path: "authors/alice.fr.json", content: '{"name":"Alicia","country":"France"}' }],
  });
  const item = (await engine.query("docs", { variant: { locale: "fr" } })).items[0];
  expect((await engine.resolveReference(item, "author"))?.value).toMatchObject({ name: "Alicia" });
  await expect(setup("2", engine.database).resolveReference(item, "author")).rejects.toThrow(
    "original schema generation",
  );
});

test("branching from an edited branch pins ancestry across later changes and checkpoints", async () => {
  const { engine } = await seed();
  const first = await engine.apply({
    ref: "main",
    expectedRevision: 1,
    idempotencyKey: "one",
    changes: [{ path: "docs/a.md", content: doc("One") }],
  });
  await engine.branch("child", { ref: "main" });
  await engine.apply({
    ref: "main",
    expectedRevision: 2,
    idempotencyKey: "two",
    changes: [{ path: "docs/a.md", content: doc("Two") }],
  });
  await engine.checkpoint(first.snapshot);
  expect((await engine.query("docs", { ref: "child" })).items[0].value.title).toBe("One");
  expect((await engine.query("docs", { ref: "main" })).items[0].value.title).toBe("Two");
});

test("failed schema generations do not affect an older ready generation", async () => {
  const { engine } = await seed();
  const newer = createContent({
    repository: "test",
    version: "broken",
    database: engine.database,
    collections: {
      docs: collection({
        match: "docs/*.md",
        parse: markdown(z.object({ requiredNewField: z.string() })),
      }),
    },
  });
  await expect(newer.query("docs")).rejects.toBeInstanceOf(ValidationError);
  expect((await engine.query("docs")).items).toHaveLength(2);
});

test("file modes cannot bypass validation and path conflicts cannot create invalid Git trees", async () => {
  const { engine, head } = await seed();
  await expect(
    engine.apply({
      ref: "main",
      expectedRevision: 1,
      idempotencyKey: "symlink",
      changes: [{ path: "docs/a.md", content: doc("A"), mode: "120000" }],
    }),
  ).rejects.toBeInstanceOf(ValidationError);
  await expect(
    engine.apply({
      ref: "main",
      expectedRevision: 1,
      idempotencyKey: "collision",
      changes: [{ path: "docs", content: "file" }],
    }),
  ).rejects.toBeInstanceOf(ValidationError);
  expect(await engine.ref("main")).toEqual(head);
});

test("multi-axis fallback matches defaults before explicit specificity without materializing combinations", async () => {
  const client = createClient({ url: ":memory:" });
  clients.push(client);
  const engine = createContent({
    repository: "variants",
    version: "1",
    database: libsql(client),
    variants: {
      locale: { options: ["en", "fr"], default: "en", path: "suffix" },
      edition: { options: ["v1", "v2"], default: "v1", path: "suffix" },
    },
    collections: {
      docs: collection({
        match: "docs/*.md",
        parse: markdown(z.object({ title: z.string(), body: z.string() })),
        filters: ["title"],
      }),
    },
  });
  await engine.branch("main");
  await engine.apply({
    ref: "main",
    expectedRevision: 0,
    idempotencyKey: "variants",
    changes: [
      { path: "docs/a.md", content: "---\ntitle: Default\n---\n" },
      { path: "docs/a.en.md", content: "---\ntitle: Explicit English\n---\n" },
      { path: "docs/a.v2.md", content: "---\ntitle: Edition two\n---\n" },
    ],
  });
  const countBefore = await count(engine as unknown as ReturnType<typeof setup>, "ww2_projections");
  expect(
    (await engine.query("docs", { variant: { locale: "en", edition: "v2" } })).items[0].value.title,
  ).toBe("Edition two");
  expect(
    (await engine.query("docs", { variant: { locale: "en", edition: "v1" } })).items[0].value.title,
  ).toBe("Explicit English");
  expect(
    (await engine.query("docs", { variant: { locale: "fr", edition: "v1" } })).items[0].value.title,
  ).toBe("Default");
  expect(await count(engine as unknown as ReturnType<typeof setup>, "ww2_projections")).toBe(
    countBefore,
  );
});

test("generation identity survives equivalent parsers compiled with different function text", async () => {
  const client = createClient({ url: ":memory:" });
  clients.push(client);
  const database = libsql(client);
  const first = createContent({
    repository: "bundled",
    version: "1",
    database,
    collections: {
      docs: collection({
        match: "*.json",
        parse: (source: string) => JSON.parse(source),
        filters: ["title"],
      }),
    },
  });
  await first.branch("main");
  await first.apply({
    ref: "main",
    expectedRevision: 0,
    idempotencyKey: "seed",
    changes: [{ path: "a.json", content: '{"title":"Stable"}' }],
  });
  const bundled = createContent({
    repository: "bundled",
    version: "1",
    database,
    collections: {
      docs: collection({
        match: "*.json",
        parse: function minified(s: string) {
          return JSON.parse(s);
        },
        filters: ["title"],
      }),
    },
  });
  expect((await bundled.query("docs")).items[0].value.title).toBe("Stable");
  const changed = createContent({
    repository: "bundled",
    version: "1",
    database,
    collections: {
      docs: collection({ match: "*.json", parse: JSON.parse, filters: ["different"] }),
    },
  });
  await expect(changed.ready()).rejects.toThrow("Schema changed without a version bump");
});

test("unmodeled bytes use the optional asset store while tree metadata and documents remain in SQL", async () => {
  const base = setup();
  const stored = new Map<string, Uint8Array>();
  const assetBlobs = {
    put: async (id: string, bytes: Uint8Array) => {
      stored.set(id, bytes);
    },
    get: async (id: string) => stored.get(id) ?? null,
  };
  const engine = createContent({ ...base.config, database: base.database, assetBlobs });
  await engine.branch("main");
  const bytes = Buffer.from([0, 255, 1, 128]);
  const first = await engine.apply({
    ref: "main",
    expectedRevision: 0,
    idempotencyKey: "assets",
    changes: [
      { path: "media/photo.bin", content: bytes },
      { path: "docs/a.md", content: "---\ntitle: Article\n---\nBody" },
    ],
  });
  const files = await engine.files(first.snapshot),
    asset = files.find((f) => f.path === "media/photo.bin")!;
  expect(asset).toMatchObject({ size: 4, storage: "assets" });
  expect(stored.size).toBe(1);
  expect(
    (await engine.database.execute("SELECT id FROM ww2_blobs WHERE id=?", [asset.blob])).rows,
  ).toHaveLength(0);
  expect(Buffer.from(await engine.bytes(asset.blob))).toEqual(bytes);
  const restarted = createContent({ ...base.config, database: base.database, assetBlobs });
  expect((await restarted.query("docs", { ref: "main" })).items[0].value.title).toBe("Article");
  expect(
    (
      await restarted.validateChanges({
        ref: "main",
        expectedRevision: 1,
        changes: [{ path: "media/other.bin", content: bytes }],
      })
    ).valid,
  ).toBe(true);
  await restarted.apply({
    ref: "main",
    expectedRevision: 1,
    idempotencyKey: "remove",
    changes: [{ path: "media/photo.bin", delete: true }],
  });
  expect(
    (await restarted.files((await restarted.ref("main")).snapshot)).map((f) => f.path),
  ).not.toContain(asset.path);
  expect(Buffer.from(await restarted.bytes(asset.blob))).toEqual(bytes);
  expect(await restarted.files(first.snapshot)).toContainEqual(asset);
  await expect(base.bytes(asset.blob)).rejects.toThrow("assetBlobs");
});
