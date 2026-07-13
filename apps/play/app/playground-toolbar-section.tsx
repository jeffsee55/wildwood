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

  const trimEnv = (k: string) => {
    const v = process.env[k];
    if (typeof v !== "string") return undefined;
    const t = v.trim();
    return t ? t : undefined;
  };

  const appSlug = trimEnv("GITHUB_APP_SLUG");
  const appId = trimEnv("GITHUB_APP_ID");
  const privateKey = trimEnv("GITHUB_PRIVATE_KEY");
  const clientId = trimEnv("GITHUB_CLIENT_ID");
  const clientSecret = trimEnv("GITHUB_CLIENT_SECRET");

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
          appSlug: appSlug ?? undefined,
          name: "Wildwood Play Dev",
          origin: trimEnv("NEXT_PUBLIC_PLAY_ORIGIN"),
          configured: hasSingleAppCreds ? true : appSlug ? undefined : false,
          providesOAuth: true,
        } as never,
      }}
    />
  );
}
