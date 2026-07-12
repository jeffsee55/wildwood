import type { Root } from "tr33/react/markdown";

type Meta = {
  _meta: {
    path: string;
    canonicalPath: string;
    oid: string;
    raw: string;
    slug: string;
  };
};

export type DocPage = Meta & {
  slug: string;
  path: string;
  title: string;
  description?: string;
  author?: { name: string; avatar?: string } & Meta & { slug: string; path: string };
  body: Root;
};

export type NavItem = Meta & {
  slug: string;
  path: string;
  name: string;
  label: string;
  // Relation: resolved docs in declared order from content/nav/index.json.
  children: DocPage[];
};

export function docHrefFromUrl(url: string): string {
  if (!url.endsWith(".md")) return url;
  return `/docs/${url.replace(/^\.\//, "").replace(/\.md$/, "")}`;
}
