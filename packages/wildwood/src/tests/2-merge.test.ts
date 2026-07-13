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
      };
      await t.helper.addFilesAndCommit(initialFiles, "Initial commit");
    });

    describe("merge (ORT strategy)", () => {
      it("should merge cleanly when only one side has changes", async () => {
        await t.helper.createBranch("feature");
        await t.helper.addFilesAndCommit(
          {
            "content/docs/feature1.md":
              "---\ntitle: Feature 1\nauthor: ../authors/jeff.json\n---\n\n# Feature 1\n\nNew feature content",
          },
          "Add feature1",
        );
        await t.helper.addFilesAndCommit(
          {
            "content/docs/feature2.md":
              "---\ntitle: Feature 2\nauthor: ../authors/jeff.json\n---\n\n# Feature 2\n\nMore feature content",
          },
          "Add feature2",
        );

        await t.git.switch({ ref: "main" });
        await t.git.switch({ ref: "feature" });

        const result = await t.git.merge({
          ours: "main",
          theirs: "feature",
        });
        expect(result.type).toBe("success");
        const result2 = await t.client.docs.findMany({});
        expect(result2.items.map((item) => item._meta.path)).toEqual([
          "content/docs/a.md",
          "content/docs/b.md",
          "content/docs/feature1.md",
          "content/docs/feature2.md",
        ]);
      });

      it("should merge cleanly when both sides add different files", async () => {
        await t.helper.createBranch("feature");
        await t.helper.addFilesAndCommit(
          {
            "content/docs/feature.md":
              "---\ntitle: Feature\nauthor: ../authors/jeff.json\n---\n\n# Feature\n\nFeature content",
          },
          "Add feature.md",
        );

        await t.helper.switchBranch("main");
        await t.helper.addFilesAndCommit(
          {
            "content/docs/main.md":
              "---\ntitle: Main\nauthor: ../authors/jeff.json\n---\n\n# Main\n\nMain content",
          },
          "Add main.md",
        );

        await t.git.switch({ ref: "main" });
        await t.git.switch({ ref: "feature" });

        const result = await t.git.merge({
          ours: "main",
          theirs: "feature",
        });
        expect(result.type).toBe("success");
        const result2 = await t.client.docs.findMany({});
        expect(result2.items.map((item) => item._meta.path)).toEqual([
          "content/docs/a.md",
          "content/docs/b.md",
          "content/docs/feature.md",
          "content/docs/main.md",
        ]);

        const result4 = await t.git.merge({
          ours: "feature",
          theirs: "main",
        });
        expect(result4.type).toBe("success");
        const result5 = await t.client.docs.findMany({
          ref: "feature",
        });
        expect(result5.items.map((item) => item._meta.path)).toEqual([
          "content/docs/a.md",
          "content/docs/b.md",
          "content/docs/feature.md",
          "content/docs/main.md",
        ]);
      });

      it("should detect add-add conflict when both sides add same file with different content", async () => {
        await t.helper.createBranch("feature");
        await t.helper.addFilesAndCommit(
          {
            "content/docs/new.md": "# New File\n\nFeature version of the file",
          },
          "Add new.md (feature)",
        );
        await t.helper.switchBranch("main");
        await t.helper.addFilesAndCommit(
          { "content/docs/new.md": "# New File\n\nMain version of the file" },
          "Add new.md (main)",
        );

        await t.git.switch({ ref: "main" });
        await t.git.switch({ ref: "feature" });

        const result = await t.git.merge({
          ours: "main",
          theirs: "feature",
        });
        expect(result.type).toBe("conflict");
        if (result.type === "conflict") {
          expect(result.diff.conflicts).toHaveLength(1);
          expect(result.diff.conflicts[0].path).toBe("content/docs/new.md");
        }
      });

      it("should merge cleanly when both sides modify different files", async () => {
        await t.helper.createBranch("feature");
        await t.helper.addFilesAndCommit(
          {
            "content/docs/a.md":
              "---\ntitle: modified by feature\nauthor: ../authors/jeff.json\n---\n\n# a modified",
          },
          "Modify a.md",
        );

        await t.helper.switchBranch("main");
        await t.helper.addFilesAndCommit(
          {
            "content/docs/b.md":
              "---\ntitle: modified by main\nauthor: ../authors/jeff.json\n---\n\n# b modified",
          },
          "Modify b.md",
        );

        await t.git.switch({ ref: "main" });
        await t.git.switch({ ref: "feature" });

        const result = await t.git.merge({
          ours: "main",
          theirs: "feature",
        });
        expect(result.type).toBe("success");

        const result2 = await t.client.docs.findMany({});
        expect(result2.items.map((item) => item.title)).toMatchObject([
          "modified by feature",
          "modified by main",
        ]);

        await t.helper.mergeBranch("feature");
        const realTreeOid = await t.helper.getTreeOid();
        expect(result.type).toBe("success");
        if (result.type === "success") {
          expect(result.commit.treeOid).toBe(realTreeOid);
        }
      });

      it("should detect content conflict when both sides modify same file differently", async () => {
        await t.helper.createBranch("feature");
        await t.helper.addFilesAndCommit(
          {
            "content/docs/a.md":
              "---\ntitle: feature title\nauthor: ../authors/jeff.json\n---\n\n# Feature heading",
          },
          "Modify a.md (feature)",
        );

        await t.helper.switchBranch("main");
        await t.helper.addFilesAndCommit(
          {
            "content/docs/a.md":
              "---\ntitle: main title\nauthor: ../authors/jeff.json\n---\n\n# Main heading",
          },
          "Modify a.md (main)",
        );

        await t.git.switch({ ref: "main" });

        const result = await t.git.merge({
          ours: "main",
          theirs: "feature",
        });
        expect(result.type).toBe("conflict");
        if (result.type === "conflict") {
          expect(result.diff.conflicts).toHaveLength(1);
          expect(result.diff.conflicts[0].path).toBe("content/docs/a.md");
        }
      });

      it("should detect modify-delete conflict", async () => {
        await t.helper.createBranch("feature");
        await t.helper.addFilesAndCommit({ "content/docs/a.md": "" }, "Delete a.md");
        const { execSync } = await import("node:child_process");
        execSync("git rm content/docs/a.md && git commit -m 'Actually delete a.md'", {
          cwd: t.helper.getFullPath(),
          stdio: "pipe",
        });

        await t.helper.switchBranch("main");
        await t.helper.addFilesAndCommit(
          {
            "content/docs/a.md":
              "---\ntitle: modified\nauthor: ../authors/jeff.json\n---\n\n# Modified content",
          },
          "Modify a.md",
        );

        await t.git.switch({ ref: "main" });

        const result = await t.git.merge({
          ours: "main",
          theirs: "feature",
        });
        expect(result.type).toBe("conflict");
        if (result.type === "conflict") {
          expect(result.diff.conflicts).toHaveLength(1);
          expect(result.diff.conflicts[0].path).toBe("content/docs/a.md");
          expect(result.diff.conflicts[0].message).toBe(
            `Merge conflict (modify-delete): "content/docs/a.md" was modified on ours and deleted on theirs`,
          );
        }
      });

      it("should handle same modification on both sides (no conflict)", async () => {
        const newContent =
          "---\ntitle: same change\nauthor: ../authors/jeff.json\n---\n\n# Same content";

        await t.helper.createBranch("feature");
        await t.helper.addFilesAndCommit({ "content/docs/a.md": newContent }, "Modify a.md");

        await t.helper.switchBranch("main");
        await t.helper.addFilesAndCommit({ "content/docs/a.md": newContent }, "Modify a.md");

        await t.git.switch({ ref: "main" });

        const result = await t.git.merge({
          ours: "main",
          theirs: "feature",
        });
        expect(result.type).toBe("success");
        if (result.type === "success") {
          expect(result.commit).toBeDefined();
          const realTreeOid = await t.helper.getTreeOid();
          expect(result.commit.treeOid).toBe(realTreeOid);
        }
      });

      it("should cleanly merge non-overlapping changes to the same file", async () => {
        const baseContent = [
          "line 1: original",
          "line 2: original",
          "line 3: original",
          "line 4: original",
          "line 5: original",
        ].join("\n");

        await t.helper.addFilesAndCommit({ "content/docs/a.md": baseContent }, "Initial a.md");

        await t.helper.createBranch("feature");
        const featureContent = [
          "line 1: original",
          "line 2: original",
          "line 3: original",
          "line 4: original",
          "line 5: modified by feature",
        ].join("\n");
        await t.helper.addFilesAndCommit({ "content/docs/a.md": featureContent }, "Modify line 5");

        await t.helper.switchBranch("main");
        const mainContent = [
          "line 1: modified by main",
          "line 2: original",
          "line 3: original",
          "line 4: original",
          "line 5: original",
        ].join("\n");
        await t.helper.addFilesAndCommit({ "content/docs/a.md": mainContent }, "Modify line 1");

        await t.git.switch({ ref: "main" });

        const result = await t.git.merge({
          ours: "main",
          theirs: "feature",
        });
        expect(result.type).toBe("success");
        if (result.type === "success") {
          expect(result.commit).toBeDefined();

          await t.helper.mergeBranch("feature");
          const realTreeOid = await t.helper.getTreeOid();
          expect(result.commit.treeOid).toBe(realTreeOid);
        }
      });
    });
  });
});
