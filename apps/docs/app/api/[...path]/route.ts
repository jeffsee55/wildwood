import { createWildwoodRoute } from "wildwood/nextjs/route";
import { wildwood } from "@/lib/wildwood";

export const { GET, POST, HEAD, OPTIONS, PUT, PATCH, DELETE } = createWildwoodRoute(
  () => wildwood,
  {
    revalidateTagName: "docs-content",
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

      authorize: async ({ user, action }) => {
        if (action.type === "content.update" || action.type === "content.delete") return true;
        if (action.type === "git.commit" && action.ref === "main") return !!user;
        return true;
      },
    },
  },
);
