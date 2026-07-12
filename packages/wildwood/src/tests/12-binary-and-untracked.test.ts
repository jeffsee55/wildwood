import { calculateBlobOid, calculateBlobOidFromBytes } from "wildwood-store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestSetup } from "@/tests/setup";

// 1x1 red PNG (68 bytes)
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
  "base64",
);

describe("binary and untracked files", () => {
  let t: ReturnType<typeof createTestSetup>;

  beforeEach(async () => {
    t = createTestSetup({ useMemoryDb: true });
    await t.db.reset();
    await t.helper.resetRepo();
    await t.helper.addFilesAndCommit(
      {
        "content/authors/jeff.json": JSON.stringify({ name: "Jeff" }),
        "content/docs/a.md":
          "---\ntitle: hello from a\nauthor: ../authors/jeff.json\n---\n\n# a",
        "package.json": '{"name":"tr33-mono"}',
        "README.md": "# README",
      },
      "Initial commit",
    );
    await t.git.switch({ ref: "main" });
  });

  afterEach(async () => {
    await t.helper.cleanup();
  });

  describe("calculateBlobOidFromBytes", () => {
    it("matches calculateBlobOid for the same UTF-8 content", async () => {
      const text = "Hello, world!";
      const textOid = await calculateBlobOid(text);
      const bytesOid = await calculateBlobOidFromBytes(
        new TextEncoder().encode(text),
      );
      expect(bytesOid).toBe(textOid);
    });

    it("computes a valid OID for binary content", async () => {
      const oid = await calculateBlobOidFromBytes(PNG_BYTES);
      expect(oid).toMatch(/^[0-9a-f]{40}$/);
    });

    it("matches git hash-object for binary content", async () => {
      const oid = await calculateBlobOidFromBytes(PNG_BYTES);
      // Write the PNG to a temp file and let git compute the OID
      await t.helper.addFiles({ "tmp-test.png": PNG_BYTES });
      const gitOid = (
        await import("node:child_process")
      ).execSync(`git hash-object tmp-test.png`, {
        cwd: t.helper.getFullPath(),
        encoding: "utf-8",
      }).trim();
      expect(oid).toBe(gitOid);
    });
  });

  describe("add with untracked text file", () => {
    it("adds untracked text file to the tree without saving to DB", async () => {
      await t.git.add({
        ref: "main",
        files: {
          "untracked/notes.txt": "some notes",
        },
      });

      const worktree = await t.db.refs.get({ ref: "main" });
      expect(worktree).toBeDefined();

      const rootOid = worktree!.rootTree?.oid ?? worktree!.commit?.treeOid;
      expect(rootOid).toBeDefined();

      // The tree should contain the untracked file
      const entry = await t.git.trees.resolve(rootOid!, "untracked/notes.txt");
      expect(entry).toBeDefined();
      expect(entry?.type).toBe("blob");

      // Tracked docs should still be queryable
      const docs = await t.client.docs.findMany({});
      expect(docs.items.length).toBe(1);
    });
  });

  describe("add with binary file", () => {
    it("adds binary file to the tree", async () => {
      await t.git.add({
        ref: "main",
        files: {
          "assets/logo.png": new Uint8Array(PNG_BYTES),
        },
      });

      const worktree = await t.db.refs.get({ ref: "main" });
      const rootOid = worktree!.rootTree?.oid ?? worktree!.commit?.treeOid;
      expect(rootOid).toBeDefined();

      const entry = await t.git.trees.resolve(rootOid!, "assets/logo.png");
      expect(entry).toBeDefined();
      expect(entry?.type).toBe("blob");

      // Verify the OID matches what calculateBlobOidFromBytes computes
      const expectedOid = await calculateBlobOidFromBytes(PNG_BYTES);
      expect(entry?.oid).toBe(expectedOid);
    });

    it("does not break tracked file indexing when mixed with binary", async () => {
      await t.git.add({
        ref: "main",
        files: {
          "content/docs/new.md":
            "---\ntitle: New doc\n---\n\n# New\n\nWith image",
          "assets/banner.png": new Uint8Array(PNG_BYTES),
        },
      });

      // Tracked markdown file should be indexed
      const docs = await t.client.docs.findMany({
        where: { title: { eq: "New doc" } },
      });
      expect(docs.items.length).toBe(1);
      expect(docs.items[0]?.title).toBe("New doc");

      // Binary file should be in the tree
      const worktree = await t.db.refs.get({ ref: "main" });
      const rootOid = worktree!.rootTree?.oid ?? worktree!.commit?.treeOid;
      const entry = await t.git.trees.resolve(rootOid!, "assets/banner.png");
      expect(entry).toBeDefined();
      expect(entry?.type).toBe("blob");
    });
  });
});
