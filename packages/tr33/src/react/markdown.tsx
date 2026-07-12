/**
 * Framework-agnostic, mdast-typed markdown renderer.
 *
 * - Input is `mdast.Root` (what `z.markdown()` returns as `body`).
 * - No `next/*`, no `"use client"`. Works in RSC and client components.
 * - Extensible via `components` map (similar to `react-markdown`).
 * - Styling is minimal by default; pass `classNames` or override `components`
 *   to inject your design system (Tailwind, shadcn, etc).
 *
 * Example (Next.js App Router, branch-aware cache):
 *
 *   // app/blog/page.tsx
 *   import { cacheTag, cacheLife } from "next/cache"
 *   import { TR33_CACHE_TAG } from "tr33/nextjs/branch"
 *   import { Markdown } from "tr33/react/markdown"
 *   import Link from "next/link"
 *
 *   async function BlogList() {
 *     "use cache"
 *     cacheLife("hours")
 *     cacheTag(TR33_CACHE_TAG)
 *
 *     const docs = await tr33.docs.findMany({})
 *     return <ul>{docs.items.map(d => <li key={d._meta.path}>{d.title}</li>)}</ul>
 *   }
 *
 *   // Render a doc's body (generic, not bound to your collections):
 *   <Markdown
 *     root={doc.body}
 *     getLinkHref={(url) => url.endsWith(".md") ? `/docs/${url.replace(/^\.\//,"").replace(/\.md$/,"")}` : url}
 *     components={{
 *       a: ({ href, children, ...rest }) => (
 *         <Link href={href!} {...rest}>{children}</Link>
 *       ),
 *     }}
 *     classNames={{
 *       h1: "mt-0 text-4xl font-semibold tracking-tight",
 *       p: "mt-5 leading-7 text-muted-foreground",
 *     }}
 *   />
 *
 * Draft/preview:
 *   When your `/api/draft` route calls `draftMode().enable()` + sets
 *   `x-tr33-branch` (or `x-content-branch` for compat), Next automatically
 *   bypasses `"use cache"`. Disabling draft via `draftMode().disable()` +
 *   deleting the branch cookie resumes caching. `createTr33Route` in
 *   `tr33/nextjs/route` handles `revalidateTag(TR33_CACHE_TAG)` for you.
 */

import type { Root, RootContent, Heading } from "mdast";
import type { ComponentPropsWithoutRef, ReactNode } from "react";

export type { Root } from "mdast";

// ── mdast augmentation ------------------------------------------------------
// Our `z.markdown()` returns `Root & { raw, links, leafDirectives }`.
// The renderer accepts plain `Root`; these extras are optional.

type AugmentedRoot = Root & {
  raw?: string;
  links?: unknown[];
  leafDirectives?: unknown[];
};

// Nodes we deliberately handle even if not in mdast's strict `RootContent`
// union (leafDirectives come from `micromark-extension-directive`).
type ExtendedPhrasing =
  | RootContent
  | {
      type: "leafDirective";
      name: string;
      attributes?: Record<string, unknown>;
      children?: MdastNode[];
      position?: unknown;
    }
  | {
      type: "inlineDirective";
      name: string;
      attributes?: Record<string, unknown>;
      children?: MdastNode[];
    }
  | {
      type: "containerDirective";
      name: string;
      attributes?: Record<string, unknown>;
      children?: MdastNode[];
    };

type MdastNode = AugmentedRoot | ExtendedPhrasing | { type: string; value?: string; children?: MdastNode[]; depth?: number; ordered?: boolean; url?: string; lang?: string; [k: string]: unknown };

type NodeType =
  | "root"
  | "heading"
  | "paragraph"
  | "text"
  | "emphasis"
  | "strong"
  | "inlineCode"
  | "code"
  | "list"
  | "listItem"
  | "link"
  | "blockquote"
  | "leafDirective"
  | "containerDirective"
  | "inlineDirective"
  | "thematicBreak"
  | "break"
  | "image"
  | "html";

// ── public props ───────────────────────────────────────────────────────────

export type MarkdownClassNames = Partial<
  Record<NodeType | "ul" | "ol" | "h1" | "h2" | "h3" | "h4" | "a" | "p" | "code" | "pre" | "blockquote" | "li", string>
>;

export type MarkdownComponents = {
  root?: (props: { children: ReactNode }) => ReactNode;
  h1?: (props: ComponentPropsWithoutRef<"h1"> & { node?: Heading }) => ReactNode;
  h2?: (props: ComponentPropsWithoutRef<"h2"> & { node?: Heading }) => ReactNode;
  h3?: (props: ComponentPropsWithoutRef<"h3"> & { node?: Heading }) => ReactNode;
  h4?: (props: ComponentPropsWithoutRef<"h4"> & { node?: Heading }) => ReactNode;
  p?: (props: ComponentPropsWithoutRef<"p">) => ReactNode;
  em?: (props: ComponentPropsWithoutRef<"em">) => ReactNode;
  strong?: (props: ComponentPropsWithoutRef<"strong">) => ReactNode;
  code?: (props: ComponentPropsWithoutRef<"code">) => ReactNode;
  pre?: (props: ComponentPropsWithoutRef<"pre"> & { lang?: string }) => ReactNode;
  ul?: (props: ComponentPropsWithoutRef<"ul">) => ReactNode;
  ol?: (props: ComponentPropsWithoutRef<"ol">) => ReactNode;
  li?: (props: ComponentPropsWithoutRef<"li">) => ReactNode;
  a?: (props: ComponentPropsWithoutRef<"a"> & { href?: string; node?: unknown }) => ReactNode;
  blockquote?: (props: ComponentPropsWithoutRef<"blockquote">) => ReactNode;
  hr?: (props: ComponentPropsWithoutRef<"hr">) => ReactNode;
  br?: (props: ComponentPropsWithoutRef<"br">) => ReactNode;
  img?: (props: ComponentPropsWithoutRef<"img">) => ReactNode;
  /** Fallback for unknown / directive nodes */
  div?: (props: ComponentPropsWithoutRef<"div"> & { node?: MdastNode }) => ReactNode;
} & {
  // allow `link`, `leafDirective`, etc
  link?: MarkdownComponents["a"];
  leafDirective?: (props: { name: string; attributes?: Record<string, unknown>; children: ReactNode; node: MdastNode }) => ReactNode;
  inlineDirective?: (props: { name: string; attributes?: Record<string, unknown>; children: ReactNode; node: MdastNode }) => ReactNode;
  containerDirective?: (props: { name: string; attributes?: Record<string, unknown>; children: ReactNode; node: MdastNode }) => ReactNode;
};

export type MarkdownProps = {
  /** `mdast.Root` — e.g. `doc.body` from `z.markdown()`. */
  root: Root | AugmentedRoot;
  /** Override or wrap renderers for individual node types. */
  components?: MarkdownComponents;
  /**
   * Override Tailwind / CSS class names for built-ins without providing
   * full components. Merged with defaults.
   */
  classNames?: MarkdownClassNames;
  /**
   * Transform raw markdown link URLs into your app's href format.
   * Return `undefined` to skip rendering that link as clickable.
   *
   * @example
   *   getLinkHref={(url) => url.endsWith(".md") ? `/docs/${url.replace(/^\.\\//,"").replace(/\\.md$/,"")}` : url}
   */
  getLinkHref?: (url: string) => string | undefined;
  className?: string;
};

// ── internals ──────────────────────────────────────────────────────────────

type Ctx = {
  components: MarkdownComponents;
  classNames: MarkdownClassNames;
  getLinkHref?: (url: string) => string | undefined;
};

function childrenOf(node: MdastNode): MdastNode[] | undefined {
  const n = node as { children?: MdastNode[] };
  return n.children;
}

function renderChildren(children: MdastNode[] | undefined, ctx: Ctx): ReactNode {
  if (!children || children.length === 0) return null;
  return children.map((child, i) => renderNode(child, i, ctx));
}

function cn(...parts: (string | undefined | false)[]): string | undefined {
  const s = parts.filter(Boolean).join(" ");
  return s || undefined;
}

function nodeText(node: MdastNode): string | undefined {
  if (typeof (node as { value?: unknown }).value === "string") {
    return (node as { value: string }).value;
  }
  return undefined;
}

function renderNode(node: MdastNode, key: number, ctx: Ctx): ReactNode {
  const { components: C, classNames: $ } = ctx;
  const t = (node as { type?: string }).type as string | undefined;

  switch (t) {
    case "root": {
      const kids = renderChildren(childrenOf(node), ctx);
      if (C.root) return <C.root key={key}>{kids}</C.root>;
      return <>{kids}</>;
    }

    case "heading": {
      const depth = (node as { depth?: number }).depth ?? 1;
      const kids = renderChildren(childrenOf(node), ctx);
      if (depth === 1) {
        if (C.h1) return <C.h1 key={key} node={node as unknown as Heading}>{kids}</C.h1>;
        return <h1 key={key} className={$.h1 ?? $.heading}>{kids}</h1>;
      }
      if (depth === 2) {
        if (C.h2) return <C.h2 key={key} node={node as unknown as Heading}>{kids}</C.h2>;
        return <h2 key={key} className={$.h2 ?? $.heading}>{kids}</h2>;
      }
      if (depth === 3) {
        if (C.h3) return <C.h3 key={key} node={node as unknown as Heading}>{kids}</C.h3>;
        return <h3 key={key} className={$.h3 ?? $.heading}>{kids}</h3>;
      }
      if (C.h4) return <C.h4 key={key} node={node as unknown as Heading}>{kids}</C.h4>;
      return <h4 key={key} className={$.h4 ?? $.heading}>{kids}</h4>;
    }

    case "paragraph": {
      const kids = renderChildren(childrenOf(node), ctx);
      if (C.p) return <C.p key={key}>{kids}</C.p>;
      return <p key={key} className={$.p ?? $.paragraph}>{kids}</p>;
    }

    case "text":
      return nodeText(node) ?? "";

    case "emphasis": {
      const kids = renderChildren(childrenOf(node), ctx);
      if (C.em) return <C.em key={key}>{kids}</C.em>;
      return <em key={key}>{kids}</em>;
    }

    case "strong": {
      const kids = renderChildren(childrenOf(node), ctx);
      if (C.strong) return <C.strong key={key}>{kids}</C.strong>;
      return <strong key={key}>{kids}</strong>;
    }

    case "inlineCode": {
      const v = nodeText(node) ?? "";
      if (C.code) return <C.code key={key}>{v}</C.code>;
      return <code key={key} className={cn("rounded bg-black/5 px-1.5 py-0.5 font-mono text-sm", $.inlineCode, $.code)}>{v}</code>;
    }

    case "code": {
      const v = nodeText(node) ?? "";
      const lang = (node as { lang?: string }).lang;
      if (C.pre) return <C.pre key={key} lang={lang}><code>{v}</code></C.pre>;
      // inherit `.code` className only when no specific `pre` override
      return (
        <pre key={key} className={cn("mt-5 overflow-x-auto rounded-2xl border p-4 text-sm", $.pre ?? $.code)}>
          <code>{v}</code>
        </pre>
      );
    }

    case "list": {
      const ordered = (node as { ordered?: boolean }).ordered ?? false;
      const kids = renderChildren(childrenOf(node), ctx);
      if (ordered) {
        if (C.ol) return <C.ol key={key}>{kids}</C.ol>;
        return <ol key={key} className={cn("mt-5 space-y-2 pl-6", $.ol ?? $.list)}>{kids}</ol>;
      }
      if (C.ul) return <C.ul key={key}>{kids}</C.ul>;
      return <ul key={key} className={cn("mt-5 space-y-2 pl-6", $.ul ?? $.list)}>{kids}</ul>;
    }

    case "listItem": {
      const kids = renderChildren(childrenOf(node), ctx);
      if (C.li) return <C.li key={key}>{kids}</C.li>;
      return <li key={key} className={$.li ?? $.listItem}>{kids}</li>;
    }

    case "link": {
      const rawUrl = (node as { url?: string }).url ?? "#";
      const href = ctx.getLinkHref ? ctx.getLinkHref(rawUrl) : rawUrl;
      const kids = renderChildren(childrenOf(node), ctx);
      const Comp = C.a ?? C.link;
      if (Comp) {
        // user-provided Link may call `next/link`-style href handling
        return <Comp key={key} href={href} node={node}>{kids}</Comp>;
      }
      return (
        <a key={key} href={href} className={cn("font-medium underline decoration-black/20 underline-offset-4 hover:decoration-black", $.a)}>
          {kids}
        </a>
      );
    }

    case "image": {
      const url = (node as { url?: string }).url ?? "";
      const alt = (node as { alt?: string }).alt as string | undefined;
      const title = (node as { title?: string }).title as string | undefined;
      if (C.img) return <C.img key={key} src={url} alt={alt ?? ""} title={title} />;
      return <img key={key} src={url} alt={alt ?? ""} title={title} className={$.img ?? $.image} />;
    }

    case "blockquote": {
      const kids = renderChildren(childrenOf(node), ctx);
      if (C.blockquote) return <C.blockquote key={key}>{kids}</C.blockquote>;
      return <blockquote key={key} className={$.blockquote}>{kids}</blockquote>;
    }

    case "leafDirective":
    case "containerDirective":
    case "inlineDirective": {
      const name = (node as { name?: string }).name ?? "note";
      const attrs = (node as { attributes?: Record<string, unknown> }).attributes;
      const kids = renderChildren(childrenOf(node), ctx);
      const compKey = t as "leafDirective" | "containerDirective" | "inlineDirective";
      const Override = ctx.components[compKey] as ((p: { name: string; attributes?: Record<string, unknown>; children: ReactNode; node: MdastNode }) => ReactNode) | undefined;
      if (Override) return <Override key={key} name={name} attributes={attrs} node={node} children={kids} />;
      if (C.div) return <C.div key={key} node={node}>{kids}</C.div>;
      // sensible default: render as a bordered callout
      return (
        <aside key={key} data-directive={name} className={cn("mt-6 rounded-2xl border bg-white p-5", ($ as Record<string, string | undefined>)[t])}>
          {kids}
        </aside>
      );
    }

    case "thematicBreak": {
      if (C.hr) return <C.hr key={key} />;
      return <hr key={key} className={$.thematicBreak} />;
    }

    case "break": {
      if (C.br) return <C.br key={key} />;
      return <br key={key} />;
    }

    case "html": {
      // Don't inject raw HTML by default (XSS). Caller can provide `components.div`
      // to opt-in for trusted content, or add `rehype-raw` in their own pipeline.
      const v = nodeText(node) ?? "";
      // Strip single-root wrapper if needed, else render nothing.
      if (!v.trim()) return null;
      return null;
    }

    default: {
      const kids = childrenOf(node);
      if (kids && kids.length > 0) return <span key={key}>{renderChildren(kids, ctx)}</span>;
      const v = nodeText(node);
      if (v != null) return v;
      return null;
    }
  }
}

// ── public component ───────────────────────────────────────────────────────

export function Markdown({ root, components, classNames, getLinkHref, className }: MarkdownProps) {
  const ctx: Ctx = {
    components: components ?? {},
    classNames: classNames ?? {},
    getLinkHref,
  };
  if (!root) return null;
  // `root` may be enhanced with `raw`/`links`/etc — render children regardless.
  const tree = root as MdastNode;
  const t = (tree as { type?: string }).type;
  // allow callers who pass a non-root fallback (legacy `MarkdownNode`)
  const effectiveRoot: MdastNode =
    t === "root" || Array.isArray((tree as { children?: unknown }).children)
      ? tree
      : { type: "root", children: [tree] };

  const content = renderNode(effectiveRoot, 0, ctx);
  if (className) return <div className={className}>{content}</div>;
  return <>{content}</>;
}

/**
 * Factory for a pre-configured Markdown component with shared defaults.
 *
 * @example
 *   const DocMarkdown = createMarkdownComponent({
 *     getLinkHref: (url) => url.endsWith(".md") ? `/docs/${slugify(url)}` : url,
 *     classNames: { h1: "text-4xl font-semibold", p: "mt-5 leading-7" },
 *   })
 *   // ...
 *   <DocMarkdown root={doc.body} />
 */
export function createMarkdownComponent(
  defaults: Partial<Omit<MarkdownProps, "root">>,
): (props: MarkdownProps) => ReactNode {
  return function BoundMarkdown(props: MarkdownProps) {
    return (
      <Markdown
        {...defaults}
        {...props}
        components={{ ...defaults.components, ...props.components }}
        classNames={{ ...defaults.classNames, ...props.classNames }}
        getLinkHref={props.getLinkHref ?? defaults.getLinkHref}
      />
    );
  };
}

// Legacy alias so `import { MarkdownNode }` keeps working during migration.
export type MarkdownNode = MdastNode;
