import { PLAYGROUND_CONFIG_COOKIE } from "@/lib/playground-config";

/**
 * Renders only in the RSC tree (no "use client") so intro copy is not re-diffed
 * during client hydration.
 */
export function PlaygroundConfigIntro() {
  return (
    <>
      <h2 className="mb-2 text-sm font-semibold text-zinc-800 dark:text-zinc-200">
        Playground repo
      </h2>
      <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-500">
        Values are stored in cookie{" "}
        <code className="text-zinc-700 dark:text-zinc-300">
          {PLAYGROUND_CONFIG_COOKIE}
        </code>{" "}
        and rebuild the{" "}
        <code className="text-zinc-700 dark:text-zinc-300">page</code>{" "}
        collection: schemaless{" "}
        <code className="text-zinc-700 dark:text-zinc-300">z.markdown</code> or{" "}
        <code className="text-zinc-700 dark:text-zinc-300">z.json</code>{" "}
        depending on the file type.
      </p>
      <p className="mb-3 text-xs text-zinc-600 dark:text-zinc-400">
        <span className="font-medium text-zinc-800 dark:text-zinc-200">
          GitHub
        </span>{" "}
        uses the GitHub API (org / repo / ref) to read content.{" "}
        <span className="font-medium text-zinc-800 dark:text-zinc-200">
          Local
        </span>{" "}
        runs <code className="text-zinc-700 dark:text-zinc-300">git</code> in a
        directory on this machine; org and repo are the{" "}
        <span className="font-medium">SQLite namespace</span> for this app’s{" "}
        <code className="text-zinc-700 dark:text-zinc-300">tr33.db</code> (they
        are not sent to GitHub). File contents are stored under that org+repo; if
        you change the repo name after the DB was first filled, re-use the
        previous name or delete{" "}
        <code className="text-zinc-700 dark:text-zinc-300">
          apps/play/tr33.db
        </code>{" "}
        and <strong>Apply</strong> again to re-index.
      </p>
    </>
  );
}
