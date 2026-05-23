import { inspect } from "node:util";

import type { PlaygroundConfig } from "./playground-config";
import { getResolvedLocalPathForPlayground } from "./resolve-playground-local-path";
import { playFailureHeadline } from "./playground-log";

export type PlaygroundErrorContext = {
  activeRef: string;
  config: PlaygroundConfig;
};

/**
 * Produces only JSON/inspect-safe data so the server log never shows `{}` from
 * odd throwables, empty plain objects, or `undefined` fields dropped by stringify.
 */
function errorShapeForLog(err: unknown): Record<string, unknown> {
  if (err == null) {
    return { kind: "nullish", repr: String(err) };
  }
  if (err instanceof Error) {
    const o: Record<string, unknown> = {
      kind: "Error",
      name: err.name,
      message: err.message,
      stack: err.stack ?? null,
    };
    if (err.cause != null) {
      o.cause =
        err.cause instanceof Error
          ? { name: err.cause.name, message: err.cause.message, stack: err.cause.stack }
          : { raw: err.cause };
    }
    return o;
  }
  if (typeof err === "string") {
    return { kind: "string", value: err };
  }
  if (typeof err === "number" || typeof err === "boolean" || typeof err === "bigint") {
    return { kind: "primitive", value: err, repr: String(err) };
  }
  if (typeof err === "object") {
    const o = err as Record<string, unknown>;
    const common = {
      message: o.message,
      code: o.code,
      name: o.name,
      cause: o.cause,
    };
    const hasCommon = Object.values(common).some((v) => v !== undefined);
    try {
      const json = JSON.stringify(err);
      if (json === "{}" && hasCommon) {
        return { kind: "object", partial: common, inspect: inspect(err, { depth: 4, breakLength: 100, colors: false }) };
      }
      if (json === "{}") {
        return { kind: "object", emptyJson: true, inspect: inspect(err, { depth: 4, breakLength: 100, colors: false }) };
      }
      return { kind: "object", json };
    } catch {
      return { kind: "object", partial: hasCommon ? common : null, inspect: inspect(err, { depth: 6, breakLength: 100, colors: false }) };
    }
  }
  return { kind: typeof err, repr: String(err) };
}

function isZodLike(
  err: unknown,
): err is { issues: readonly { path: unknown[]; message: string }[] } {
  return (
    typeof err === "object" &&
    err !== null &&
    "issues" in err &&
    Array.isArray((err as { issues: unknown }).issues)
  );
}

function findZodInChain(
  err: unknown,
):
  | { issues: readonly { path: unknown[]; message: string }[] }
  | null {
  let e: unknown = err;
  const seen = new Set<unknown>();
  for (let i = 0; i < 10 && e != null && !seen.has(e); i++) {
    seen.add(e);
    if (isZodLike(e)) {
      return e;
    }
    if (e instanceof Error && e.cause != null) {
      e = e.cause;
      continue;
    }
    break;
  }
  return null;
}

/** Full error chain for UI + logs (wrappers from getPlaygroundViewData include `.cause`). */
function formatErrorChainForUser(err: unknown): string {
  const z = findZodInChain(err);
  if (z) {
    return z.issues
      .map((i) => {
        const p = i.path.length ? i.path.map(String).join(".") : "(root)";
        return `• ${p}: ${i.message}`;
      })
      .join("\n");
  }
  const parts: string[] = [];
  let e: unknown = err;
  const seen = new Set<unknown>();
  for (let i = 0; i < 10 && e != null && !seen.has(e); i++) {
    seen.add(e);
    if (e instanceof Error) {
      const m = (e.message || "").trim();
      if (m) {
        parts.push(m);
      } else {
        parts.push(`(${e.name} with no message)`);
      }
      e = e.cause;
    } else {
      const s = typeof e === "string" ? e : String(e);
      if (s && s !== "[object Object]") {
        parts.push(s);
      } else {
        try {
          parts.push(JSON.stringify(e));
        } catch {
          parts.push(inspect(e, { depth: 2, colors: false }));
        }
      }
      break;
    }
  }
  if (parts.length === 0) {
    return "(Unknown error: could not read message; see server log under thrown/inspect.)";
  }
  if (parts.length === 1) {
    return parts[0]!;
  }
  return parts.join("\n→ (cause) ");
}

/**
 * A single string for the alert (user-facing) plus a **server** log with full context.
 */
export function logAndFormatPlaygroundError(
  err: unknown,
  ctx: PlaygroundErrorContext,
): string {
  const c = ctx.config;
  const resolvedLocal = getResolvedLocalPathForPlayground(c);
  const localPathLine =
    c.source === "local"
      ? [
          `localPath (raw from cookie): ${c.localPath === "" || c.localPath == null ? "(empty — auto-detect from process.cwd)" : c.localPath}`,
          `localPath (resolved to git root): ${resolvedLocal ?? "(n/a — not local)"}`,
          `next process.cwd(): ${process.cwd()}`,
        ].join("\n")
      : "localPath: (not used; GitHub remote)";

  // One string line: some runtimes / log pipelines stringify the 2nd `console.error`
  // arg poorly (empty `{}`); always embed context + a safe error description.
  const logPayload: Record<string, unknown> = {
    activeRef: ctx.activeRef,
    source: c.source,
    org: c.org,
    repo: c.repo,
    formDefaultRef: c.ref,
    nextCwd: process.cwd(),
    localPathRaw: c.source === "local" ? c.localPath : null,
    resolvedLocalPath: resolvedLocal,
    match: c.match,
    contentType: c.contentType,
    thrown: errorShapeForLog(err),
  };
  const logLine = `[play] preview load failed (structured)\n${inspect(logPayload, { depth: 8, breakLength: 100, colors: false })}`;
  console.error(logLine);
  playFailureHeadline("preview (PlaygroundJsonSection catch)", err, {
    org: c.org,
    repo: c.repo,
    source: c.source,
    activeRef: ctx.activeRef,
  });

  const problem = formatErrorChainForUser(err);

  return [
    "Preview run failed. Details below and in the terminal where you run the Next dev server (stderr lines starting with [play]).",
    "If you only see { } in a log, search for: [play] preview load failed (structured)  OR  [play] FAILED at",
    "Verbose steps: set TR33_PLAY_LOG=1  (in development, logging is on unless TR33_PLAY_LOG=0).",
    "",
    "── What went wrong ──",
    problem,
    "",
    "── Playground context (check these match your intent) ──",
    `source: ${c.source} (${c.source === "github" ? "GitHub API" : "local git; org/repo = DB namespace only"})`,
    `org: ${c.org}`,
    `repo: ${c.repo}`,
    `activeRef: ${ctx.activeRef}  (branch used for findMany; may differ from form if you use branch preview)`,
    `form default ref: ${c.ref}`,
    localPathLine,
    `match: ${c.match}`,
    `contentType: ${c.contentType}`,
    "",
    "── Things to try ──",
    c.source === "github"
      ? "• GitHub: confirm the repo is public or your token has access; check ref exists."
      : "• Local: ensure `localPath` is a real git worktree, ref exists, and the glob matches files under that tree.",
    "• If you changed org/repo, align with what’s in `tr33.db` or delete `apps/play/tr33.db` and Apply again.",
    "",
    "── What this page cannot know ──",
    "We run on the server. We do not see your full filesystem except paths you configure; we cannot see the browser devtools console for the preview panel.",
    "The SQLite file URL `file:./tr33.db` is relative to the Next process current working directory (see [play] viewData.start: libsqlUrl in the server log).",
  ].join("\n");
}
