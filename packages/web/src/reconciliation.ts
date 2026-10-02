import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ConflictError,
  type Collections,
  type ContentEngine,
  type Ref,
  type SqlExecutor,
} from "wildwood-core";
import { planGitMerge, readGitConflict, resolveGitMerge } from "wildwood-core/git";
import type { Actor } from "./server";
export const resolutionsSchema = z
  .array(
    z.union([
      z.object({ path: z.string().min(1).max(1024), side: z.enum(["ours", "theirs"]) }),
      z.object({ path: z.string().min(1).max(1024), source: z.string().max(128 * 1024) }),
      z.object({ path: z.string().min(1).max(1024), delete: z.literal(true) }),
    ]),
  )
  .max(200);
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
type Anchors = {
  draft: string;
  head: Ref;
  target: Ref;
  base: string;
  baseRevision: number;
  git: string;
};
export function createReconciliation<C extends Collections>(
  engine: ContentEngine<C>,
  publishedRef: string,
  ready: () => Promise<void>,
) {
  const db = engine.database,
    repository = engine.config.repository;
  async function record<T>(id: string, kind: string, tx: SqlExecutor = db) {
    const row = (
      await tx.execute(
        "SELECT actor,data FROM ww_web_records WHERE repository=? AND id=? AND kind=? AND revoked=0",
        [repository, id, kind],
      )
    ).rows[0];
    if (!row) throw new Error("Draft or merge plan unavailable");
    return { actor: String(row.actor), data: JSON.parse(String(row.data)) as T };
  }
  async function draft(actor: Actor, id: string) {
    await ready();
    const r = await record<{ ref: string; base: string; baseRevision: number }>(id, "draft");
    if (actor.role === "reader" || r.actor !== actor.id)
      throw new Error("Draft outside authorized scope");
    return r;
  }
  async function context(actor: Actor, id: string) {
    const r = await record<Anchors>(id, "merge-plan");
    await draft(actor, r.data.draft);
    return r.data;
  }
  async function plan(actor: Actor, id: string) {
    const d = await draft(actor, id),
      head = await engine.ref(d.data.ref),
      target = await engine.ref(publishedRef);
    if (
      (
        await db.execute("SELECT name FROM ww2_ref_locks WHERE repository=? AND name=?", [
          repository,
          head.name,
        ])
      ).rows.length
    )
      throw new Error("Published or publishing drafts are read-only");
    if (d.data.base === target.snapshot && d.data.baseRevision === target.revision)
      return { upToDate: true, draft: id, head, target };
    const git = await planGitMerge(engine, {
      base: d.data.base,
      ours: head.snapshot,
      theirs: target.snapshot,
    });
    const anchors: Anchors = {
      draft: id,
      head,
      target,
      base: d.data.base,
      baseRevision: d.data.baseRevision,
      git: git.id,
    };
    const plan = "merge:" + hash([repository, engine.config.version, anchors]);
    await db.execute(
      "INSERT INTO ww_web_records(repository,id,kind,actor,data) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING",
      [repository, plan, "merge-plan", actor.id, JSON.stringify(anchors)],
    );
    return {
      plan,
      upToDate: false,
      draft: id,
      head,
      target,
      clean: git.clean,
      conflicts: [...new Set(git.stages.map((s) => s.path))].sort(),
      messages: git.messages,
      commits: { ours: git.oursCommit, theirs: git.theirsCommit },
      next: git.clean
        ? "Apply this plan, then submit a fresh review."
        : "Read the conflicted files, resolve each path, and confirm the Git conflict messages before applying.",
    };
  }
  async function file(actor: Actor, id: string, path: string) {
    const c = await context(actor, id);
    return readGitConflict(engine, c.git, path);
  }
  async function apply(
    actor: Actor,
    input: {
      plan: string;
      command: string;
      resolutions: z.infer<typeof resolutionsSchema>;
      confirmConflicts: boolean;
    },
  ) {
    const c = await context(actor, input.plan);
    const fingerprint = hash({
      ...input,
      resolutions: [...input.resolutions].sort((a, b) => a.path.localeCompare(b.path)),
    });
    const key = "merge-command:" + hash([repository, actor.id, c.draft, input.command]);
    const prior = (
      await db.execute("SELECT data FROM ww_web_records WHERE repository=? AND id=? AND kind=?", [
        repository,
        key,
        "merge-command",
      ])
    ).rows[0];
    if (prior) {
      const saved = JSON.parse(String(prior.data));
      if (saved.fingerprint !== fingerprint)
        throw new ConflictError("Command key already used with different resolutions");
      return saved.result as Ref;
    }
    const d = await draft(actor, c.draft),
      head = await engine.ref(c.head.name),
      target = await engine.ref(publishedRef);
    if (
      head.snapshot !== c.head.snapshot ||
      head.revision !== c.head.revision ||
      target.snapshot !== c.target.snapshot ||
      target.revision !== c.target.revision ||
      d.data.base !== c.base ||
      d.data.baseRevision !== c.baseRevision
    )
      throw new ConflictError("Draft or published content advanced. Request a new Git merge plan.");
    const merged = await resolveGitMerge(engine, c.git, input.resolutions, input.confirmConflicts);
    return engine.apply({
      ref: c.head.name,
      expectedRevision: c.head.revision,
      changes: merged.changes,
      idempotencyKey: key,
      intent: fingerprint,
      advanceRevision: true,
      audit: { actor: actor.id, source: "git-merge" },
      onCommit: async (tx, result) => {
        const main = (
          await tx.execute("SELECT snapshot,revision FROM ww2_refs WHERE repository=? AND name=?", [
            repository,
            publishedRef,
          ])
        ).rows[0];
        const current = await record<typeof d.data>(c.draft, "draft", tx);
        if (
          main?.snapshot !== c.target.snapshot ||
          Number(main?.revision) !== c.target.revision ||
          current.data.base !== c.base ||
          current.data.baseRevision !== c.baseRevision
        )
          throw new ConflictError(
            "Published content advanced during the merge. Request a new plan.",
          );
        await tx.execute("UPDATE ww_web_records SET data=? WHERE repository=? AND id=?", [
          JSON.stringify({
            ...current.data,
            base: c.target.snapshot,
            baseRevision: c.target.revision,
          }),
          repository,
          c.draft,
        ]);
        await tx.execute(
          "INSERT INTO ww2_git_commits(repository,snapshot,oid,archive) VALUES(?,?,?,?)",
          [repository, result.snapshot, merged.commit, merged.archive],
        );
        await tx.execute(
          "INSERT INTO ww_web_records(repository,id,kind,actor,data) VALUES(?,?,?,?,?)",
          [repository, key, "merge-command", actor.id, JSON.stringify({ fingerprint, result })],
        );
      },
    });
  }
  return { plan, file, apply };
}
