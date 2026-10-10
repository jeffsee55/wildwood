import { expect, test } from "vitest";
import { contentContext, isContentShortcut } from "../browser/content-context";
import { sourcemap, withSourcemap } from "../src/sourcemap";

const map = JSON.stringify({
  v: 1,
  repository: "docs",
  source: "/content/intro.md",
  canonical: "/content/intro.md",
  snapshot: "published-snapshot",
  version: "v1",
  variant: { language: "fr" },
  path: ["blocks", 2, "title"],
});

test("page context preserves nested fields and variants without leaking preview credentials", () => {
  const context = contentContext(map, " Bonjour ", "https://docs.test/intro?token=secret#heading");
  const metadata = JSON.parse(context.slice(context.indexOf("{"), context.lastIndexOf("}") + 1));
  expect(metadata).toEqual({
    page: "https://docs.test/intro",
    repository: "docs",
    file: "/content/intro.md",
    canonical: "/content/intro.md",
    field: ["blocks", 2, "title"],
    snapshot: "published-snapshot",
    schemaVersion: "v1",
    variant: { language: "fr" },
    displayedText: "Bonjour",
  });
  expect(context).not.toContain("secret");
  expect(context).toContain("Read the current draft through MCP before editing");
});

test("context accepts the real source-map envelope and bounds large rendered text", () => {
  const doc = withSourcemap("docs", {
    path: "/content/intro.md",
    canonical: "/content/intro.md",
    snapshot: "snapshot",
    version: "v1",
    variant: {},
    projection: "projection",
    value: { title: "Hi" },
  });
  const context = contentContext(
    sourcemap(doc, "title")["data-ww-contentmap"] ?? null,
    "a".repeat(20000),
    "https://docs.test/",
  );
  expect(context.length).toBeLessThan(7000);
  expect(context).toContain('"title"');
});

test("malformed source maps cannot silently insert misleading file context", () => {
  for (const raw of [
    null,
    "{",
    "{}",
    map.replace('"v":1', '"v":2'),
    map.replace('["blocks",2,"title"]', "[-1]"),
  ]) {
    expect(() => contentContext(raw, "Hi", "https://docs.test/")).toThrow();
  }
});

test("only plain command/control L triggers context insertion, including uppercase keyboards", () => {
  const key = {
    key: "l",
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
  };
  expect(isContentShortcut(key)).toBe(true);
  expect(isContentShortcut({ ...key, key: "L", metaKey: false, ctrlKey: true })).toBe(true);
  for (const change of [
    { metaKey: false },
    { altKey: true },
    { shiftKey: true },
    { isComposing: true },
    { key: "k" },
  ]) {
    expect(isContentShortcut({ ...key, ...change })).toBe(false);
  }
});
