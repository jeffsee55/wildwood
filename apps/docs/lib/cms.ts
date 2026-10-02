import { join } from "node:path";
import { createWeb } from "wildwood-web";
import { client, database, engines, ready, previewOnly } from "./content";
let instance:
  | Promise<ReturnType<typeof createWeb<(typeof engines)["2"]["config"]["collections"]>>>
  | undefined;
export function getWeb() {
  return (instance ??= (async () => {
    if (process.env.VERCEL)
      process.env.WILDWOOD_GIT_EXECUTABLE = join(process.cwd(), ".git-runtime", "git");
    await ready();
    const origin =
      process.env.WILDWOOD_DOCS_ORIGIN ??
      (process.env.VERCEL_ENV === "production" && process.env.VERCEL_PROJECT_PRODUCTION_URL
        ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
        : process.env.VERCEL_URL
          ? `https://${process.env.VERCEL_URL}`
          : "http://localhost:3000");
    const clientId = process.env.WILDWOOD_DOCS_GITHUB_CLIENT_ID || process.env.GITHUB_CLIENT_ID;
    const clientSecret =
      process.env.WILDWOOD_DOCS_GITHUB_CLIENT_SECRET || process.env.GITHUB_CLIENT_SECRET;
    const github = clientId && clientSecret ? { clientId, clientSecret } : undefined;
    let identity;
    if (!previewOnly) {
      const { createIdentity } = await import("wildwood-web/auth");
      const result = await database.execute(
        "SELECT value FROM ww2_docs_settings WHERE key='secret'",
      );
      identity = createIdentity({
        client,
        origin,
        secret: String(result.rows[0].value),
        github,
        development: process.env.NODE_ENV === "development",
      });
    }
    return createWeb({
      database,
      engines,
      version: "2",
      ref: "main",
      origin,
      variant: { locale: "en" },
      development: process.env.NODE_ENV === "development",
      identity,
      ownerEmail: process.env.WILDWOOD_DOCS_OWNER_EMAIL,
      documentUrl: (path) =>
        path.startsWith("content/pages/")
          ? `/docs/${path.slice("content/pages/".length).replace(/(?:\.fr)?\.md$/, "")}`
          : undefined,
    });
  })().catch((error) => {
    instance = undefined;
    throw error;
  }));
}
