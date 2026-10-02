/** Opt-in build-time verification in an isolated repository namespace. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "@libsql/client";
import { collection, createContent, libsql, markdown } from "wildwood-core";
import { z } from "zod";

if (process.env.WILDWOOD_VERIFY_REMOTE === "1") {
  const url = process.env.WILDWOOD_DOCS_DATABASE_URL || process.env.TURSO_DATABASE_URL;
  assert.ok(url && !url.startsWith("file:"), "Remote verification requires the hosted database");
  const repository = `verification-${randomUUID()}`;
  const clients = [0, 1].map(() =>
    createClient({
      url,
      authToken: process.env.WILDWOOD_DOCS_DATABASE_TOKEN || process.env.TURSO_AUTH_TOKEN,
    }),
  );
  const engines = clients.map((client) =>
    createContent({
      repository,
      version: "1",
      database: libsql(client),
      collections: {
        docs: collection({
          match: "*.md",
          parse: markdown(z.object({ title: z.string(), body: z.string() })),
          filters: ["title"],
        }),
      },
    }),
  );
  const [engine, other] = engines;
  try {
    await Promise.all(engines.map((e) => e.ready()));
    await engine.branch("main");
    const seed = await engine.apply({
      ref: "main",
      expectedRevision: 0,
      idempotencyKey: "seed",
      changes: [{ path: "test.md", content: `---\ntitle: ${repository}\n---\nInitial content` }],
    });
    const attempts = [0, 1].map((index) => ({
      ref: "main",
      expectedRevision: seed.revision,
      idempotencyKey: `concurrent-${index}`,
      changes: [
        { path: "test.md", content: `---\ntitle: ${repository}-${index}\n---\nConcurrent content` },
      ],
    }));
    const outcomes = await Promise.allSettled(engines.map((e, i) => e.apply(attempts[i])));
    assert.equal(
      outcomes.filter((r) => r.status === "fulfilled").length,
      1,
      "Exactly one concurrent edit must win",
    );
    const winner = outcomes.findIndex((r) => r.status === "fulfilled");
    const head = await other.ref("main");
    assert.equal(head.revision, 2);
    assert.deepEqual(
      await other.apply(attempts[winner]),
      head,
      "A different server must reconcile the identical retry",
    );
    const beforeInvalid = head.snapshot;
    await assert.rejects(
      engine.apply({
        ref: "main",
        expectedRevision: 2,
        idempotencyKey: "invalid",
        changes: [{ path: "test.md", content: "Missing required title" }],
      }),
    );
    assert.equal((await other.ref("main")).snapshot, beforeInvalid);
    await engine.checkpoint(head.snapshot);
    await other.validateReferences(head.snapshot);
    const documents = (await other.query("docs", { snapshot: head.snapshot })).items;
    assert.deepEqual(await other.resolveReferences(documents, "missing"), [null]);
    const generation = createContent({ ...engine.config, version: "2", database: engine.database });
    await generation.prepare(head.snapshot);
    assert.equal((await generation.query("docs", { snapshot: head.snapshot })).items.length, 1);
    assert.equal(
      (await other.query("docs", { ref: "main", search: "Concurrent content" })).items.length,
      1,
    );
    console.log(
      "REMOTE_DATABASE_VERIFIED: isolated writes, concurrent conflict, cross-worker idempotency, validation rollback, checkpoint and search passed.",
    );
  } finally {
    const db = engine.database;
    await db.transaction(async (tx) => {
      for (const table of ["ww2_fields", "ww2_connections"])
        await tx.execute(
          `DELETE FROM ${table} WHERE projection IN (SELECT id FROM ww2_projections WHERE repository=?)`,
          [repository],
        );
      await tx.execute("DELETE FROM ww2_projections WHERE repository=?", [repository]);
      for (const table of [
        "ww2_reference_builds",
        "ww2_builds",
        "ww2_changes",
        "ww2_checkpoint_files",
        "ww2_checkpoints",
      ])
        await tx.execute(
          `DELETE FROM ${table} WHERE snapshot IN (SELECT id FROM ww2_snapshots WHERE repository=?)`,
          [repository],
        );
      for (const table of [
        "ww2_ref_locks",
        "ww2_refs",
        "ww2_events",
        "ww2_commands",
        "ww2_generations",
      ])
        await tx.execute(`DELETE FROM ${table} WHERE repository=?`, [repository]);
      await tx.execute("DELETE FROM ww2_snapshots WHERE repository=?", [repository]);
    });
    clients.forEach((c) => c.close());
  }
}
