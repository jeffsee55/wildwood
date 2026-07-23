import { cacheLife, cacheTag } from "next/cache";
import { draftMode } from "next/headers";
import { getBranch } from "wildwood/nextjs/branch";

import { type PlaygroundConfig, stablePlaygroundTag } from "./playground-config";
import { playDebug, playFailureHeadline, playInfo } from "./playground-log";
import { buildPlaygroundWildwood } from "./wildwood";

export const PLAYGROUND_CONTENT_TAG = "wildwood:playground-content";

function playgroundDatabaseUrl(): string {
  return process.env.TURSO_DATABASE_URL?.trim() || "file:./wildwood.db";
}

async function draftActive(): Promise<boolean> {
  try {
    return (await draftMode()).isEnabled;
  } catch {
    return false;
  }
}

/**
 * Cached playground fetch — `use cache` + `cacheTag` so
 * `revalidateTag(PLAYGROUND_CONTENT_TAG)` from `createWildwoodRoute`
 * busts playground previews too. Branch-scoped key via stable tag + ref.
 *
 * Previous version deliberately avoided `unstable_cache`. Now that
 * `cacheComponents: true` is enabled in `apps/play`, `"use cache"` is stable
 * and draftMode bypass is per-user (no global purge on enter).
 */
export async function getPlaygroundViewData(
  ref: string,
  config: PlaygroundConfig,
): Promise<object> {
  "use cache";
  cacheLife("hours");
  // Tag the view as a whole + branch-aware + config-aware so revalidate can be coarse or fine.
  cacheTag(
    PLAYGROUND_CONTENT_TAG,
    `${PLAYGROUND_CONTENT_TAG}:${ref}`,
    `${PLAYGROUND_CONTENT_TAG}:${stablePlaygroundTag(config)}`,
  );

  // Draft bypass is per-user — Next skips Data Cache for this user when enabled.
  const draft = await draftActive();

  playDebug("viewData.start", {
    activeRef: ref,
    draft,
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

  let wildwood;
  try {
    wildwood = buildPlaygroundWildwood(config);
  } catch (err) {
    playFailureHeadline("buildPlaygroundWildwood", err, {
      org: config.org,
      repo: config.repo,
      localPath: config.source === "local" ? config.localPath : null,
    });
    throw new Error(
      `Wildwood client could not be created (source=${config.source}, org/repo, or localPath). See server stderr for "FAILED at buildPlaygroundWildwood".`,
      { cause: err },
    );
  }

  playDebug("viewData.findMany.before", { ref });
  let result;
  try {
    result = await wildwood.page.findMany({ ref });
  } catch (err) {
    playFailureHeadline("wildwood.page.findMany", err, {
      ref,
      org: config.org,
      repo: config.repo,
    });
    throw new Error(
      `findMany failed for ref "${ref}" (worktree not ready, DB, or git). See server stderr for "FAILED at wildwood.page.findMany".`,
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
      hint: "0 items. If you expect files, re-index: Toolbar Apply, or delete apps/play/wildwood.db and reload. DB path = cwd of Next process for file:./wildwood.db; see viewData.start libsqlUrl.",
      ref,
      org: config.org,
      repo: config.repo,
      match: config.match,
    });
  }

  try {
    return wildwood._.logger.print(result, false) as object;
  } catch (err) {
    playFailureHeadline("wildwood._.logger.print", err, { itemCount: n });
    throw new Error(
      "Failed to build JSON preview (logger.print / markdown transform). See server stderr for FAILED at wildwood._.logger.print.",
      { cause: err },
    );
  }
}

/**
 * Non-cached wrapper used when we explicitly already resolved the branch via cookie.
 * Keeps old signature for existing call-sites, but now delegates to cached fn.
 */
export async function getPlaygroundViewDataForBranch(config: PlaygroundConfig) {
  // Resolve branch cookie from `next/headers` when available (server render), else config.ref.
  let branch = config.ref;
  try {
    // getBranch expects a WildwoodClient-shaped object with _?.config?.ref; we can pass a stub.
    const stub = { _: { config: { ref: config.ref } } } as unknown as Parameters<typeof getBranch>[0];
    branch = await getBranch(stub);
  } catch {
    branch = config.ref;
  }
  return getPlaygroundViewData(branch, config);
}

