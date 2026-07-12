import { Suspense } from "react";

import { PlaygroundMain } from "./playground-main";

const pageFallback = (
  <div className="flex flex-1 w-full max-w-3xl flex-col gap-8 py-16 px-8">
    <div className="h-64 w-full animate-pulse rounded-lg bg-zinc-200/80 dark:bg-zinc-800/80" />
    <div className="w-full min-h-[200px] rounded-md border border-zinc-200 bg-zinc-100/80 dark:border-zinc-800 dark:bg-zinc-900/50" />
    <div className="h-12 w-12 shrink-0 animate-pulse rounded-full bg-zinc-200/80 dark:bg-zinc-800/80" />
  </div>
);

export default function Home() {
  return (
    <div className="flex flex-col flex-1 items-center justify-center bg-zinc-50 font-sans dark:bg-black">
      <Suspense fallback={pageFallback}>
        <PlaygroundMain />
      </Suspense>
    </div>
  );
}
