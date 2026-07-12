import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestSetup } from "@/tests/setup";

describe("git", () => {
  let t: ReturnType<typeof createTestSetup>;

  beforeEach(async () => {
    t = createTestSetup({ useMemoryDb: true });
    await t.db.reset();
    await t.helper.resetRepo();
  });

  afterEach(async () => {
    await t.helper.cleanup();
  });

  describe("commit", () => {
    beforeEach(async () => {
      const initialFiles = {
        "content/authors/jeff.json": JSON.stringify({ name: "Jeff" }),
        "content/docs/a.md": `---\ntitle: hello from a\nauthor: ../authors/jeff.json\n---\n\n# a`,
        "content/docs/b.md": `---\ntitle: hello from b\nauthor: ../authors/jeff.json\n---\n\n# b`,
        "content/unrelated/c.json": "{}",
        "package.json": `{"name": "tr33-mono"}`,
        "README.md": "# README",
      };
      await t.helper.addFilesAndCommit(initialFiles, "Initial commit");
    });

    it("adds a new file", async () => {
      await t.git.switch({ ref: "main" });
      await t.git.add({
        ref: "main",
        files: {
          "content/docs/new-file.md":
            "---\ntitle: New file\n---\n\n# New file\n\nNew content",
        },
      });

      const result = await t.client.docs.findMany({
        where: {
          path: { eq: "content/docs/new-file.md" },
        },
      });
      expect(result.items[0]?.title).toBe("New file");
      const commit = await t.git.commit({
        ref: "main",
        commit: {
          message: "Add new file",
          author: {
            name: "Jeff",
            email: "jeff@jeff.com",
          },
          committer: {
            name: "Jeff",
            email: "jeff@jeff.com",
          },
        },
      });

      expect(commit.treeOid).toMatch(/^[a-f0-9]{40}$/);
      expect(commit.oid).toMatch(/^[a-f0-9]{40}$/);

      await t.helper.addFilesAndCommit(
        {
          "content/docs/new-file.md":
            "---\ntitle: New file\n---\n\n# New file\n\nNew content",
        },
        "Add new file",
      );
      const gitTreeOid = await t.helper.getTreeOid();
      expect(commit.treeOid).toBe(gitTreeOid);
    });
  });
});
