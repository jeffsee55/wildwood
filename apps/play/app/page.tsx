import { cookies } from "next/headers";
import { Suspense } from "react";
import { Toolbar } from "tr33/nextjs";
import { Tr33JsonView } from "tr33/react";

import { PlaygroundControls } from "@/components/playground-controls";
import { PlaygroundDataError } from "@/components/playground-data-error";
import {
  type PlaygroundConfig,
  parsePlaygroundConfig,
} from "@/lib/playground-config";
import { getPlaygroundGithubAuthState } from "@/lib/auth";
import { logAndFormatPlaygroundError } from "@/lib/playground-error";
import { getPlaygroundViewData } from "@/lib/playground-data";
import { playDebug } from "@/lib/playground-log";
import { buildPlaygroundTr33 } from "@/lib/tr33";

const jsonFallback = (
  <div className="w-full min-h-[200px] rounded-md border border-zinc-200 bg-zinc-100/80 dark:border-zinc-800 dark:bg-zinc-900/50" />
);

const pageFallback = (
  <div className="flex flex-1 w-full max-w-3xl flex-col gap-8 py-16 px-8">
    <div className="h-64 w-full animate-pulse rounded-lg bg-zinc-200/80 dark:bg-zinc-800/80" />
    {jsonFallback}
    <div className="h-12 w-12 shrink-0 animate-pulse rounded-full bg-zinc-200/80 dark:bg-zinc-800/80" />
  </div>
);

async function PlaygroundJsonSection(props: {
  config: PlaygroundConfig;
}) {
  let viewData: object;
  try {
    viewData = await getPlaygroundViewData(props.config.ref, props.config);
  } catch (err) {
    const message = logAndFormatPlaygroundError(err, {
      activeRef: props.config.ref,
      config: props.config,
    });
    return <PlaygroundDataError message={message} />;
  }
  return <Tr33JsonView value={viewData} />;
}

/**
 * All `cookies()` access lives here so the default page export stays non-blocking for Next’s route shell.
 */
async function PlaygroundMain() {
  const [cookieStore, githubAuth] = await Promise.all([
    cookies(),
    getPlaygroundGithubAuthState(),
  ]);
  const parsedConfig = parsePlaygroundConfig(cookieStore);
  const playgroundConfig =
    githubAuth.githubSignedIn || parsedConfig.source === "local"
      ? parsedConfig
      : { ...parsedConfig, source: "local" as const };
  playDebug("page.configLoaded", {
    activeRef: playgroundConfig.ref,
    config: playgroundConfig,
    githubSignedIn: githubAuth.githubSignedIn,
  });

  return (
    <main className="flex flex-1 w-full max-w-3xl flex-col items-center justify-between gap-8 py-16 px-8 bg-white dark:bg-black sm:items-start">
      <PlaygroundControls
        githubSignedIn={githubAuth.githubSignedIn}
        initial={playgroundConfig}
      />
      <Suspense fallback={jsonFallback}>
        <PlaygroundJsonSection config={playgroundConfig} />
      </Suspense>
      <Suspense fallback={jsonFallback}>
        <PlaygroundToolbar
          config={playgroundConfig}
          userEmail={githubAuth.email}
        />
      </Suspense>
    </main>
  );
}

async function PlaygroundToolbar({
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

export default function Home() {
  return (
    <div className="flex flex-col flex-1 items-center justify-center bg-zinc-50 font-sans dark:bg-black">
      <Suspense fallback={pageFallback}>
        <PlaygroundMain />
      </Suspense>
    </div>
  );
}
