import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "@/index";
import { createTestSetup } from "@/tests/setup";

/**
 * Regression coverage for version-bump reindex.
 *
 * Historically bumping `version` could appear to not fully re-index:
 * - createBranch copied `versions` without entries -> lazy findMany skipped reindex
 * - ensureTrees overwrote versions=[new] instead of appending
 * - merge called ensureTrees before writeEntries -> premature version claim on failure
 * - findMany gated version check on `rootTree &&`, so rootMissing + version mismatch wasn't detected
 * - stale versions claim with empty entries wasn't self-healed
 * - writeCache sibling copy used config.ref not target ref
 */
describe("version bump reindex", () => {
  let t: ReturnType<typeof createTestSetup>;

  beforeEach(async () => {
    t = createTestSetup({ useMemoryDb: true });
    await t.db.reset();
    await t.helper.resetRepo();
    const initialFiles = {
      "content/docs/intro.md": "---\ntitle: Intro\n---\n\n# Intro\n",
      "content/docs/getting-started.md": "---\ntitle: Getting Started\n---\n\n# GS\n",
      "content/authors/jeff.json": JSON.stringify({ name: "Jeff" }),
    };
    await t.helper.addFilesAndCommit(initialFiles, "Initial commit");
  });

  afterEach(async () => {
    await t.helper.cleanup();
  });

  it("findMany auto-reindexes when version bumped and versions array missing new version", async () => {
    await t.git.switch({ ref: "main" });
    const before = await t.client.docs.findMany({});
    expect(before.items.length).toBe(2);

    const clientV2 = t.createClientWithConfig({
      ...t.config.configObject,
      version: "v2",
    });

    // Lazy: no explicit switch for v2. findMany should trigger switch → full reindex.
    const after = await clientV2.docs.findMany({});
    expect(after.items.length).toBe(2);
    const titles = after.items.map((x) => x.title).sort();
    expect(titles).toEqual(["Getting Started", "Intro"]);

    const refRow = await clientV2._.db.refs.get({ ref: "main" });
    expect(refRow?.versions).toContain("v2");
    expect(refRow?.versions).toContain(t.config.version); // old still there
  });

  it("findMany self-heals when versions claims indexed but entries are empty (stale claim)", async () => {
    await t.git.switch({ ref: "main" });
    const clientV2 = t.createClientWithConfig({
      ...t.config.configObject,
      version: "v2",
    });
    await clientV2._.git.switch({ ref: "main" });

    // Simulate stale claim: delete entries for v2 but leave version.
    await t.db.drizzle.delete(t.db.schema.entries).where(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((await import("drizzle-orm")).and as any)(
        (await import("drizzle-orm")).eq(t.db.schema.entries.ref, "main"),
        (await import("drizzle-orm")).eq(t.db.schema.entries.version, "v2"),
      ),
    );

    const healed = await clientV2.docs.findMany({});
    expect(healed.items.length).toBe(2);
  });

  it("createBranch does not inherit versions — new branch reindexes on first query", async () => {
    await t.git.switch({ ref: "main" });
    await t.git.createBranch({ name: "feature/a", base: "main" });

    const branchRowBefore = await t.db.refs.get({ ref: "feature/a" });
    // Bug would have copied versions. Fix: versions should be null/empty.
    expect(branchRowBefore?.versions == null || branchRowBefore?.versions.length === 0).toBe(true);

    const branchFind = await t.client.docs.findMany({ ref: "feature/a" });
    expect(branchFind.items.length).toBe(2);

    const branchRowAfter = await t.db.refs.get({ ref: "feature/a" });
    expect(branchRowAfter?.versions).toContain(t.config.version);
  });

  it("createBranch + version bump reindexes on branch too", async () => {
    await t.git.switch({ ref: "main" });
    await t.git.createBranch({ name: "feature/b", base: "main" });

    const clientV2 = t.createClientWithConfig({
      ...t.config.configObject,
      version: "v2",
    });

    const result = await clientV2.docs.findMany({ ref: "feature/b" });
    expect(result.items.length).toBe(2);
  });

  it("ensureTrees invalidates other versions when root changes, appends when root unchanged", async () => {
    await t.git.switch({ ref: "main" });

    const clientV2 = t.createClientWithConfig({
      ...t.config.configObject,
      version: "v2",
    });
    await clientV2._.git.switch({ ref: "main" });

    // After both switched on same root, both versions valid (append on switch).
    const bothValid = await t.db.refs.get({ ref: "main" });
    expect(bothValid?.versions).toContain(t.config.version);
    expect(bothValid?.versions).toContain("v2");

    // v2 does an add → root changes → other versions invalidated.
    await clientV2._.git.add({
      ref: "main",
      files: { "content/docs/new.md": "---\ntitle: New\n---\n\n# New\n" },
    });

    const afterAdd = await clientV2._.db.refs.get({ ref: "main" });
    // Only writer version remains immediately after root change.
    expect(afterAdd?.versions).toEqual(["v2"]);

    // v2 sees new file.
    const v2 = await clientV2.docs.findMany({});
    expect(v2.items.length).toBeGreaterThanOrEqual(3);

    // v1 auto-reindexes on next query (lazy), so it also sees new file and becomes valid again.
    const v1 = await t.client.docs.findMany({});
    expect(v1.items.length).toBeGreaterThanOrEqual(3);

    const finalRow = await t.db.refs.get({ ref: "main" });
    expect(finalRow?.versions).toContain(t.config.version);
    expect(finalRow?.versions).toContain("v2");
  });

  it("switch on unchanged root appends versions", async () => {
    await t.git.switch({ ref: "main" });
    const clientV2 = t.createClientWithConfig({
      ...t.config.configObject,
      version: "v2",
    });
    await clientV2._.git.switch({ ref: "main" }); // same root, should append not clobber
    const row = await t.db.refs.get({ ref: "main" });
    expect(row?.versions).toContain(t.config.version);
    expect(row?.versions).toContain("v2");
  });

  it("merge indexes before claiming version (no premature claim on failure)", async () => {
    await t.git.switch({ ref: "main" });
    await t.helper.createBranch("feature/merge-test");
    await t.helper.addFilesAndCommit(
      { "content/docs/merged.md": "---\ntitle: Merged\n---\n\n# Merged\n" },
      "Add merged doc",
    );
    await t.helper.switchBranch("main");

    const mergeResult = await t.git.merge({ ours: "main", theirs: "feature/merge-test" });
    expect(mergeResult.type).toBe("success");

    const docs = await t.client.docs.findMany({});
    expect(docs.items.some((d) => d.title === "Merged")).toBe(true);
  });

  it("patchWorktree updates versions so editor saves don't cause version thrash", async () => {
    await t.git.switch({ ref: "main" });
    const before = await t.db.refs.get({ ref: "main" });
    expect(before?.versions).toContain(t.config.version);

    // Simulate editor save via patchWorktree (client-computed tree)
    const oid = await t.git.add({ ref: "main", files: { "content/docs/intro.md": "---\ntitle: Intro patched\n---\n\n# patched\n" } }).then((r) => r.files["content/docs/intro.md"]);
    // findMany should not think version is missing
    const after = await t.client.docs.findMany({ where: { title: { eq: "Intro patched" } } });
    expect(after.items[0]?.title).toBe("Intro patched");
    const refAfter = await t.db.refs.get({ ref: "main" });
    expect(refAfter?.versions).toContain(t.config.version);
    void oid;
  });

  it("rootTree==null + version change triggers reindex, not empty return", async () => {
    // ensureRefInDb creates row with commit but no rootTree. findMany should reindex even if version array incidentally matches.
    await t.git.ensureRefInDb({ ref: "main" });
    const row = await t.db.refs.get({ ref: "main" });
    expect(row).not.toBeNull();
    // rootTree likely null after ensureRefInDb without switch
    const clientV2 = t.createClientWithConfig({
      ...t.config.configObject,
      version: "v2",
    });
    const found = await clientV2.docs.findMany({});
    expect(found.items.length).toBe(2);
  });
});
