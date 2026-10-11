/**
 * Local, disposable architecture probe. Run after building wildwood-core.
 * Counts adapter execute calls; excludes transaction control and initial DDL.
 * Timings use in-memory LibSQL, not production network latency. Long-history
 * fixtures reuse validated blobs to isolate ancestry traversal from parsing.
 */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { createClient } from "@libsql/client";
import { createContent, libsql, collection } from "../dist/index.mjs";

async function fixture(count) {
  const client = createClient({ url: ":memory:" });
  const raw = libsql(client);
  let calls = [],
    parsed = 0;
  const instrument = (executor) => ({
    async execute(sql, args) {
      const result = await executor.execute(sql, args);
      calls.push({ sql });
      return result;
    },
  });
  const database = {
    ...instrument(raw),
    batch: (sql) => raw.batch(sql),
    transaction: (fn) => raw.transaction((tx) => fn(instrument(tx))),
  };
  const codec = (source) => {
    parsed++;
    return JSON.parse(source);
  };
  function engine(
    version = "1",
    variants = { locale: { options: ["en", "fr"], default: "en", path: "suffix" } },
  ) {
    return createContent({
      repository: "architecture-benchmark",
      version,
      database,
      variants,
      collections: {
        docs: collection({
          match: "docs/*.json",
          parse: codec,
          filters: ["order"],
          references: { author: "authors" },
        }),
        authors: collection({ match: "authors/*.json", parse: codec }),
      },
    });
  }
  const cms = engine();
  await cms.branch("main");
  const source = (i, edit = 0) =>
    JSON.stringify({
      title: `Page ${i}`,
      order: i,
      author: "/authors/team.json",
      body: `Edit ${edit}`,
    });
  let head = await cms.apply({
    ref: "main",
    expectedRevision: 0,
    idempotencyKey: "seed",
    changes: [
      ...Array.from({ length: count }, (_, i) => ({ path: `docs/${i}.json`, content: source(i) })),
      { path: "docs/0.fr.json", content: source(0) },
      { path: "authors/team.json", content: '{"name":"Team"}' },
      { path: "authors/team.fr.json", content: '{"name":"Équipe"}' },
    ],
  });
  await cms.checkpoint(head.snapshot);
  async function measure(label, fn) {
    calls = [];
    parsed = 0;
    const start = performance.now();
    const value = await fn();
    const row = {
      docs: count,
      label,
      ms: +(performance.now() - start).toFixed(2),
      statements: calls.length,
      projectionProbes: calls.filter((c) => c.sql.startsWith("SELECT id FROM ww2_projections"))
        .length,
      membershipQueries: calls.filter((c) => c.sql.startsWith("WITH RECURSIVE lineage")).length,
      parsed,
    };
    console.log(JSON.stringify(row));
    return value;
  }
  return {
    client,
    raw,
    cms,
    engine,
    source,
    measure,
    get head() {
      return head;
    },
    set head(value) {
      head = value;
    },
  };
}
for (const count of [10, 100, 1000]) {
  const f = await fixture(count);
  try {
    f.head = await f.measure("one-file edit", () =>
      f.cms.apply({
        ref: "main",
        expectedRevision: f.head.revision,
        idempotencyKey: "one-edit",
        changes: [{ path: "docs/1.json", content: f.source(1, 1) }],
      }),
    );
    const items = await f.measure(
      "French query, prepared snapshot",
      async () =>
        (
          await f.cms.query("docs", {
            snapshot: f.head.snapshot,
            variant: { locale: "fr" },
            limit: 100,
            orderBy: { field: "order" },
          })
        ).items,
    );
    const resolved = await f.measure(`resolve ${items.length} author references`, () =>
      Promise.all(items.map((doc) => f.cms.resolveReference(doc, "author"))),
    );
    const batched = await f.measure("batch resolveReferences", () =>
      f.cms.resolveReferences(items, "author"),
    );
    assert.deepEqual(batched, resolved);
    const authors = await f.measure("bulk-load authors once, same snapshot and locale", () =>
      f.cms.query("authors", { snapshot: f.head.snapshot, variant: { locale: "fr" }, limit: 100 }),
    );
    assert.equal(authors.items.length, 1);
    assert.equal(authors.items[0].value.name, "Équipe");
    assert.ok(resolved.every((author) => author?.projection === authors.items[0].projection));
    assert.equal(items.length, Math.min(count, 100));
    const generation = f.engine("2");
    await generation.ready();
    await f.measure("new schema generation", () => generation.prepare(f.head.snapshot));
    await f.measure("branch creation", () => f.cms.branch("agent", { snapshot: f.head.snapshot }));
    if (count === 10) {
      for (const axes of [1, 4, 8]) {
        const variants = { locale: { options: ["en", "fr"], default: "en", path: "suffix" } };
        for (let i = 1; i < axes; i++)
          variants[`axis${i}`] = { options: [`a${i}`, `b${i}`], default: `a${i}`, path: "suffix" };
        const matrix = f.engine(`matrix-${axes}`, variants);
        await matrix.prepare(f.head.snapshot);
        await f.measure(`validate references in ${2 ** axes} variant combinations`, () =>
          matrix.validateReferences(f.head.snapshot),
        );
      }
    }
    if (count === 1000) {
      const checkpoint = f.head.snapshot;
      // Seed a valid long immutable delta chain directly to isolate read cost.
      // Each revision flips one path between two existing validated blobs.
      const versions = (
        await f.raw.execute("SELECT blob FROM ww2_changes WHERE path='docs/1.json' ORDER BY rowid")
      ).rows.map((r) => String(r.blob));
      let parent = checkpoint;
      await f.raw.transaction(async (tx) => {
        for (let i = 0; i < 1000; i++) {
          const id = `benchmark-history-${i}`;
          await tx.execute("INSERT INTO ww2_snapshots VALUES (?,?,?,?)", [
            id,
            "architecture-benchmark",
            parent,
            new Date().toISOString(),
          ]);
          await tx.execute("INSERT INTO ww2_changes VALUES (?,?,?,?)", [
            id,
            "docs/1.json",
            versions[i % versions.length],
            "100644",
          ]);
          await tx.execute("INSERT INTO ww2_builds VALUES (?,?,'ready',NULL)", [id, "1"]);
          parent = id;
        }
      });
      let beforeCheckpoint;
      for (const depth of [1, 100, 1000]) {
        const snapshot = `benchmark-history-${depth - 1}`;
        beforeCheckpoint = await f.measure(`French query, ${depth} extra deltas`, () =>
          f.cms.query("docs", {
            snapshot,
            variant: { locale: "fr" },
            limit: 100,
            orderBy: { field: "order" },
          }),
        );
      }
      await f.measure("checkpoint 1000-delta snapshot", () => f.cms.checkpoint(parent));
      const afterCheckpoint = await f.measure("French query after checkpoint", () =>
        f.cms.query("docs", {
          snapshot: parent,
          variant: { locale: "fr" },
          limit: 100,
          orderBy: { field: "order" },
        }),
      );
      assert.deepEqual(afterCheckpoint, beforeCheckpoint);
    }
  } finally {
    f.client.close();
  }
}
