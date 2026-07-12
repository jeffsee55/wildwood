import { createClient as libsqlCreateClient } from "@libsql/client";
import type { ConfigInput } from "@/client/config";
import { defineConfig } from "@/client/config";
import { createClient } from "@/client/index";
import { z } from "@/index";
import { GitTestHelper } from "@/tests/_git-test-helper";
import { url } from "../../drizzle.sqlite.js";

const authors = z.collection({
  name: "authors",
  match: "content/authors/**/*.json",
  schema: z.json({
    name: z.filter(z.string()),
  }),
});

const docs = z.collection({
  name: "docs",
  match: "content/docs/**/*.md",
  schema: z.markdown({
    title: z.filter(z.string()),
    author: z.connect(authors, { referencedAs: "docsAuthored" }),
  }),
});

export function createTestSetup({ useMemoryDb = true }: { useMemoryDb?: boolean }) {
  const libsqlClient = libsqlCreateClient({
    url: useMemoryDb ? ":memory:" : url,
  });
  const helper = new GitTestHelper();
  const config = defineConfig({
    org: "jeffsee55",
    repo: "tr33-mono",
    ref: "main",
    localPath: helper.getFullPath(),
    collections: { docs, authors },
  });
  const client = createClient({ config, database: libsqlClient });

  return {
    helper,
    config,
    client,
    git: client._.git,
    db: client._.db,
    createClientWithConfig: (config: ConfigInput) =>
      createClient({
        config: defineConfig(config),
        database: libsqlClient,
      }) as unknown as typeof client,
  };
}
