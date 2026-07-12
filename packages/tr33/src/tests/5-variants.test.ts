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
        "a.md": `---\ntitle: hello from a\ncategory: b\nauthor: jeff.json\n---\n\n# a`,
        "a.v1.md": `---\ntitle: hello from a v1\ncategory: a\nauthor: jeff.json\n---\n\n# a`,
        "b.fr.v2.md": `---\ntitle: hello from b fr v2\nauthor: jeff.json\n---\n\n# b`,
        "b.fr.md": `---\ntitle: hello from b en fr\nauthor: jeff.json\n---\n\n# b`,
        "b.md": `---\ntitle: hello from b en\nauthor: jeff.json\n---\n\n# b`,
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
          title: z.variant(z.filter(z.string())),
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
        variant: "locale:en|version:v1",
      });
      expect(result.items.map((item) => item.title)).toMatchObject([
        "hello from a v1",
        "hello from b en",
      ]);
    });

    it("adding a variant after default was already present", async () => {
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
          title: z.variant(z.filter(z.string())),
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
      await client._.git.add({
        ref: "main",
        files: {
          "c.md": "---\ntitle: hello from c default\n---\n\n# c",
        },
      });

      const resultBefore = await client._.git.findMany({
        collection: "page",
        variant: "locale:en|version:v1",
        where: {
          title: {
            eq: "hello from c default",
          },
        },
      });
      expect(resultBefore.items).toHaveLength(1);
      await client._.git.add({
        ref: "main",
        files: {
          "c.v1.md": "---\ntitle: hello from c v1\n---\n\n# c",
        },
      });
      const resultAfter = await client._.git.findMany({
        collection: "page",
        variant: "locale:en|version:v1",
        where: {
          title: {
            eq: "hello from c v1",
          },
        },
      });
      expect(resultAfter.items).toHaveLength(1);
    });
  });
});
