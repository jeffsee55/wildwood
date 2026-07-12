import { describe, expect, it } from "vitest";
import { defineConfig } from "@/client/config";
import { z } from "@/index";

const page = z.collection({
  name: "page",
  schema: z.markdown({
    title: z.filter(z.string()),
  }),
  match: "**/*.md",
});

const author = z.collection({
  name: "author",
  schema: z.json({
    name: z.filter(z.string()),
  }),
  match: "**/*.json",
});

describe("Config", () => {
  describe("no variants", () => {
    const config = defineConfig({
      org: "acme",
      repo: "repo",
      ref: "main",
      collections: { page, author },
    });

    it("listVariants returns __", () => {
      expect(config.listVariants()).toEqual(["__"]);
    });

    it("defaultVariant returns __", () => {
      expect(config.defaultVariant()).toBe("__");
    });

    it("findMostSpecificVariant returns first entry", () => {
      expect(config.findMostSpecificVariant(["a.md", "b.md"], "__")).toBe(
        "a.md",
      );
    });

    it("findMissingCombos returns single combo with first entry", () => {
      expect(config.findMissingCombos(["a.md", "b.md"])).toEqual([
        { variant: "__", path: "a.md" },
      ]);
    });

    it("getCollectionForPath returns collection name", () => {
      expect(config.getCollectionForPath("docs/foo.md")).toBe("page");
      expect(config.getCollectionForPath("content/authors/jeff.json")).toBe(
        "author",
      );
    });

    it("matches path against collection globs", () => {
      expect(config.matches("a.md")).toBe(true);
      expect(config.matches("deep/path/doc.md")).toBe(true);
      expect(config.matches("jeff.json")).toBe(true);
      expect(config.matches("x.txt")).toBe(false);
    });
  });

  describe("with variants (locale + version, extensionPrefix)", () => {
    const config = defineConfig({
      org: "acme",
      repo: "repo",
      ref: "main",
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

    it("listVariants returns all combos", () => {
      const list = config.listVariants();
      expect(list).toContain("locale:en|version:v1");
      expect(list).toContain("locale:fr|version:v2");
      expect(list).toHaveLength(6);
    });

    it("defaultVariant uses default options", () => {
      expect(config.defaultVariant()).toBe("locale:en|version:v3");
    });

    it("findMostSpecificVariant: a.v1.md and a.md for version:v1 returns a.v1.md", () => {
      expect(
        config.findMostSpecificVariant(
          ["a.v1.md", "a.md"],
          "locale:en|version:v1",
        ),
      ).toBe("a.v1.md");
    });

    it("findMostSpecificVariant: a.v1.md and a.fr.md for locale:fr|version:v3 returns a.fr.md", () => {
      expect(
        config.findMostSpecificVariant(
          ["a.v1.md", "a.fr.md"],
          "locale:fr|version:v3",
        ),
      ).toBe("a.fr.md");
    });

    it("findMostSpecificVariant: a.v1.md and a.fr.v1.md for locale:fr|version:v1 returns a.fr.v1.md", () => {
      expect(
        config.findMostSpecificVariant(
          ["a.v1.md", "a.fr.v1.md", "a.fr.md"],
          "locale:fr|version:v1",
        ),
      ).toBe("a.fr.v1.md");
    });

    it("findMostSpecificVariant: a.v1.md and a.fr.v2.md for locale:en|version:v1 returns a.v1.md", () => {
      expect(
        config.findMostSpecificVariant(
          ["a.v1.md", "a.fr.v2.md"],
          "locale:en|version:v1",
        ),
      ).toBe("a.v1.md");
    });

    it("findMostSpecificVariant: only a.md for locale:en|version:v3 returns a.md", () => {
      expect(
        config.findMostSpecificVariant(["a.md"], "locale:en|version:v3"),
      ).toBe("a.md");
    });

    it("findMissingCombos: a.v1.md and a.md returns full set with closest match per variant", () => {
      const result = config.findMissingCombos(["a.v1.md", "a.md"]);
      expect(result).toHaveLength(6);
      // Exact matches
      expect(result).toContainEqual({
        variant: "locale:en|version:v1",
        path: "a.v1.md",
      });
      expect(result).toContainEqual({
        variant: "locale:en|version:v3",
        path: "a.md",
      });
      // Fallbacks: no exact file for fr/*, closest match by variant order (locale first)
      expect(result).toContainEqual({
        variant: "locale:fr|version:v1",
        path: "a.v1.md",
      });
      expect(result).toContainEqual({
        variant: "locale:fr|version:v3",
        path: "a.md",
      });
    });

    it("findMissingCombos", () => {
      expect(
        config.findMissingCombos(["b.fr.v2.md", "b.fr.md", "b.md"]),
      ).toMatchObject([
        { variant: "locale:en|version:v1", path: "b.md" },
        { variant: "locale:en|version:v2", path: "b.md" },
        { variant: "locale:en|version:v3", path: "b.md" },
        { variant: "locale:fr|version:v1", path: "b.fr.md" },
        { variant: "locale:fr|version:v2", path: "b.fr.v2.md" },
        { variant: "locale:fr|version:v3", path: "b.fr.md" },
      ]);
      expect(
        config.findMissingCombos(["b.fr.md", "b.v2.md", "b.en.v3.md"]),
      ).toMatchObject([
        { variant: "locale:en|version:v1", path: "" },
        { variant: "locale:en|version:v2", path: "b.v2.md" },
        { variant: "locale:en|version:v3", path: "b.en.v3.md" },
        { variant: "locale:fr|version:v1", path: "b.fr.md" },
        { variant: "locale:fr|version:v2", path: "b.fr.md" },
        { variant: "locale:fr|version:v3", path: "b.fr.md" },
      ]);
    });
  });

  describe("with single variant", () => {
    const config = defineConfig({
      org: "acme",
      repo: "repo",
      ref: "main",
      collections: { page, author },
      variants: {
        version: {
          options: ["v1", "v2"],
          default: "v2",
          pathModifier: { type: "extensionPrefix" },
        },
      },
    });

    it("listVariants returns two combos", () => {
      expect(config.listVariants()).toEqual(["version:v1", "version:v2"]);
    });

    it("findMostSpecificVariant: doc.v1.md and doc.md for version:v1 returns doc.v1.md", () => {
      expect(
        config.findMostSpecificVariant(["doc.v1.md", "doc.md"], "version:v1"),
      ).toBe("doc.v1.md");
    });

    it("findMissingCombos: doc.v1.md and doc.md", () => {
      expect(config.findMissingCombos(["doc.v1.md", "doc.md"])).toEqual([
        { variant: "version:v1", path: "doc.v1.md" },
        { variant: "version:v2", path: "doc.md" },
      ]);
    });
  });
});
