// Server-only auth boundary — isolated so Turbopack never merges `better-sqlite3`
// into the same client chunk as `WildwoodJsonView`.

import { PlaygroundControls } from "@/components/playground-controls";
import type { PlaygroundConfig } from "@/lib/playground-config";
import { getPlaygroundGithubAuthState } from "@/lib/auth";
import { playDebug } from "@/lib/playground-log";
import { PlaygroundToolbarSection, jsonFallback } from "./playground-main";
import { Suspense } from "react";

export async function PlaygroundAuthShell({
  initialConfig,
}: {
  initialConfig: PlaygroundConfig;
}) {
  const githubAuth = await getPlaygroundGithubAuthState();
  const config =
    githubAuth.githubSignedIn || initialConfig.source === "local"
      ? initialConfig
      : { ...initialConfig, source: "local" as const };

  playDebug("page.configLoaded", {
    activeRef: config.ref,
    config,
    githubSignedIn: githubAuth.githubSignedIn,
  });

  return (
    <>
      <PlaygroundControls githubSignedIn={githubAuth.githubSignedIn} initial={config} />
      <Suspense fallback={jsonFallback}>
        <PlaygroundToolbarSection config={config} userEmail={githubAuth.email} />
      </Suspense>
    </>
  );
}
