import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestSetup } from "@/tests/setup";

describe("queries", () => {
  let t: ReturnType<typeof createTestSetup>;

  beforeEach(async () => {
    t = createTestSetup({ useMemoryDb: true });
    await t.db.reset();
    await t.helper.resetRepo();

    const initialFiles = {
      "content/docs/getting-started.md": "---\ntitle: Getting Started\n---\n\n# Getting Started",
    };
    await t.helper.addFilesAndCommit(initialFiles, "Initial commit");
  });

  afterEach(async () => {
    await t.helper.cleanup();
  });

  describe("git", () => {
    it("add", async () => {
      await t.git.switch({ ref: "main" });
      await t.git.add({
        ref: "main",
        files: {
          "content/docs/new-file.md": "---\ntitle: New file\n---\n\n# New file",
        },
      });
      const result = await t.client.docs.findMany({
        where: {
          title: { eq: "New file" },
        },
      });
      expect(result.items[0]?.title).toBe("New file");
    });
  });
});
