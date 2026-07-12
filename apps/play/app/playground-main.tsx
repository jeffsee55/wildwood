import { cookies } from "next/headers";
import { Suspense } from "react";

import {
  type PlaygroundConfig,
  parsePlaygroundConfig,
} from "@/lib/playground-config";

import { PlaygroundAuthShell } from "./playground-auth-shell";
import { PlaygroundJsonSection } from "./playground-json-section";
import { PlaygroundToolbarSection } from "./playground-toolbar-section";

const jsonFallback = (
  <div className="w-full min-h-[200px] rounded-md border border-zinc-200 bg-zinc-100/80 dark:border-zinc-800 dark:bg-zinc-900/50" />
);

// Config is parsed from cookies (pure, no Node deps) so this module never
// imports `better-sqlite3`. Auth (which does need Node/native) lives in
// `PlaygroundAuthShell`, which is a separate server boundary.
export async function PlaygroundMain() {
  const cookieStore = await cookies();
  const parsedConfig = parsePlaygroundConfig(cookieStore);

  return (
    <main className="flex flex-1 w-full max-w-3xl flex-col items-center justify-between gap-8 py-16 px-8 bg-white dark:bg-black sm:items-start">
      <Suspense fallback={jsonFallback}>
        <PlaygroundJsonSection config={parsedConfig} />
      </Suspense>
      <Suspense fallback={jsonFallback}>
        <PlaygroundAuthShell initialConfig={parsedConfig} />
      </Suspense>
    </main>
  );
}

// Separate exports still used by auth shell — avoids circular import
export { PlaygroundToolbarSection };
export { jsonFallback };
