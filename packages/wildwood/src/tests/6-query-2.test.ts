import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "@/index";
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

  describe("variants", () => {
    beforeEach(async () => {
      const initialFiles = {
        "jeff.json": JSON.stringify({ name: "Jeff" }),
        "a.md": `---\ntitle: hello from a\ncategory: a\nauthor: jeff.json\n---\n\n# a`,
        "a.v2.md": `---\ntitle: hello from a v2\ncategory: b\nauthor: jeff.json\n---\n\n# a`,
      };
      await t.helper.addFilesAndCommit(initialFiles, "Initial commit");
    });

    it("works", async () => {
      const author = z.collection({
        name: "author",
        schema: z.json({
          name: z.filter(z.string()),
        }),
        match: "**/*.json",
      });

      const page = z.collection({
        name: "page",
        schema: z.markdown({
          title: z.filter(z.string()),
          category: z.filter(z.string()).optional(),
          author: z.lazy(() =>
            z.connect(author, { referencedAs: "pagesAuthored" }),
          ),
        }),
        match: "**/*.md",
      });

      const client = t.createClientWithConfig({
        ...t.config.configObject,
        collections: { page, author },
        variants: {
          locale: {
            options: ["en", "fr"],
            default: "en",
            pathModifier: { type: "extensionPrefix" },
          },
          version: {
            options: ["v1", "v2", "v3"],
            default: "v3",
            pathModifier: { type: "extensionPrefix" },
          },
        },
      });

      await client._.git.switch({ ref: "main" });

      const result = await (
        client as unknown as {
          page: {
            findMany: (
              opts: object,
            ) => Promise<{ items: Array<{ title: string }> }>;
          };
        }
      ).page.findMany({
        variant: "locale:en|version:v3",
        where: {
          category: {
            eq: "a",
          },
        },
      });
      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.title).toBe("hello from a");
    });
  });
});
