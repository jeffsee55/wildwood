import { createWildwoodRoute } from "wildwood/nextjs/route";
import { getPlaygroundWildwood } from "@/lib/wildwood";
import { cookiesFromCookieHeader } from "wildwood/nextjs/branch";

/**
 * Single route for play — request-aware because org/repo comes from config cookie.
 *
 * New API:
 * - DB is NOT configured here — auth reuses the DB from `getPlaygroundWildwood()` / wildwood client.
 * - `github: true` enables OAuth via same App; creds from GITHUB_CLIENT_ID/SECRET (same App as git).
 * - `baseURL`/`trustedOrigins` omitted → autodetected from Request.
 * - No WILDWOOD_GITHUB_* / TURSO_* fallbacks here — host maps in lib/wildwood.ts only.
 */
export const { GET, POST, HEAD, OPTIONS, PUT, PATCH, DELETE } = createWildwoodRoute(
  (req?: Request) => {
    const cookieHeader = req?.headers.get("cookie") ?? null;
    return getPlaygroundWildwood(cookiesFromCookieHeader(cookieHeader));
  },
  {
    requestAware: true,
    auth: {
      secret: process.env.BETTER_AUTH_SECRET,
      github: true,

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
    },
  },
);
