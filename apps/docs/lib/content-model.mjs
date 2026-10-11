import { collection, markdown } from "wildwood-core";
import { z } from "zod";

const base = z.object({
  title: z.string().min(1),
  description: z.string(),
  order: z.number(),
  author: z.string(),
  body: z.string(),
});
/** @param {"1" | "2"} version */
export function contentModel(version) {
  return {
    repository: "wildwood-manual",
    version: `docs-${version}`,
    variants: {
      locale: { options: ["en", "fr"], default: "en", path: /** @type {"suffix"} */ ("suffix") },
    },
    collections: {
      docs: collection({
        match: "content/pages/**/*.md",
        parse: markdown(
          base.extend({
            audience: version === "2" ? z.string().default("Developers") : z.string().optional(),
          }),
        ),
        filters: ["title", "order", "audience"],
        references: { author: "authors" },
      }),
      authors: collection({
        match: "content/authors/**/*.md",
        parse: markdown(z.object({ name: z.string(), body: z.string() })),
        filters: ["name"],
      }),
    },
  };
}
