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

  describe("switch", () => {
    beforeEach(async () => {
      const initialFiles = {
        "content/other/nested/unrelated.md": `# Unrelated`,
        "content/docs/getting-started.md":
          "---\ntitle: Getting Started\n---\n\n# Getting Started",
      };
      await t.helper.addFilesAndCommit(initialFiles, "Initial commit");
    });
    it("works", async () => {
      await t.git.switch({ ref: "main" });
      const result = await t.client.docs.findMany({
        where: {
          title: { eq: "Getting Started" },
        },
      });
      expect(result.items[0]?.title).toBe("Getting Started");
    });
    it("works with multiple configs", async () => {
      await t.git.switch({ ref: "main" });
      const client2 = t.createClientWithConfig({
        ...t.config.configObject,
        version: "2",
      });
      await client2._.git.switch({ ref: "main" });
      const result = await client2.docs.findMany({
        where: {
          title: { eq: "Getting Started" },
        },
      });
      expect(result.items[0]?.title).toBe("Getting Started");
    });
    it("works with multiple configs when a previous config didn't cover the same files", async () => {
      await t.git.switch({ ref: "main" });
      const client2 = t.createClientWithConfig({
        ...t.config.configObject,
        collections: {
          ...t.config.configObject.collections,
          other: z.collection({
            name: "other",
            match: "content/other/**/*.md",
            schema: z.markdown(),
          }),
        },
        version: "2",
      });
      await client2._.git.switch({ ref: "main" });
      // @ts-expect-error - other is not a collection on the original config
      const result = await client2.other.findMany({
        where: {
          path: { eq: "content/other/nested/unrelated.md" },
        },
      });
      expect(result.items[0]).toBeDefined();
    });
    it("works with multiple configs when there's already a change", async () => {
      await t.git.switch({ ref: "main" });
      await t.git.add({
        ref: "main",
        files: {
          "content/docs/hello-world.md":
            "---\ntitle: Hello World\n---\n\n# Hello W",
        },
      });
      const client2 = t.createClientWithConfig({
        ...t.config.configObject,
        version: "2",
      });
      await client2._.git.switch({ ref: "main" });
      const result = await client2.docs.findMany({
        where: {
          title: { eq: "Hello World" },
        },
      });
      expect(result.items[0]?.title).toBe("Hello World");
    });
    it("back-and-forth", async () => {
      const t2 = t.createClientWithConfig({
        ...t.config.configObject,
        version: "2",
      });

      await t.git.switch({ ref: "main" });
      await t.git.add({
        ref: "main",
        files: {
          "content/docs/hello-world.md":
            "---\ntitle: Hello World\n---\n\n# Hello W",
        },
      });
      const result1 = await t2.docs.findMany({
        where: {
          title: { eq: "Hello World" },
        },
      });
      expect(result1.items[0]?.title).toBe("Hello World");

      const result2 = await t2.docs.findMany({
        where: {
          title: { eq: "Hello World" },
        },
      });
      expect(result2.items[0]?.title).toBe("Hello World");

      await t2._.git.add({
        ref: "main",
        files: {
          "content/docs/hello-world.md":
            "---\ntitle: Hello World Updated\n---\n\n# Hello World Updated",
        },
      });
      const result3 = await t2.docs.findMany({
        where: {
          title: { eq: "Hello World Updated" },
        },
      });
      expect(result3.items[0]?.title).toBe("Hello World Updated");
      const result4 = await t.client.docs.findMany({
        where: {
          title: { eq: "Hello World Updated" },
        },
      });
      expect(result4.items[0]?.title).toBe("Hello World Updated");

      await t.git.add({
        ref: "main",
        files: {
          "content/docs/hello-world.md":
            "---\ntitle: Hello World Updated Again\n---\n\n# Hello World Updated Again",
        },
      });
      const result5 = await t.client.docs.findMany({
        where: {
          title: { eq: "Hello World Updated Again" },
        },
      });
      expect(result5.items[0]?.title).toBe("Hello World Updated Again");
      const result6 = await t2.docs.findMany({
        where: {
          title: { eq: "Hello World Updated Again" },
        },
      });
      expect(result6.items[0]?.title).toBe("Hello World Updated Again");
    });
    it("works with multiple configs when there's already a committed change", async () => {
      await t.git.switch({ ref: "main" });
      await t.git.add({
        ref: "main",
        files: {
          "content/docs/hello-world.md":
            "---\ntitle: Hello World\n---\n\n# Hello W",
        },
      });
      const client2 = t.createClientWithConfig({
        ...t.config.configObject,
        version: "2",
      });
      await t.git.commit({
        ref: "main",
        commit: {
          message: "Add hello world",
          author: {
            name: "Jeff",
            email: "jeff@jeff.com",
          },
        },
      });
      const result = await client2.docs.findMany({
        where: {
          title: { eq: "Hello World" },
        },
      });
      expect(result.items[0]?.title).toBe("Hello World");
      await client2._.git.add({
        ref: "main",
        files: {
          "content/docs/hello-world.md":
            "---\ntitle: Hello World Updated\n---\n\n# Hello World Updated",
        },
      });
      const result3 = await client2.docs.findMany({
        where: {
          title: { eq: "Hello World Updated" },
        },
      });
      expect(result3.items[0]?.title).toBe("Hello World Updated");
      const result4 = await t.client.docs.findMany({
        where: {
          title: { eq: "Hello World Updated" },
        },
      });
      expect(result4.items[0]?.title).toBe("Hello World Updated");
    });
    it("findMany works with multiple configs when there's already a change", async () => {
      await t.git.switch({ ref: "main" });
      await t.git.add({
        ref: "main",
        files: {
          "content/docs/hello-world.md":
            "---\ntitle: Hello World\n---\n\n# Hello W",
        },
      });
      const client2 = t.createClientWithConfig({
        ...t.config.configObject,
        version: "2",
      });
      const result = await client2.docs.findMany({
        where: {
          title: { eq: "Hello World" },
        },
      });
      expect(result.items[0]?.title).toBe("Hello World");
    });
  });
});
