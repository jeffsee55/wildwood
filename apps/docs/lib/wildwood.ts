import { cache } from "react";
import { unstable_cache } from "next/cache";
import { cookies, headers } from "next/headers";
import { withSourcemap } from "wildwood-web/sourcemap";
import { getWeb } from "./cms";
import { engines } from "./content";
export { engines } from "./content";
export const getContext = cache(async () => {
  const jar = await cookies(),
    web = await getWeb();
  const current = await web.view(await headers(), {
    version: "2",
    variant: { locale: jar.get("ww-locale")?.value === "fr" ? "fr" : "en" },
  });
  return {
    ...current,
    version: current.version as "1" | "2",
    locale: current.variant.locale ?? "en",
    preview: current.mode !== "published",
    pinned: current.mode === "pinned" || current.mode === "shared",
  };
});
export const readDocs = cache(
  unstable_cache(
    async (snapshot: string, version: "1" | "2", locale: string) => {
      const cms = engines[version];
      const { items } = await cms.query("docs", {
        snapshot,
        variant: { locale },
        orderBy: { field: "order" },
        limit: 100,
      });
      const authors = await cms.resolveReferences(items, "author");
      return items.map((doc, index) => {
        const author = authors[index];
        return {
          ...withSourcemap(cms.config.repository, doc),
          author: author
            ? withSourcemap(cms.config.repository, {
                ...author,
                value: author.value as { name: string },
              })
            : null,
        };
      });
    },
    ["immutable-manual-mapped-v1"],
    { revalidate: false },
  ),
);
export function slugOf(path: string) {
  return path.replace("content/pages/", "").replace(/\.md$/, "");
}
