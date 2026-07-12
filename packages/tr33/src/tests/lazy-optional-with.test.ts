import { describe, expect, it } from "vitest";
import { createClient as libsqlCreateClient } from "@libsql/client";
import { defineConfig } from "@/client/config";
import { createClient } from "@/client/index";
import { z } from "@/index";
import type { FindTypes } from "@/client/types";

// Mirrors apps/docs – the exact shape that was broken:
//   author: z.lazy(() => z.connect(authors)).optional()
const authors = z.collection({
  name: "authors",
  match: "content/authors/**/*.md",
  schema: z.markdown({
    name: z.filter(z.string()),
    avatar: z.string().optional(),
  }),
});

const docs = z.collection({
  name: "docs",
  match: "content/docs/**/*.md",
  schema: z.markdown({
    title: z.filter(z.string()),
    description: z.string().optional(),
    author: z.lazy(() => z.connect(authors)).optional(),
  }),
});

const nav = z.collection({
  name: "nav",
  match: "content/nav/**/*.json",
  schema: z.json({
    name: z.filter(z.string()),
    label: z.string(),
    children: z.array(z.lazy(() => z.connect(docs))),
  }),
});

describe("lazy/optional connection typing (repro for docs)", () => {
  it("FindTypes extracts author connection through lazy+optional", () => {
    type DocsSchema = typeof docs extends { schema: infer S } ? S : never;
    type Unwrap<T> = T extends { def: { out: infer O } }
      ? O extends import("zod/v4").core.$ZodType
        ? O
        : never
      : T extends { _zod: { def: { out: infer O } } }
        ? O extends import("zod/v4").core.$ZodType
          ? O
          : never
        : T & import("zod/v4").core.$ZodType;
    type FT = FindTypes<Unwrap<DocsSchema> & import("zod/v4").core.$ZodType>;
    type Conn = Extract<FT, { type: "connection"; path: "author" }>;
    // must be connection to "authors", not never
    type Assert = Conn extends { value: "authors" } ? true : false;
    const ok: Assert = true as const;
    expect(ok).toBe(true);
  });

  it("with:{author:true} types as Resolved author, and join where author.name works", async () => {
    const collections = { authors, docs, nav } as const;
    const config = defineConfig({ org: "o", repo: "r", ref: "main", collections });
    const db = libsqlCreateClient({ url: ":memory:" });
    const tr33 = createClient({ config, database: db });

    // -- type-level: should compile, gives author?.name as string|undefined
    async function typeCheck() {
      const res2 = await tr33.docs.findFirst({
        where: { slug: "intro" },
        with: { author: true },
      });
      const n: string | undefined = res2.value.author?.name;
      void n;

      // bad key should be a TS error – we assert via @ts-expect-error comment checked by tsc
      // @ts-expect-error author2 does not exist
      await tr33.docs.findFirst({ with: { author2: true } });

      // join filter: where author.name eq
      const res3 = await tr33.docs.findMany({
        where: { author: { name: { eq: "Jeff" } } },
        with: { author: true },
      });
      const av = res3.items[0]?.author?.avatar;
      const _av: string | undefined = av;
    }
    void typeCheck;

    // runtime smoke – client still works (no db rows, so would throw on query, we just check shape)
    expect(tr33.docs.findFirst).toBeDefined();
    expect(tr33.docs.findMany).toBeDefined();
  });

  it("nested with through nav.children (array of lazy connect)", async () => {
    const collections = { authors, docs, nav } as const;
    const config = defineConfig({ org: "o", repo: "r", ref: "main", collections });
    const db = libsqlCreateClient({ url: ":memory:" });
    const tr33 = createClient({ config, database: db });

    async function typeCheck() {
      const res = await tr33.nav.findFirst({
        with: {
          children: { with: { author: true } },
        },
      });
      const first = res.value.children?.[0];
      const name: string | undefined = first?.author?.name;
      void name;
    }
    void typeCheck;
    expect(tr33.nav.findFirst).toBeDefined();
  });
});
