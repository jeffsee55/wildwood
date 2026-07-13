"use client";

// Do NOT import from `wildwood/react` here — `wildwood/react` is a client entry that
// re-exports `wildwood-ui` and is built with `wildwood-store` (which can pull Node
// deps via Turbopack's module merging in Next 16). This component must stay
// pure client with zero `wildwood` core imports so its chunk never gets merged with
// `better-sqlite3` / `node:module` code from `wildwood/nextjs/play-auth`.
//
// For now we render JSON directly. If you want the themed `WildwoodJsonView`,
// move it to `wildwood-ui` (pure client, no `wildwood` core) and import from there.

export function PlaygroundJsonClient({ value }: { value: object }) {
  return (
    <pre className="w-full min-w-0 max-h-[min(70vh,560px)] overflow-auto rounded-md border border-zinc-200 bg-white p-2 text-xs dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}
