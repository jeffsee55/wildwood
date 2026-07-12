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

// ---- connection plumbing --------------------------------------------------
// We keep the runtime `z.custom` marker but make the TS return type preserve
// the target collection's schema shape without touching `_zod.def.shape`
// (which widens to `LooseShape` in emitted `.d.mts`). Instead we infer the
// object shape via `CollectionParams["schema"] extends ZodCodec<..., ZodObject<infer S>>`
// which is stable through `const` generics.

type InferObjectShapeFromCodec<C> = C extends z.ZodCodec<z.ZodString, z.ZodObject<infer S extends z.core.$ZodLooseShape>>
  ? S
  : C extends z.ZodObject<infer S extends z.core.$ZodLooseShape>
    ? S
    : z.core.$ZodLooseShape;

export const connect = <
  C extends CollectionParams,
  const RA extends string | undefined = undefined,
>(
  collection: C,
  options?: { referencedAs?: RA },
) => {
  return z.custom(
    () => {
      return true;
    },
    {
      params: {
        __wildwoodConnection: collection.name,
        __tr33Connection: collection.name, // legacy compat
        referencedAs: options?.referencedAs,
      },
    },
  ) as unknown as z.ZodCustom<
    UnresolvedConnectionOutput<C["name"], RA>,
    z.ZodObject<
      InferObjectShapeFromCodec<C["schema"]> &
        ResolvedConnectionMetaSchema<C["name"]> &
        (RA extends string ? { _referencedAs: z.ZodLiteral<RA> } : {})
    >
  >;
};

type UnresolvedConnectionOutput<
  Name extends string,
  RA extends string | undefined,
> = {
  _collection: Name;
  _meta: { resolved: false; value: string };
} & (RA extends string ? { _referencedAs: RA } : {});

export type MetaSchema<CollectionName extends string> = {
  _collection: z.ZodLiteral<CollectionName>;
  _meta: z.ZodObject<{
    raw: z.ZodString;
    oid: z.ZodString;
    path: z.ZodString;
    canonicalPath: z.ZodString;
    slug: z.ZodString;
  }>;
  slug: z.ZodString;
  path: z.ZodString;
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

/**
 * `collection` now preserves the exact `Schema` generic passed in instead of
 * re-building it via `T["_zod"]["def"]["shape"]`. That previous trick caused
 * the emitted declaration to become `ZodObject<$ZodLooseShape>` and made
 * `FindTypes` return `never`, which is why `with:{author:true}` and the join
 * `where:{author:{name:{eq}}}` didn't type-check in `apps/docs` (which consumes
 * `tr33` via its built `dist/index.d.mts`).
 *
 * We still augment the output with `_collection`/`_meta`/`slug`/`path` – but
 * that augmentation now lives in `OrmConfig`'s `EntrySystemFields` rather than
 * requiring the collection schema itself to carry it, so the literal frontmatter
 * shape stays intact.
 */
export const collection = <
  const Name extends string,
  const Schema extends z.core.$ZodType,
>(args: {
  name: Name;
  match: string;
  basePath?: string;
  schema: Schema;
}): {
  name: Name;
  match: string;
  basePath?: string;
  schema: Schema;
} => {
  return args as unknown as {
    name: Name;
    match: string;
    basePath?: string;
    schema: Schema;
  };
};

export const filter = <T extends z.ZodType>(type: T) => {
  return type.pipe(
    z.custom((val) => val, { params: { __wildwoodFilter: true, __tr33Filter: true } }),
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
  T extends z.core.$ZodType = z.core.$ZodType,
  Name extends string = string,
> = {
  name: Name;
  schema: T;
  match: string;
  basePath?: string;
};
