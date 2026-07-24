import { createCMS } from "wildwood/nextjs/route";
import { wildwood, WILDWOOD_CONTENT_TAG } from "@/lib/wildwood";

// Local-only sign-in. GitHub App OAuth creds are too sensitive to keep in a
// local .env, so in development we enable better-auth's email+password provider,
// which backs the library's dev sign-in page (fixed identities, hardcoded
// non-secret password — see the Kit toolbar's "Dev sign-in", served at
// /api/wildwood/device/signin). Never enabled in production — there, GitHub App
// OAuth is the only sign-in path.
const isDev = process.env.NODE_ENV !== "production";

export const { GET, POST, HEAD, OPTIONS, PUT, PATCH, DELETE } = createCMS(wildwood, {
  revalidateTagName: WILDWOOD_CONTENT_TAG,
  auth: {
    secret: process.env.BETTER_AUTH_SECRET,
    github: true,
    providers: isDev ? { emailAndPassword: true } : undefined,
    // In dev the app is served through the portless proxy origin, which better-auth
    // must trust for CSRF-protected endpoints (e.g. device approval). PORTLESS_URL
    // is set by `portless ww`; fall back to the localhost proxy origin.
    baseURL: isDev ? (process.env.PORTLESS_URL ?? "https://ww.localhost") : undefined,
    trustedOrigins: isDev
      ? [process.env.PORTLESS_URL ?? "https://ww.localhost", "https://ww.localhost"]
      : undefined,
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
