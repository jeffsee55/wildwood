/** Prepare deployed schema generations before they serve interactive requests. */
import { createClient } from "@libsql/client";
import { createContent, libsql } from "wildwood-core";
import { contentModel } from "../lib/content-model.mjs";

if (process.env.VERCEL_ENV === "production" || process.env.WILDWOOD_PREPARE_CONTENT === "1") {
  const url = process.env.WILDWOOD_DOCS_DATABASE_URL || process.env.TURSO_DATABASE_URL;
  if (!url || url.startsWith("file:") || url === ":memory:")
    throw new Error("Content preparation requires the production database");
  const client = createClient({
    url,
    authToken: process.env.WILDWOOD_DOCS_DATABASE_TOKEN || process.env.TURSO_AUTH_TOKEN,
  });
  try {
    const database = libsql(client);
    for (const version of ["1", "2"]) {
      const engine = createContent({ ...contentModel(version), database });
      await engine.ready();
      const refs = await database.execute(
        "SELECT snapshot FROM ww2_refs WHERE repository=? AND name='main'",
        [engine.config.repository],
      );
      if (!refs.rows.length) break; // A new installation bootstraps content at runtime.
      const snapshot = String(refs.rows[0].snapshot);
      await engine.prepare(snapshot);
      await engine.checkpoint(snapshot);
      console.log(`Prepared ${engine.config.version} for the published snapshot.`);
    }
  } finally {
    client.close();
  }
}
