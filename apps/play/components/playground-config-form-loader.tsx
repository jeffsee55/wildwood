"use client";

import dynamic from "next/dynamic";
import type { PlaygroundConfig } from "@/lib/playground-config";

const PlaygroundConfigForm = dynamic(
  () =>
    import("@/components/playground-config-form").then(
      (m) => m.PlaygroundConfigForm,
    ),
  {
    ssr: false,
    loading: () => (
      <div
        aria-hidden
        className="h-40 w-full max-w-3xl animate-pulse rounded-lg border border-zinc-200 bg-zinc-100/60 dark:border-zinc-800 dark:bg-zinc-900/40"
      />
    ),
  },
);

type Props = {
  githubSignedIn: boolean;
  initial: PlaygroundConfig;
};

/** Client-only: `ssr: false` is not valid on `next/dynamic` from a Server Component. */
export function PlaygroundConfigFormLoader({ githubSignedIn, initial }: Props) {
  return (
    <PlaygroundConfigForm
      githubSignedIn={githubSignedIn}
      initial={initial}
    />
  );
}
