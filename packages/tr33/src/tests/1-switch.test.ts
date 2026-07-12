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

  describe("large repo", () => {
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

    describe("switch", () => {
      it("switching to a branch that exists on remote", async () => {
        await t.git.switch({ ref: "main" });
        // return;

        await t.helper.createBranch("feature/new-blob");
        await t.helper.switchBranch("feature/new-blob");
        await t.helper.addFilesAndCommit(
          {
            "content/docs/a.md":
              "---\ntitle: hello from a updated\nauthor: ../authors/jeff.json\n---\n\n# a updated",
            "content/docs/d.md":
              "---\ntitle: hello from d\nauthor: ../authors/jeff.json\n---\n\n# d",
          },
          "Add d",
        );
        await t.helper.deleteFilesAndCommit(["content/docs/b.md"], "Delete a");

        await t.git.switch({ ref: "feature/new-blob" });
        await t.helper.addFilesAndCommit(
          {
            "content/docs/e.md":
              "---\ntitle: hello from e\nauthor: ../authors/jeff.json\n---\n\n# e",
            "content/unrelated/f.md": "---\ntitle: hello from f\n---\n\n# f",
          },
          "Add e",
        );
        await t.git.pull({ ref: "feature/new-blob" });
        const result = await t.client.docs.findMany({
          ref: "feature/new-blob",
        });
        expect(result.items.map((item) => item.title)).toMatchObject([
          "hello from a updated",
          "hello from d",
          "hello from e",
        ]);
      });
    });
  });
});
