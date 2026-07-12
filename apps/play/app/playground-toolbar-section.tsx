import { Toolbar } from "tr33/nextjs/kit";

import { PlaygroundDataError } from "@/components/playground-data-error";
import type { PlaygroundConfig } from "@/lib/playground-config";
import { logAndFormatPlaygroundError } from "@/lib/playground-error";
import { buildPlaygroundTr33 } from "@/lib/tr33";

export async function PlaygroundToolbarSection({
  config,
  userEmail,
}: {
  config: PlaygroundConfig;
  userEmail: string | null;
}) {
  let tr33;
  try {
    tr33 = buildPlaygroundTr33(config);
  } catch (err) {
    const message = logAndFormatPlaygroundError(err, {
      activeRef: config.ref,
      config,
    });
    return <PlaygroundDataError title="Tr33 toolbar error" message={message} />;
  }
  return (
    <Toolbar
      tr33={tr33}
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
          name: "Tr33 Play Dev",
          origin: process.env.NEXT_PUBLIC_PLAY_ORIGIN,
        },
      }}
    />
  );
}
