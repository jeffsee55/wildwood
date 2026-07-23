/**
 * Request-scoped branch + draft context for docs.
 *
 * - `branch` from `x-wildwood-branch` cookie via `getBranch(wildwood)` → `cookies()`.
 * - `isDraft` from `draftMode().isEnabled` → `__prerender_bypass`.
 *
 * These are DYNAMIC APIs. With `cacheComponents:true` they must run inside a
 * Suspense boundary or after `await connection()`. This helper calls `connection()`
 * so callers that forget Suspense still get a proper dynamic marker, but the
 * preferred pattern is:
 *
 *   const ctx = await getRequestContext(); // dynamic
 *   return <Suspense><Content branch={ctx.branch} /></Suspense>
 *
 * Cache functions in `lib/content.ts` accept `{branch,isDraft}` as explicit args,
 * so the Data Cache key is branch-aware without pulling dynamic APIs into the
 * cached fn itself.
 */

import { draftMode } from "next/headers";
// `connection` moved in Next 16: it's in `next/server`, not `next/cache`.
import { connection } from "next/server";
import { getBranch } from "wildwood/nextjs/branch";
import { config, wildwood } from "./wildwood";

export type RequestContext = {
  branch: string;
  isDraft: boolean;
};

export async function getRequestContext(): Promise<RequestContext> {
  // Mark this execution as intentionally dynamic. Without this, Next's
  // Cache Components build would treat `cookies()` access as "uncached data
  // outside Suspense" and fail the prerender.
  await connection();

  let branch: string;
  try {
    branch = await getBranch(wildwood);
  } catch {
    branch = (config.ref as string | undefined) ?? "main";
  }

  let isDraft = false;
  try {
    isDraft = (await draftMode()).isEnabled;
  } catch {
    isDraft = false;
  }

  return { branch, isDraft };
}
