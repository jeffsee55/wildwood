import { createClient } from "@libsql/client";
import { z } from "zod";
import { collection, createContent, libsql, markdown } from "../dist/index.mjs";

const database = createClient({ url: ":memory:" });
try {
  const content = createContent({
    repository: "demo",
    version: "1",
    database: libsql(database),
    collections: {
      pages: collection({
        match: "content/*.md",
        parse: markdown(z.object({ title: z.string(), body: z.string() })),
        filters: ["title"],
      }),
    },
  });
  await content.branch("main");
  const original = await content.apply({
    ref: "main",
    expectedRevision: 0,
    idempotencyKey: "initial-content",
    changes: [{ path: "content/hello.md", content: "---\ntitle: Hello\n---\nFrom main." }],
  });
  const draft = await content.branch("draft", { ref: "main" });
  await content.apply({
    ref: "draft",
    expectedRevision: draft.revision,
    idempotencyKey: "edit-title",
    changes: [{ path: "content/hello.md", content: "---\ntitle: Bonjour\n---\nFrom draft." }],
  });
  console.log({
    main: (await content.query("pages", { ref: "main" })).items[0].value.title,
    draft: (await content.query("pages", { ref: "draft" })).items[0].value.title,
    pinned: (await content.query("pages", { snapshot: original.snapshot })).items[0].value.title,
  });
} finally {
  database.close();
}
