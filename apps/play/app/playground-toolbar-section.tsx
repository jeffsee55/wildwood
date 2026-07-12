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
  return (
    <Toolbar
      wildwood={wildwood}
      activeRef={config.ref}
      auth={{
        enabled: true,
        authBase: "/api/auth",
        callbackURL: "/",
        userEmail,
        githubOAuthEnabled: Boolean(
          process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET,
        ),
        githubApp: {
          appSlug: process.env.GITHUB_APP_SLUG,
          name: "Wildwood Play Dev",
          origin: process.env.NEXT_PUBLIC_PLAY_ORIGIN,
        },
      }}
    />
  );
}
