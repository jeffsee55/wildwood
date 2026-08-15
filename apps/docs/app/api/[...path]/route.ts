import { createCMS } from "wildwood/nextjs/route";
import { wildwood, WILDWOOD_CONTENT_TAG } from "@/lib/wildwood";

// Local development keeps the fixed Better Auth identities exposed by the dev
// sign-in page. Production reuses the GitHub credentials already present on the
// Wildwood client; auth itself has no environment-variable configuration.
const isDev = process.env.NODE_ENV !== "production";

export const { GET, POST, HEAD, OPTIONS, PUT, PATCH, DELETE } = createCMS(wildwood, {
  revalidateTagName: WILDWOOD_CONTENT_TAG,
  dangerouslyAllowDatabaseReset: true,
  auth: {
    bootstrap: { owner: "jeffsee.55@gmail.com" },
    providers: isDev ? { emailAndPassword: true } : undefined,
  },
});
