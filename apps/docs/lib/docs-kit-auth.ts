import type { KitAuthConfig } from "@tr33/kit";

/** Kit toolbar + editor install prompts for the docs GitHub App. */
export function getDocsKitAuth(): KitAuthConfig | undefined {
  if (!process.env.GITHUB_APP_ID?.trim()) {
    return undefined;
  }
  return {
    githubApp: {
      appSlug: process.env.GITHUB_APP_SLUG?.trim(),
      name: "Tr33 Docs",
    },
  };
}
