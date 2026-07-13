import { createWildwoodRoute } from "wildwood/nextjs/route";
import { wildwood } from "@/lib/wildwood";

/**
 * Single route owns everything:
 * - /api/wildwood/*  (git, github, vscode)
 * - /api/wildwood/draft + /api/wildwood/preview
 * - /api/auth/* + /api/wildwood/auth/*  (better-auth, lazy-loaded, reuses DB)
 *
 * New API:
 * - DB is NOT configured here — auth reuses `wildwood` client's Turso DB.
 * - `github: true` enables GitHub OAuth, reusing the same App's GITHUB_CLIENT_ID/SECRET.
 * - `baseURL`/`trustedOrigins` omitted → autodetected from Request.
 * - No WILDWOOD_GITHUB_* fallbacks — host maps env to wildwood in lib/wildwood.ts only.
 */
export const { GET, POST, HEAD, OPTIONS, PUT, PATCH, DELETE } = createWildwoodRoute(() => wildwood, {
  revalidateTagName: "docs-content",
  auth: {
    secret: process.env.BETTER_AUTH_SECRET,
    // DB omitted — comes from wildwood client (Turso integration in lib/wildwood.ts)
    // baseURL omitted → autodetected from Request (x-forwarded-host/proto + origin)
    // trustedOrigins omitted → derived origin. Map in userland if cross-domain:
    // trustedOrigins: async (req) => [new URL(req!.url).origin, "https://studio.myapp.com"],

    // true = enable GitHub OAuth via same App creds that provide git writes.
    // Only pass { clientId, clientSecret } if sign-in creds differ.
    github: true,

    // Who may sign in / sign up at all — replaces allowedEmails array.
    authenticate: async ({ user }) => {
      const raw = process.env.ALLOWED_EMAILS ?? "";
      const allow = raw
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      if (allow.length === 0) {
        if (process.env.NODE_ENV === "production") return false;
        return !!user.email;
      }
      return allow.includes(user.email?.toLowerCase() ?? "");
    },

    authorize: async ({ user, action }) => {
      if (action.type === "content.update" || action.type === "content.delete") return true;
      if (action.type === "git.commit" && action.ref === "main") return !!user;
      return true;
    },
  },
});
