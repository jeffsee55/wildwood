import { Toolbar } from "wildwood/nextjs/kit";

import { PlaygroundDataError } from "@/components/playground-data-error";
import type { PlaygroundConfig } from "@/lib/playground-config";
import { logAndFormatPlaygroundError } from "@/lib/playground-error";
import { buildPlaygroundWildwood } from "@/lib/wildwood";

export async function PlaygroundToolbarSection({
  config,
  userEmail,
}: {
  config: PlaygroundConfig;
  userEmail: string | null;
}) {
  let wildwood;
  try {
    wildwood = buildPlaygroundWildwood(config);
  } catch (err) {
    const message = logAndFormatPlaygroundError(err, {
      activeRef: config.ref,
      config,
    });
    return <PlaygroundDataError title="Wildwood toolbar error" message={message} />;
  }

  // Single credential set happy path:
  // The GitHub App manifest conversion returns GITHUB_APP_ID, GITHUB_PRIVATE_KEY,
  // GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, GITHUB_APP_SLUG — all from one App.
  // GITHUB_CLIENT_ID/SECRET *are* the App's own OAuth credentials (GitHub Apps ARE OAuth apps).
  // No separate OAuth App needed. Additional providers remain pluggable via oauth.providers.
  const appSlug = process.env.GITHUB_APP_SLUG?.trim();
  const appId = process.env.GITHUB_APP_ID?.trim();
  const privateKey = process.env.GITHUB_PRIVATE_KEY?.trim();
  const clientId = process.env.GITHUB_CLIENT_ID?.trim();
  const clientSecret = process.env.GITHUB_CLIENT_SECRET?.trim();

  const hasSingleAppCreds = !!(appId && privateKey);
  const hasOAuthViaApp = !!(clientId && clientSecret);
  // Legacy detection kept for back-compat verbiage, but now true when either App exists
  // (App doubles as OAuth app) or explicit OAuth env exists (separate OAuth app case).
  const githubOAuthEnabled = hasOAuthViaApp || !!appSlug || hasSingleAppCreds;

  return (
    <Toolbar
      wildwood={wildwood}
      activeRef={config.ref}
      auth={{
        enabled: true,
        authBase: "/api/auth",
        callbackURL: "/",
        userEmail,
        // Back-compat: kept so KitAuthPanel fallback works, but new source of truth is `oauth.providers`.
        githubOAuthEnabled,
        oauth: {
          providers: [
            {
              id: "github",
              name: "GitHub",
              // Single App powers both sign-in and writes.
              viaGitHubApp: hasSingleAppCreds || !!appSlug ? true : undefined,
              enabled: githubOAuthEnabled,
            },
            // Add more providers here (Google, etc) without changing Kit UI:
            // { id: "google", name: "Google", enabled: Boolean(process.env.GOOGLE_CLIENT_ID) },
          ],
        },
        githubApp: {
          appSlug,
          name: "Wildwood Play Dev",
          origin: process.env.NEXT_PUBLIC_PLAY_ORIGIN,
          configured: hasSingleAppCreds ? true : appSlug ? undefined : false,
          // App doubles as OAuth app — no second GitHub OAuth app needed.
          providesOAuth: true,
        },
      }}
    />
  );
}
