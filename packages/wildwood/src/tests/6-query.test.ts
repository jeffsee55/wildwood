import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestSetup } from "@/tests/setup";

describe("queries", () => {
  let t: ReturnType<typeof createTestSetup>;

  beforeEach(async () => {
    t = createTestSetup({ useMemoryDb: true });
    await t.db.reset();
    await t.helper.resetRepo();
    const initialFiles = {
      "content/authors/jeff.json": JSON.stringify({ name: "Jeff" }),
      "content/authors/heidi.json": JSON.stringify({ name: "Heidi" }),
      "content/docs/getting-started.md":
        "---\ntitle: Getting Started\nauthor: ../authors/jeff.json\n---\n\n# Getting Started",
      "content/docs/advanced.md":
        "---\ntitle: Advanced Guide\nauthor: ../authors/jeff.json\n---\n\n# Advanced Guide",
      "content/docs/tutorial.md":
        "---\ntitle: Tutorial\nauthor: ../authors/heidi.json\n---\n\n# Tutorial",
    };
    await t.helper.addFilesAndCommit(initialFiles, "Initial commit");
  });

  afterEach(async () => {
    await t.helper.cleanup();
  });

  describe("automatic init", () => {
    it("findMany works when DB tables do not exist yet", async () => {
      await t.db.clear();
      const result = await t.git.findMany({ collection: "docs" });
      expect(result).toBeDefined();
    });
  });

  describe("basic queries", () => {
    it("returns all docs", async () => {
      await t.git.switch({ ref: "main" });
      const result = await t.client.docs.findMany({});
      expect(result.items).toHaveLength(3);
      expect(result.items.map((d) => d.title).sort()).toEqual([
        "Advanced Guide",
        "Getting Started",
        "Tutorial",
      ]);
    });

    it("filters by a field", async () => {
      await t.git.switch({ ref: "main" });
      const result = await t.client.docs.findMany({
        where: {
          title: { eq: "Tutorial" },
        },
      });
      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.title).toBe("Tutorial");
    });

    it("filters with like", async () => {
      await t.git.switch({ ref: "main" });
      const result = await t.client.docs.findMany({
        where: {
          title: { like: "%Guide%" },
        },
      });
      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.title).toBe("Advanced Guide");
    });

    it("supports limit and offset", async () => {
      await t.git.switch({ ref: "main" });
      const page1 = await t.client.docs.findMany({ limit: 2 });
      expect(page1.items).toHaveLength(2);

      const page2 = await t.client.docs.findMany({ limit: 2, offset: 2 });
      expect(page2.items).toHaveLength(1);
    });
  });

  describe("connection queries", () => {
    it("queries docs with their author", async () => {
      await t.git.switch({ ref: "main" });
      const result = await t.client.docs.findMany({
        with: {
          author: true,
        },
      });
      expect(result.items).toHaveLength(3);
      for (const doc of result.items) {
        expect(doc.author).toBeDefined();
        if (doc.title === "Tutorial") {
          expect(doc.author?.name).toBe("Heidi");
        } else {
          expect(doc.author?.name).toBe("Jeff");
        }
      }
    });

    it("filters docs by connected author field", async () => {
      await t.git.switch({ ref: "main" });
      const result = await t.client.docs.findMany({
        where: {
          author: {
            name: { eq: "Heidi" },
          },
        },
        with: {
          author: true,
        },
      });
      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.title).toBe("Tutorial");
      expect(result.items[0]?.author?.name).toBe("Heidi");
    });

    it("queries authors with reverse references (docsAuthored)", async () => {
      await t.git.switch({ ref: "main" });
      const result = await t.client.authors.findMany({
        where: {
          name: { eq: "Jeff" },
        },
        references: {
          docsAuthored: true,
        },
      });
      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.docsAuthored).toHaveLength(2);
      expect(result.items[0]?.docsAuthored?.map((d) => d.title).sort()).toEqual([
        "Advanced Guide",
        "Getting Started",
      ]);
    });

    it("reverse references support where, limit, offset", async () => {
      await t.git.switch({ ref: "main" });
      const result = await t.client.authors.findMany({
        where: {
          name: { eq: "Jeff" },
        },
        references: {
          docsAuthored: {
            where: {
              title: { like: "Getting%" },
            },
            limit: 1,
          },
        },
      });
      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.docsAuthored).toHaveLength(1);
      expect(result.items[0]?.docsAuthored?.[0]?.title).toBe("Getting Started");
    });
  });
});
