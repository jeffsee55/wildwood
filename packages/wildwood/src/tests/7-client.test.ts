import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestSetup } from "@/tests/setup";

describe("git", () => {
  let t: ReturnType<typeof createTestSetup>;

  beforeEach(async () => {
    t = createTestSetup({ useMemoryDb: true });
    await t.db.reset();
    await t.helper.resetRepo();
    const initialFiles = {
      "content/docs/a.md": `---\ntitle: hello from a\n---\n\n# a`,
      "content/docs/b.md": `---\ntitle: hello from b\nauthor: ../authors/jeff.json\n---\n\n# b`,
      "content/authors/jeff.json": JSON.stringify({ name: "Jeff" }),
    };
    await t.helper.addFilesAndCommit(initialFiles, "Initial commit");
  });

  afterEach(async () => {
    await t.helper.cleanup();
  });

  describe("query with connection", () => {
    it("findMany with author connection", async () => {
      await t.git.switch({ ref: "main" });
      const result = await t.client.docs.findMany({
        where: {
          title: { eq: "hello from b" },
        },
        with: {
          author: true,
        },
      });
      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.title).toBe("hello from b");
      expect(result.items[0]?.author?.name).toBe("Jeff");
    });
  });
});
