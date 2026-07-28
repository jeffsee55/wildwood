import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestSetup } from "@/tests/setup";

describe("delete files (removeEntriesFromTree)", () => {
  let t: ReturnType<typeof createTestSetup>;

  beforeEach(async () => {
    t = createTestSetup({ useMemoryDb: true });
    await t.db.reset();
    await t.helper.resetRepo();

    const initialFiles = {
      "content/docs/getting-started.md": "---\ntitle: Getting Started\n---\n\n# Getting Started",
      "content/docs/advanced.md": "---\ntitle: Advanced\n---\n\n# Advanced",
      "content/docs/nested/deep.md": "---\ntitle: Deep\n---\n\n# Deep",
    };
    await t.helper.addFilesAndCommit(initialFiles, "Initial commit");
  });

  afterEach(async () => {
    await t.helper.cleanup();
  });

  /** Walk content/docs tree to inspect entries. */
  async function docsTreeEntries(rootOid: string) {
    const root = await t.git.getTree(rootOid);
    const docsTree = await t.git.getTree(root!["content"]!.oid);
    return t.git.getTree(docsTree!["docs"]!.oid);
  }

  it("removes a file from the worktree", async () => {
    await t.git.switch({ ref: "main" });

    const worktree = await t.db.refs.get({ ref: "main" });
    expect(worktree).toBeTruthy();
    const rootTreeOid = worktree!.rootTree?.oid ?? worktree!.commit?.treeOid;
    expect(rootTreeOid).toBeTruthy();

    const newRootTreeOid = await t.git.trees.removeEntriesFromTree({
      rootTreeOid: rootTreeOid!,
      paths: ["content/docs/getting-started.md"],
    });

    // The tree should change — the file is gone.
    expect(newRootTreeOid).not.toBe(rootTreeOid);

    // Verify the tree no longer contains the deleted entry.
    const docsEntries = await docsTreeEntries(newRootTreeOid);
    expect(docsEntries).toBeTruthy();
    // "getting-started.md" should be gone; advanced.md + nested/ remain.
    expect("getting-started.md" in docsEntries!).toBe(false);
    expect("advanced.md" in docsEntries!).toBe(true);
    expect("nested" in docsEntries!).toBe(true);
  });

  it("removes multiple files from the worktree", async () => {
    await t.git.switch({ ref: "main" });

    const worktree = await t.db.refs.get({ ref: "main" });
    expect(worktree).toBeTruthy();
    const rootTreeOid = worktree!.rootTree?.oid ?? worktree!.commit?.treeOid;

    const newRootTreeOid = await t.git.trees.removeEntriesFromTree({
      rootTreeOid: rootTreeOid!,
      paths: ["content/docs/getting-started.md", "content/docs/advanced.md"],
    });

    expect(newRootTreeOid).not.toBe(rootTreeOid);

    // Verify the tree no longer contains the deleted entries — walk content/docs.
    const docsEntries = await docsTreeEntries(newRootTreeOid);
    expect(docsEntries).toBeTruthy();
    // Only the nested dir should remain.
    expect(Object.keys(docsEntries!)).toEqual(["nested"]);
  });

  it("removes a nested file from the worktree", async () => {
    await t.git.switch({ ref: "main" });

    const worktree = await t.db.refs.get({ ref: "main" });
    expect(worktree).toBeTruthy();
    const rootTreeOid = worktree!.rootTree?.oid ?? worktree!.commit?.treeOid;

    const newRootTreeOid = await t.git.trees.removeEntriesFromTree({
      rootTreeOid: rootTreeOid!,
      paths: ["content/docs/nested/deep.md"],
    });

    expect(newRootTreeOid).not.toBe(rootTreeOid);

    // The nested file should be gone — walk content/docs/nested.
    const docsEntries = await docsTreeEntries(newRootTreeOid);
    expect(docsEntries).toBeTruthy();
    // The empty nested dir should be pruned.
    expect("nested" in docsEntries!).toBe(false);
  });

  it("is a no-op when removing a non-existent path", async () => {
    await t.git.switch({ ref: "main" });

    const worktree = await t.db.refs.get({ ref: "main" });
    expect(worktree).toBeTruthy();
    const rootTreeOid = worktree!.rootTree?.oid ?? worktree!.commit?.treeOid;

    const newRootTreeOid = await t.git.trees.removeEntriesFromTree({
      rootTreeOid: rootTreeOid!,
      paths: ["content/docs/nonexistent.md"],
    });

    // Removing a non-existent path should not change the tree.
    expect(newRootTreeOid).toBe(rootTreeOid);
  });
});
