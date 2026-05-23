import Link from "next/link";
import { cache, type ReactNode } from "react";
import { ensureDocsContentReady } from "./ensure-docs-ready";
import { getDocsTr33 } from "./tr33";

type Meta = {
  _meta: {
    path: string;
    canonicalPath: string;
    oid: string;
    raw: string;
  };
};

type MarkdownNode = {
  type?: string;
  children?: MarkdownNode[];
  value?: string;
  depth?: number;
  ordered?: boolean;
  url?: string;
  lang?: string;
  name?: string;
  attributes?: Record<string, unknown>;
};

export type Author = Meta & {
  name: string;
  avatar?: string;
};

export type DocPage = Meta & {
  title: string;
  description?: string;
  author?: Author;
  body: MarkdownNode;
};

export type NavItem = Meta & {
  name: string;
  label: string;
  children: string[];
};

export type DocsIndex = {
  docs: DocPage[];
  nav: NavItem | null;
};

export function slugFromDocPath(docPath: string): string {
  return docPath
    .replace(/^content\/docs\//, "")
    .replace(/\.md$/, "")
    .replace(/\/index$/, "");
}

function navChildToDocPath(navPath: string, childPath: string): string {
  const parts = navPath.split("/");
  parts.pop();
  const normalized = [...parts, childPath].join("/").replace(/\/+/g, "/");
  const stack: string[] = [];
  for (const part of normalized.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      stack.pop();
    } else {
      stack.push(part);
    }
  }
  return stack.join("/");
}

export const getDocsIndex = cache(async (): Promise<DocsIndex> => {
  await ensureDocsContentReady();
  const tr33 = getDocsTr33();
  const [docsResult, navResult] = await Promise.all([
    tr33.docs.findMany({}),
    tr33.nav.findMany({}),
  ]);

  const docs = docsResult.items as DocPage[];
  const nav = (navResult.items[0] as NavItem | undefined) ?? null;
  if (!nav) {
    return {
      docs: docs.toSorted((a, b) => a.title.localeCompare(b.title)),
      nav,
    };
  }

  const byPath = new Map(docs.map((doc) => [doc._meta.path, doc]));
  const orderedDocs = nav.children
    .map((child) => byPath.get(navChildToDocPath(nav._meta.path, child)))
    .filter((doc): doc is DocPage => Boolean(doc));
  const orderedPaths = new Set(orderedDocs.map((doc) => doc._meta.path));
  const remainingDocs = docs
    .filter((doc) => !orderedPaths.has(doc._meta.path))
    .toSorted((a, b) => a.title.localeCompare(b.title));

  return {
    docs: [...orderedDocs, ...remainingDocs],
    nav,
  };
});

export async function getDocBySlug(slug: string): Promise<DocPage | null> {
  const { docs } = await getDocsIndex();
  return docs.find((doc) => slugFromDocPath(doc._meta.path) === slug) ?? null;
}

function renderChildren(children: MarkdownNode[] | undefined): ReactNode {
  return children?.map((child, index) => renderMarkdownNode(child, index));
}

function docHrefFromUrl(url: string): string {
  if (!url.endsWith(".md")) {
    return url;
  }
  const slug = url.replace(/^\.\//, "").replace(/\.md$/, "");
  return `/docs/${slug}`;
}

function renderHeading(node: MarkdownNode, key: number): ReactNode {
  const content = renderChildren(node.children);
  switch (node.depth) {
    case 1:
      return (
        <h1 key={key} className="mt-0 text-4xl font-semibold tracking-tight">
          {content}
        </h1>
      );
    case 2:
      return (
        <h2 key={key} className="mt-12 text-2xl font-semibold tracking-tight">
          {content}
        </h2>
      );
    case 3:
      return (
        <h3 key={key} className="mt-8 text-xl font-semibold tracking-tight">
          {content}
        </h3>
      );
    default:
      return (
        <h4 key={key} className="mt-6 text-lg font-semibold tracking-tight">
          {content}
        </h4>
      );
  }
}

function renderMarkdownNode(node: MarkdownNode, key: number): ReactNode {
  switch (node.type) {
    case "root":
      return renderChildren(node.children);
    case "heading":
      return renderHeading(node, key);
    case "paragraph":
      return (
        <p key={key} className="mt-5 leading-7 text-[color:var(--muted)]">
          {renderChildren(node.children)}
        </p>
      );
    case "text":
      return node.value ?? "";
    case "emphasis":
      return <em key={key}>{renderChildren(node.children)}</em>;
    case "strong":
      return <strong key={key}>{renderChildren(node.children)}</strong>;
    case "inlineCode":
      return (
        <code
          key={key}
          className="rounded bg-black/5 px-1.5 py-0.5 font-mono text-sm"
        >
          {node.value}
        </code>
      );
    case "code":
      return (
        <pre
          key={key}
          className="mt-5 overflow-x-auto rounded-2xl border border-[color:var(--border)] bg-[#171412] p-4 text-sm text-white"
        >
          <code>{node.value}</code>
        </pre>
      );
    case "list": {
      const Tag = node.ordered ? "ol" : "ul";
      return (
        <Tag
          key={key}
          className={`mt-5 space-y-2 pl-6 leading-7 text-[color:var(--muted)] ${
            node.ordered ? "list-decimal" : "list-disc"
          }`}
        >
          {renderChildren(node.children)}
        </Tag>
      );
    }
    case "listItem":
      return <li key={key}>{renderChildren(node.children)}</li>;
    case "link":
      return (
        <Link
          key={key}
          href={docHrefFromUrl(node.url ?? "#")}
          className="font-medium text-foreground underline decoration-black/20 underline-offset-4 hover:decoration-black"
        >
          {renderChildren(node.children)}
        </Link>
      );
    case "blockquote":
    case "leafDirective":
      return (
        <blockquote
          key={key}
          className="mt-6 rounded-2xl border border-[color:var(--border)] bg-white p-5 text-[color:var(--muted)]"
        >
          {renderChildren(node.children)}
        </blockquote>
      );
    case "thematicBreak":
      return <hr key={key} className="my-10 border-[color:var(--border)]" />;
    case "break":
      return <br key={key} />;
    default:
      return node.children ? renderChildren(node.children) : (node.value ?? "");
  }
}

export function Markdown({ root }: { root: MarkdownNode }) {
  return <>{renderMarkdownNode(root, 0)}</>;
}
