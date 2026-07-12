import yaml from "js-yaml";
import type { Root } from "mdast";
import type { Position } from "unist";
import { visit } from "unist-util-visit";
import z from "zod/v4";
import { fromMarkdown, toMarkdown } from "@/zod/markdown";

export const registry = z.registry<{ description: string }>();

export const variant = <T extends z.ZodType>(schema: T) => {
  const union = z.union([z.record(z.string(), schema), schema]);
  registry.add(union, { description: "variant" });
  return union;
};

export const connect = <C extends CollectionParams>(
  collection: C,
  options?: { referencedAs?: string },
) => {
  return z.custom(
    () => {
      return true;
    },
    {
      params: {
        __tr33Connection: collection.name,
        referencedAs: options?.referencedAs,
      },
    },
  ) as unknown as z.ZodCustom<
    z.infer<z.ZodObject<UnresolvedConnectionMetaSchema<C["name"]>>>,
    z.ZodObject<
      C["schema"]["_zod"]["def"]["out"]["_zod"]["def"]["shape"] &
        ResolvedConnectionMetaSchema<C["name"]>
    >
  >;
};

type MetaSchema<CollectionName extends string> = {
  _collection: z.ZodLiteral<CollectionName>;
  _meta: z.ZodObject<{
    raw: z.ZodString;
    oid: z.ZodString;
    path: z.ZodString;
    canonicalPath: z.ZodString;
    slug: z.ZodString;
  }>;
  // First-class slug/path: `content/docs/path-to-file.md` → slug=`path-to-file`
  slug: z.ZodString;
  path: z.ZodString;
};

type UnresolvedConnectionMetaSchema<CollectionName extends string> = {
  _collection: z.ZodLiteral<CollectionName>;
  _meta: z.ZodObject<{
    resolved: z.ZodLiteral<false>;
    value: z.ZodString;
  }>;
};

type ResolvedConnectionMetaSchema<CollectionName extends string> = {
  _collection: z.ZodLiteral<CollectionName>;
  _meta: z.ZodObject<{
    resolved: z.ZodLiteral<true>;
    value: z.ZodString;
    raw: z.ZodString;
    oid: z.ZodString;
    path: z.ZodString;
    canonicalPath: z.ZodString;
    slug: z.ZodString;
  }>;
  slug: z.ZodString;
  path: z.ZodString;
};

export const collection = <T extends z.ZodObject, const Name extends string>(
  args: CollectionParams<z.ZodCodec<z.ZodString, T>, Name>,
) => {
  return args as unknown as CollectionParams<
    z.ZodCodec<
      z.ZodString,
      z.ZodObject<T["_zod"]["def"]["shape"] & MetaSchema<Name>>
    >,
    Name
  >;
};

export const filter = <T extends z.ZodType>(type: T) => {
  return type.pipe(
    z.custom((val) => val, { params: { __tr33Filter: true } }),
  ) as unknown as z.ZodCustom<T["_output"], { __internalFilter: T["_output"] }>;
};

export const json = <T extends z.core.$ZodLooseShape>(schema: T) => {
  return z.codec(z.string(), z.object(schema), {
    decode(value, _payload) {
      return JSON.parse(value) as z.infer<typeof schema>;
    },
    encode(value, _payload) {
      return JSON.stringify(value) as string;
    },
  });
};

export const markdown = <
  T extends z.core.$ZodLooseShape = {
    links: z.core.$ZodType;
    leafDirectives: Record<string, z.core.$ZodObject>;
  },
>(
  shape?: T,
) => {
  // Extract links and leafDirectives from shape as they're metadata, not schema fields
  const {
    links: _links,
    leafDirectives: _leafDirectives,
    ...schemaShape
  } = shape || ({} as T);

  return z.codec(
    z.string(),
    z.object({
      ...(schemaShape as Omit<T, "links" | "leafDirectives">),
      body: z.custom<Root>(),
    }),
    {
      // @ts-expect-error - decode return type includes dynamic frontmatter fields
      decode(value, _payload) {
        const tree = fromMarkdown(value);
        const links: { url: string; position?: Position }[] = [];
        const leafDirectives: { name: string; [key: string]: unknown }[] = [];

        const firstChild = tree.children.at(0);
        let ast = tree;
        let frontmatter: Record<string, unknown> = {};
        if (firstChild?.type === "yaml") {
          frontmatter = z
            .record(z.string(), z.any())
            .parse(yaml.load(firstChild.value)) as T;

          ast = { ...tree, children: tree.children.slice(1) };
          ast.raw = toMarkdown({ _body: ast });
        } else {
          ast.raw = value;
        }

        visit(ast, "leafDirective", (_node) => {
          // const _directive = _leafDirectives?.[node.name];
        });
        visit(ast, "link", (node) => {
          if (_links) {
            links.push({ url: node.url, position: node.position });
          }
        });

        // Add links and leafDirectives to the AST object itself
        ast.links = links;
        ast.leafDirectives = leafDirectives;

        return {
          ...frontmatter,
          body: ast,
        };
      },
      encode() {
        return "";
      },
    },
  );
};

export type CollectionParams<
  T extends z.ZodCodec<z.ZodString, z.ZodObject> = z.ZodCodec<
    z.ZodString,
    z.ZodObject
  >,
  Name extends string = string,
> = {
  name: Name;
  schema: T;
  match: string;
  /** Optional base path for slug derivation. Defaults to fixed prefix of `match`. */
  basePath?: string;
};
