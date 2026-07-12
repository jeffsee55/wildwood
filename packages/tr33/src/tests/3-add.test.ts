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

  describe("add", () => {
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
    });

    it("without switch", async () => {
      await t.git.add({
        ref: "main",
        files: {
          "content/docs/new-file.md":
            "---\ntitle: New file\n---\n\n# New file\n\nNew content",
        },
      });
    });

    it("other versions detect the change made before the switch", async () => {
      await t.git.switch({ ref: "main" });
      await t.git.add({
        ref: "main",
        files: {
          "content/docs/new-file.md":
            "---\ntitle: New file\n---\n\n# New file\n\nNew content",
        },
      });
      const client2 = t.createClientWithConfig({
        ...t.config.configObject,
        version: "2",
      });
      const result3 = await client2.docs.findMany({});
      expect(result3.items.map((r) => r.title)).toEqual([
        "hello from a",
        "hello from b",
        "New file",
      ]);
    });

    it("other versions detect the change made after the switch", async () => {
      await t.git.switch({ ref: "main" });
      const client2 = t.createClientWithConfig({
        ...t.config.configObject,
        version: "2",
      });
      await client2._.git.switch({ ref: "main" });
      await t.git.add({
        ref: "main",
        files: {
          "content/docs/new-file.md":
            "---\ntitle: New file\n---\n\n# New file\n\nNew content",
        },
      });

      const result3 = await client2.docs.findMany({});
      expect(result3.items.map((r) => r.title)).toEqual([
        "hello from a",
        "hello from b",
        "New file",
      ]);
    });

    it("when doing a switch after adding, other versions detect the change made after the switch", async () => {
      await t.git.switch({ ref: "main" });
      const client2 = t.createClientWithConfig({
        ...t.config.configObject,
        version: "2",
      });
      await client2._.git.switch({ ref: "main" });
      await t.git.add({
        ref: "main",
        files: {
          "content/docs/new-file.md":
            "---\ntitle: New file\n---\n\n# New file\n\nNew content",
        },
      });

      const result3 = await client2.docs.findMany({});
      expect(result3.items.map((r) => r.title)).toEqual([
        "hello from a",
        "hello from b",
        "New file",
      ]);
    });

    it("replaces a file", async () => {
      await t.git.switch({ ref: "main" });
      await t.git.add({
        ref: "main",
        files: {
          "content/docs/a.md":
            "---\ntitle: hello from a updated\n---\n\n# a updated",
        },
      });
      const result = await t.client.docs.findMany({
        where: {
          path: { eq: "content/docs/a.md" },
        },
      });
      expect(result.items[0]?.title).toBe("hello from a updated");
    });
  });
});
