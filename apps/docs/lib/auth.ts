import { createWildwoodPlayAuth } from "wildwood/nextjs/play-auth";

function playgroundDatabaseUrl(): string {
  return (
    process.env.WILDWOOD_DOCS_DATABASE_URL?.trim() ||
    process.env.TURSO_DATABASE_URL?.trim() ||
    process.env.BETTER_AUTH_DATABASE_URL?.trim() ||
    process.env.LIBSQL_URL?.trim() ||
    "file:./wildwood-docs.db"
  );
}

const docsAuth = createWildwoodPlayAuth({
  appName: "Wildwood Docs",
  databaseUrl: playgroundDatabaseUrl,
  // Re-use the single GitHub App credential set for sign-in.
  // createWildwoodPlayAuth reads GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET,
  // which the GitHub App manifest flow already provides (App IS its own OAuth app).
});

export const auth = docsAuth.auth;
export const ensureDocsAuthSchema = docsAuth.ensureAuthSchema;
export const getDocsAuthState = docsAuth.getAuthState;
export const isDocsSessionAllowed = docsAuth.isSessionAllowed;
export const requireDocsApiSession = docsAuth.requireApiSession;
