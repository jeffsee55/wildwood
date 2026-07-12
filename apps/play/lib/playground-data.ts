import { type PlaygroundConfig } from "./playground-config";
import {
  playDebug,
  playFailureHeadline,
  playInfo,
} from "./playground-log";
import { playgroundDatabaseUrl } from "./playground-database-url";
import { buildPlaygroundTr33 } from "./tr33";

/**
 * Fetches the `page` collection for the playground. Not wrapped in `"use cache"` or
 * `unstable_cache`: those only run the **inner** callback on a cache **miss**; on a
 * hit the body is skipped (so e.g. `console.log` / `findMany` won’t look “called” every time).
 * Server `console.log` also goes to the **dev terminal**, not the browser console.
 */
export async function getPlaygroundViewData(
  ref: string,
  config: PlaygroundConfig,
): Promise<object> {
  playDebug("viewData.start", {
    activeRef: ref,
    nextCwd: process.cwd(),
    nodeEnv: process.env.NODE_ENV,
    libsqlUrl: playgroundDatabaseUrl(),
    config: {
      source: config.source,
      org: config.org,
      repo: config.repo,
      defaultRef: config.ref,
      localPathRaw: config.source === "local" ? config.localPath : null,
      match: config.match,
      contentType: config.contentType,
    },
  });

  let tr33;
  try {
    tr33 = buildPlaygroundTr33(config);
  } catch (err) {
    playFailureHeadline("buildPlaygroundTr33", err, {
      org: config.org,
      repo: config.repo,
      localPath: config.source === "local" ? config.localPath : null,
    });
    throw new Error(
      `Tr33 client could not be created (source=${config.source}, org/repo, or localPath). See server stderr for "FAILED at buildPlaygroundTr33".`,
      { cause: err },
    );
  }

  playDebug("viewData.findMany.before", { ref });
  let result;
  try {
    result = await tr33.page.findMany({ ref });
  } catch (err) {
    playFailureHeadline("tr33.page.findMany", err, {
      ref,
      org: config.org,
      repo: config.repo,
    });
    throw new Error(
      `findMany failed for ref "${ref}" (worktree not ready, DB, or git). See server stderr for "FAILED at tr33.page.findMany".`,
      { cause: err },
    );
  }

  const n = Array.isArray(result.items) ? result.items.length : 0;
  playDebug("viewData.findMany.after", {
    collection: result.collection,
    commitOid: result.commitOid,
    itemCount: n,
  });
  if (n === 0) {
    playInfo("viewData.empty result", {
      hint: "0 items. If you expect files, re-index: Toolbar Apply, or delete apps/play/tr33.db and reload. DB path = cwd of Next process for file:./tr33.db; see viewData.start libsqlUrl.",
      ref,
      org: config.org,
      repo: config.repo,
      match: config.match,
    });
  }

  try {
    return tr33._.logger.print(result, false) as object;
  } catch (err) {
    playFailureHeadline("tr33._.logger.print", err, { itemCount: n });
    throw new Error(
      "Failed to build JSON preview (logger.print / markdown transform). See server stderr for FAILED at tr33._.logger.print.",
      { cause: err },
    );
  }
}
