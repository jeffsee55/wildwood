/** Trusted maintenance: run outside the request path; never prints credentials. */
import { createClient } from "@libsql/client";
import { createContent, libsql } from "wildwood-core";
import { compactGitStorage } from "wildwood-core/git";
const url = process.env.WILDWOOD_DOCS_DATABASE_URL || process.env.TURSO_DATABASE_URL;
if (!url) throw new Error("Set WILDWOOD_DOCS_DATABASE_URL before running maintenance");
const client = createClient({
  url,
  authToken: process.env.WILDWOOD_DOCS_DATABASE_TOKEN || process.env.TURSO_AUTH_TOKEN,
});
try {
  const engine = createContent({
    database: libsql(client),
    repository: "wildwood-manual",
    version: "storage-maintenance-1",
    collections: {},
  });
  console.log(JSON.stringify(await compactGitStorage(engine), null, 2));
} finally {
  client.close();
}
