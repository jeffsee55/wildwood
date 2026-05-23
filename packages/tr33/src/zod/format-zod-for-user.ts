import type { z } from "zod/v4";

function formatPath(path: readonly PropertyKey[]): string {
  let s = "";
  for (const seg of path) {
    if (typeof seg === "number") {
      s += `[${seg}]`;
    } else {
      s = s ? `${s}.${String(seg)}` : String(seg);
    }
  }
  return s;
}

/**
 * Produces a short, user-oriented explanation when structured data (e.g. a worktree) fails
 * Zod validation, so callers can `throw new Error(…)` instead of surfacing a raw `ZodError`.
 */
export function formatZodErrorForUser(
  error: z.ZodError,
  what: "worktree" | "data",
): string {
  const issues = error.issues;
  if (issues.length === 0) {
    return `We couldn’t read this ${what}. The response didn’t look valid.`;
  }

  const [first, ...rest] = issues;
  const path = formatPath(first.path);
  const pathKey = path.toLowerCase();

  if (pathKey.includes("entries") && pathKey.includes("blob")) {
    return [
      "A file entry is missing its text contents (the blob join came back empty).",
      "Common cause: the organization or repository name in your config no longer matches the one used when the SQLite file was first filled. The DB keys every blob as org+repo+oid, so if you only changed the repo name (for example to “tr33”) while the data was written under “tr33-mono”, the join will fail. Use the same org+repo you used the first time, or delete the playground tr33.db file and apply again to re-index.",
      "Other cases: blobs not synced yet, no files matched your glob on this ref, or the worktree is still loading — try another ref or refresh from the toolbar.",
    ].join("\n\n");
  }

  const tail = rest.length
    ? ` (${rest.length} more issue${rest.length > 1 ? "s" : ""})`
    : "";

  if (path) {
    return `Couldn’t read this ${what} (${path}): ${first.message}.${tail}`;
  }
  return `Couldn’t read this ${what}: ${first.message}.${tail}`;
}
