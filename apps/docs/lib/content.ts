import { createClient } from "@libsql/client";
import { collection, createContent, libsql, markdown, ConflictError } from "wildwood-core";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import seed from "./content.generated.json";

const configuredDatabase =
  process.env.WILDWOOD_DOCS_DATABASE_URL ||
  (process.env.VERCEL ? process.env.TURSO_DATABASE_URL : undefined);
// Unconfigured PR previews use only repository seed content. They cannot sign in,
// persist edits, or reach the production database. Production always needs durability.
export const previewOnly = process.env.VERCEL_ENV === "preview" && !configuredDatabase;
const databaseUrl = configuredDatabase || (previewOnly ? ":memory:" : "file:./wildwood-docs-v2.db");
if (
  process.env.VERCEL &&
  !previewOnly &&
  (databaseUrl.startsWith("file:") || databaseUrl === ":memory:")
)
  throw new Error(
    "Vercel requires WILDWOOD_DOCS_DATABASE_URL (or TURSO_DATABASE_URL) pointing to a persistent remote database",
  );
export const client = createClient({
  url: databaseUrl,
  authToken:
    process.env.WILDWOOD_DOCS_DATABASE_TOKEN ||
    (process.env.VERCEL ? process.env.TURSO_AUTH_TOKEN : undefined),
});
export const database = libsql(client);
const base = z.object({
  title: z.string().min(1),
  description: z.string(),
  order: z.number(),
  author: z.string(),
  body: z.string(),
});
function engine(version: "1" | "2") {
  return createContent({
    repository: "wildwood-manual",
    version: `docs-${version}`,
    database,
    variants: { locale: { options: ["en", "fr"], default: "en", path: "suffix" } },
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
  });
}
export const engines = { "1": engine("1"), "2": engine("2") };
let initialized: Promise<void> | undefined;
export function ready() {
  return (initialized ??= (async () => {
    await engines["2"].ready();
    await database.execute(
      "CREATE TABLE IF NOT EXISTS ww2_docs_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    await database.execute("INSERT OR IGNORE INTO ww2_docs_settings(key,value) VALUES (?,?)", [
      "secret",
      randomBytes(32).toString("hex"),
    ]);
    // Only bootstrap a missing ref. Restarting never overwrites a user's edits.
    try {
      await engines["2"].ref("main");
    } catch {
      try {
        await engines["2"].branch("main");
      } catch {
        /* Another worker may have created it. */
      }
    }
    const ref = await engines["2"].ref("main");
    if (!(await engines["2"].files(ref.snapshot)).length) {
      try {
        await engines["2"].apply({
          ref: "main",
          expectedRevision: ref.revision,
          idempotencyKey: "manual-bootstrap-v1",
          changes: seed,
        });
      } catch (error) {
        if (!(await engines["2"].files((await engines["2"].ref("main")).snapshot)).length)
          throw error;
      }
    }
    // Explicit additive content migration for customer zero. Never replace an
    // existing document, and retry against a new head when another worker wins.
    const migration = "manual-agent-guides-v1";
    if (
      !(await database.execute("SELECT key FROM ww2_docs_settings WHERE key=?", [migration])).rows
        .length
    ) {
      for (let attempt = 0; attempt < 4; attempt++) {
        const head = await engines["2"].ref("main");
        const paths = new Set((await engines["2"].files(head.snapshot)).map((f) => f.path));
        const additions = seed.filter(
          (f) =>
            ["content/pages/agents.md", "content/pages/publishing.md"].includes(f.path) &&
            !paths.has(f.path),
        );
        try {
          if (additions.length)
            await engines["2"].apply({
              ref: "main",
              expectedRevision: head.revision,
              idempotencyKey: `${migration}:${head.revision}`,
              changes: additions,
              audit: { actor: "wildwood", source: "manual-migration" },
            });
          await database.execute(
            "INSERT OR IGNORE INTO ww2_docs_settings(key,value) VALUES (?,?)",
            [migration, "complete"],
          );
          break;
        } catch (error) {
          if (!(error instanceof ConflictError) || attempt === 3) throw error;
        }
      }
    }
  })().catch((error) => {
    initialized = undefined;
    throw error;
  }));
}
