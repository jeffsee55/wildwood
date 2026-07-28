/**
 * `wildwood/nextjs/handlers/edit-ops`
 *
 * Shared content-edit operations used by both the HTTP API (`git-service.ts`)
 * and the MCP server (`mcp-server.ts`). One source of truth for behavior means
 * both surfaces get the same gate, the same "no edits to protected ref" guard,
 * and the same error messages.
 *
 * Why a shared layer? Previously each surface called `client._.git.*` directly,
 * duplicating logic and letting the MCP path bypass the HTTP API's authz +
 * revalidation. Centralizing here means:
 *   - The protected-ref guard (cannot edit `config.ref`) is enforced once.
 *   - The per-action `authorize` gate runs once for both surfaces.
 *   - Deletion support (which requires a new git primitive) lives here.
 *
 * The result shape is transport-agnostic (`EditOpsResult<T>`): callers wrap it
 * in a `Response` (HTTP) or a tool result (`textResult`/`errorResult`) — they
 * don't re-implement the operation.
 */

import type { WildwoodClient } from "@/client/index";
import type { WildwoodAuthAction, WildwoodAuthUser } from "@/nextjs/auth";
import { isNativeRemoteNotImplementedError } from "./auth";

/** A single caller identity surfaced to every operation. */
export type EditOpUser = Pick<WildwoodAuthUser, "id" | "email" | "name">;

/**
 * The context every edit op runs under. Both surfaces build one of these:
 *   - HTTP API: closes over its route-level `authorize` + resolved session user.
 *   - MCP: builds from the verified JWT (`McpAuthContext`) + the same `authorize`.
 */
export type EditOpContext = {
  client: WildwoodClient;
  user: EditOpUser | null;
  /**
   * Per-action authorizer gate. Returns `null` to allow, or a string error
   * message to deny. Transport-agnostic so it can be used by both REST and MCP.
   */
  authorize: (action: WildwoodAuthAction) => Promise<string | null>;
  /**
   * Called after a successful mutation (add, commit, delete, push, merge).
   * The HTTP API uses this to call `revalidateTag()`; the MCP server passes
   * a no-op or a fetch-based revalidation hook. Without this, edits made via
   * MCP don't invalidate the Next.js cache.
   */
  onMutate?: () => void;
};

/**
 * Transport-agnostic result. `{ ok: true, data }` for success, `{ ok: false,
 * error }` for failure (HTTP callers map to status codes; MCP callers map to
 * `isError` text results).
 */
export type EditOpResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: string; status?: number };

/** Internal: success shorthand. */
function ok<T>(data: T): EditOpResult<T> {
  return { ok: true as const, data };
}

/** Internal: failure shorthand. */
function fail(error: string, status?: number): EditOpResult<never> {
  return { ok: false as const, error, status };
}

/** Internal: default author identity for attributed commits. */
export function authorFromUser(user: EditOpUser | null): {
  name: string;
  email: string;
} {
  const name = user?.name || user?.email || user?.id || "wildwood";
  const email = user?.email || `${user?.id ?? "agent"}@users.noreply.wildwood`;
  return { name, email };
}

/** Internal: guard against writing to the protected ref (e.g. `main`). */
/**
 * Guard against writing to the protected ref (e.g. `main`). Returns an error
 * message when the action targets the protected ref, or `null` to allow.
 */
function guardProtectedRef(
  client: WildwoodClient,
  action: WildwoodAuthAction,
): string | null {
  const protectedRef = client._.config.ref;
  if (!protectedRef) return null;
  if (action.type === "git.add" && action.ref === protectedRef) return protectedRefError(protectedRef);
  if (action.type === "git.commit" && action.ref === protectedRef) return protectedRefError(protectedRef);
  if (action.type === "content.delete" && action.path === protectedRef) return protectedRefError(protectedRef);
  return null;
}

function protectedRefError(protectedRef: string): string {
  return (
    `Cannot edit "${protectedRef}" — this is the configured protected ref. Create a branch from ${protectedRef} first.` +
    `\n\nExample: create_branch(name="agent/my-edit", base="${protectedRef}") then add_files(ref="agent/my-edit", ...).`
  );
}

/** Internal: run an op with the authorizer gate and revalidation hook. */
async function run<T>(
  ctx: EditOpContext,
  action: WildwoodAuthAction,
  fn: () => Promise<EditOpResult<T>>,
): Promise<EditOpResult<T>> {
  const gateError = await ctx.authorize(action);
  if (gateError) return fail(gateError);
  const protectedRefGuard = guardProtectedRef(ctx.client, action);
  if (protectedRefGuard) return fail(protectedRefGuard);
  try {
    const result = await fn();
    if (result.ok) ctx.onMutate?.();
    return result;
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

// ── read ────────────────────────────────────────────────────────────────

export async function listCollections(
  client: WildwoodClient,
): Promise<EditOpResult<string[]>> {
  const collections = Object.keys(client._.config.configObject.collections ?? {});
  return ok(collections);
}

export async function findMany(
  ctx: EditOpContext,
  args: {
    collection: string;
    ref?: string;
    limit?: number;
    offset?: number;
    orderBy?: Record<string, "asc" | "desc">;
    variant?: string;
    where?: Record<string, unknown>;
    with?: Record<string, unknown>;
    references?: Record<string, unknown>;
  },
): Promise<EditOpResult<unknown>> {
  const coll = (ctx.client as Record<string, unknown>)[args.collection] as
    | { findMany: (a: unknown) => Promise<unknown> }
    | undefined;
  if (!coll?.findMany) return fail(`Unknown collection: ${args.collection}`);
  try {
    const res = await coll.findMany({
      ...(args.ref ? { ref: args.ref } : {}),
      ...(args.limit ? { limit: args.limit } : {}),
      ...(args.offset ? { offset: args.offset } : {}),
      ...(args.orderBy ? { orderBy: args.orderBy } : {}),
      ...(args.variant ? { variant: args.variant } : {}),
      ...(args.where ? { where: args.where } : {}),
      ...(args.with ? { with: args.with } : {}),
      ...(args.references ? { references: args.references } : {}),
    });
    return ok(res);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export async function findFirst(
  ctx: EditOpContext,
  args: {
    collection: string;
    ref?: string;
    variant?: string;
    where?: Record<string, unknown>;
    with?: Record<string, unknown>;
    references?: Record<string, unknown>;
  },
): Promise<EditOpResult<unknown>> {
  const coll = (ctx.client as Record<string, unknown>)[args.collection] as
    | { findFirst: (a: unknown) => Promise<unknown> }
    | undefined;
  if (!coll?.findFirst) return fail(`Unknown collection: ${args.collection}`);
  try {
    const res = await coll.findFirst({
      ...(args.ref ? { ref: args.ref } : {}),
      ...(args.variant ? { variant: args.variant } : {}),
      ...(args.where ? { where: args.where } : {}),
      ...(args.with ? { with: args.with } : {}),
      ...(args.references ? { references: args.references } : {}),
    });
    return ok(res);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export async function getBlob(
  ctx: EditOpContext,
  oid: string,
): Promise<EditOpResult<unknown>> {
  const git = ctx.client._.git;
  const blob = await git.getBlob(oid);
  if (!blob) return fail(`Blob not found: ${oid}`);
  return ok(blob);
}

// ── branches ────────────────────────────────────────────────────────────

export async function listBranches(
  ctx: EditOpContext,
): Promise<EditOpResult<string[]>> {
  const git = ctx.client._.git;
  const remote = git.remote;
  await ctx.client._.db.init();
  const worktreeRefs = await git.db.refs.listRefs();
  let remoteRefs: string[] = [];
  try {
    remoteRefs = await remote.listBranches();
  } catch (e) {
    console.error("Failed to list remote branches:", e);
  }
  const seen = new Set(worktreeRefs);
  const branches = [...worktreeRefs];
  for (const r of remoteRefs) if (!seen.has(r)) {
    seen.add(r);
    branches.push(r);
  }
  return ok(branches);
}

export async function createBranch(
  ctx: EditOpContext,
  args: { name: string; baseRef?: string; base?: string },
): Promise<EditOpResult<{ ref: string; base: string }>> {
  const git = ctx.client._.git;
  const base = (args.baseRef ?? args.base)?.trim();
  if (!base) return fail("Missing base ref: send `baseRef` or `base`", 400);
  const action: WildwoodAuthAction = { type: "git.createBranch", name: args.name, baseRef: base };
  const denied = await ctx.authorize(action);
  if (denied) return fail(denied);
  try {
    await git.createBranch({ name: args.name, base });
    ctx.onMutate?.();
    return ok({ ref: args.name, base });
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export async function switchBranch(
  ctx: EditOpContext,
  args: { ref: string },
): Promise<EditOpResult<{ ref: string }>> {
  const git = ctx.client._.git;
  const refName = args.ref.trim();
  if (!refName) return fail("ref is required", 400);
  const action: WildwoodAuthAction = { type: "git.switchRef", ref: refName };
  const denied = await ctx.authorize(action);
  if (denied) return fail(denied);
  try {
    await git.switch({ ref: refName });
    ctx.onMutate?.();
    return ok({ ref: refName });
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

// ── mutating ────────────────────────────────────────────────────────────

export async function addFiles(
  ctx: EditOpContext,
  args: { ref: string; files: Record<string, string | Uint8Array> },
): Promise<EditOpResult<{ ref: string; files: Record<string, string>; rootTreeOid: string }>> {
  const git = ctx.client._.git;
  const paths = Object.keys(args.files);
  const action: WildwoodAuthAction = { type: "git.add", ref: args.ref, paths };
  return run(ctx, action, async () => {
    const result = await git.add({ ref: args.ref, files: args.files });
    return ok({ ref: args.ref, files: result.files, rootTreeOid: result.rootTreeOid });
  });
}

export async function commit(
  ctx: EditOpContext,
  args: { ref: string; message: string },
): Promise<EditOpResult<unknown>> {
  const git = ctx.client._.git;
  const action: WildwoodAuthAction = { type: "git.commit", ref: args.ref, message: args.message };
  return run(ctx, action, async () => {
    const commit = await git.commit({
      ref: args.ref,
      commit: {
        message: args.message,
        author: authorFromUser(ctx.user),
      },
    });
    return ok(commit);
  });
}

export async function discard(
  ctx: EditOpContext,
  args: { ref: string },
): Promise<EditOpResult<{ ok: true }>> {
  const git = ctx.client._.git;
  const action: WildwoodAuthAction = { type: "git.discard", ref: args.ref };
  return run(ctx, action, async () => {
    await git.discard({ ref: args.ref });
    return ok({ ok: true });
  });
}

export async function push(
  ctx: EditOpContext,
  args: { ref: string; pr?: { title?: string; body?: string } },
): Promise<EditOpResult<{ ok: true; commitOid: string; pr?: { number: number; url: string } }>> {
  const git = ctx.client._.git;
  const action: WildwoodAuthAction = { type: "git.push", ref: args.ref };
  const denied = await ctx.authorize(action);
  if (denied) return fail(denied);
  // Push is allowed on any branch — including the protected ref (it's a publish,
  // not a local edit). The guard above only blocks local edits.
  try {
    const result = await git.push({
      ref: args.ref,
      ...(args.pr ? { pr: args.pr as never } : {}),
    });
    ctx.onMutate?.();
    return ok({
      ok: true,
      commitOid: result.commitOid,
      ...(result.pr ? { pr: result.pr } : {}),
    });
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export async function pull(
  ctx: EditOpContext,
  args: { ref: string },
): Promise<EditOpResult<{ ok: true; commitOid?: string }>> {
  const git = ctx.client._.git;
  const action: WildwoodAuthAction = { type: "git.pull", ref: args.ref };
  const denied = await ctx.authorize(action);
  if (denied) return fail(denied);
  try {
    const pullResult = await git.pull({ ref: args.ref });
    if ((pullResult as { type: string }).type === "conflict") {
      return fail("Pull resulted in merge conflicts", 409);
    }
    const successResult = pullResult as { commit: { oid: string; treeOid: string } };
    await git.db.refs.updateCommit({
      ref: args.ref,
      commit: (pullResult as never as { commit: never }).commit,
    });
    await git.db.refs.setTreeOid({ ref: args.ref, treeOid: successResult.commit.treeOid });
    ctx.onMutate?.();
    return ok({ ok: true, commitOid: successResult.commit.oid });
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export async function merge(
  ctx: EditOpContext,
  args: { ref: string; message?: string },
): Promise<EditOpResult<unknown>> {
  const git = ctx.client._.git;
  const remote = git.remote;
  const configRef = git.config.ref;
  const action: WildwoodAuthAction = { type: "git.merge", ref: args.ref, message: args.message };
  const denied = await ctx.authorize(action);
  if (denied) return fail(denied);
  try {
    if (args.ref === configRef) {
      return ok({
        ok: true,
        pr: null,
        commitOid: null,
        message: `Already on ${configRef}; nothing to merge.`,
      });
    }
    let pr = await remote.findPr({ head: args.ref, base: configRef });
    if (!pr) {
      pr = await remote.createPr({
        head: args.ref,
        base: configRef,
        title: `Merge ${args.ref} into ${configRef}`,
        body: `Auto-created by Wildwood for ${args.ref} -> ${configRef}.`,
      });
    }
    const comment = args.message?.trim();
    if (comment) await remote.createPrComment({ pr: pr.number, body: comment });
    const mergeResult = await remote.mergePr({ pr: pr.number, method: "squash" });
    try {
      const pullResult = await git.pull({ ref: configRef });
      if ((pullResult as { type: string }).type === "success") {
        await git.db.refs.updateCommit({
          ref: configRef,
          commit: (pullResult as never as { commit: never }).commit,
        });
        await git.db.refs.setTreeOid({
          ref: configRef,
          treeOid: (pullResult as { commit: { treeOid: string } }).commit.treeOid,
        });
      }
    } catch (pullError) {
      console.error(
        `[edit-ops] PR merged successfully but local pull failed for ${configRef}:`,
        pullError,
      );
    }
    ctx.onMutate?.();
    return ok({
      ok: true,
      pr: { number: pr.number, url: pr.url },
      commitOid: mergeResult.commitOid,
    });
  } catch (error) {
    if (!isNativeRemoteNotImplementedError(error)) {
      return fail(error instanceof Error ? error.message : String(error));
    }
    // Fallback for NativeRemote (dev) where PR ops aren't implemented.
    console.warn(
      `[edit-ops] PR ops not implemented for NativeRemote; falling back to local merge (${args.ref} -> ${configRef})`,
      error,
    );
    try {
      const localMerge = await git.merge({
        ours: configRef,
        theirs: args.ref,
        message: args.message,
      } as never);
      if ((localMerge as { type: string }).type === "conflict") {
        return fail(`Local merge conflict for ${args.ref} -> ${configRef}`, 409);
      }
      await git.db.refs.updateCommit({
        ref: configRef,
        commit: (localMerge as never as { commit: never }).commit,
      });
      await git.db.refs.setTreeOid({
        ref: configRef,
        treeOid: (localMerge as { commit: { treeOid: string } }).commit.treeOid,
      });
      ctx.onMutate?.();
      return ok({
        ok: true,
        pr: null,
        commitOid: (localMerge as { commit: { oid: string } }).commit.oid,
      });
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  }
}

export async function createPr(
  ctx: EditOpContext,
  args: { ref: string; title?: string; body?: string },
): Promise<EditOpResult<{ ok: true; pr: { number: number; url: string } }>> {
  const git = ctx.client._.git;
  const remote = git.remote;
  const configRef = git.config.ref;
  const action: WildwoodAuthAction = { type: "git.createPr", ref: args.ref, title: args.title, body: args.body };
  const denied = await ctx.authorize(action);
  if (denied) return fail(denied);
  try {
    let pr = await remote.findPr({ head: args.ref, base: configRef });
    if (!pr) {
      const defaultTitle = `Merge ${args.ref} into ${configRef}`;
      const defaultBody = `Auto-created by Wildwood for ${args.ref} -> ${configRef}.`;
      const rawTitle = args.title?.trim() || defaultTitle;
      const MAX_TITLE = 128;
      const title = rawTitle.length > MAX_TITLE ? `${rawTitle.slice(0, MAX_TITLE)}…` : rawTitle;
      pr = await remote.createPr({
        head: args.ref,
        base: configRef,
        title,
        body: args.body?.trim() || defaultBody,
      });
    }
    ctx.onMutate?.();
    return ok({ ok: true, pr: { number: pr.number, url: pr.url } });
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export async function findPr(
  ctx: EditOpContext,
  args: { ref: string },
): Promise<EditOpResult<{ pr?: { number: number; url: string } }>> {
  const git = ctx.client._.git;
  const remote = git.remote;
  const configRef = git.config.ref;
  try {
    const pr = await remote.findPr({ head: args.ref, base: configRef });
    return ok(pr ? { pr } : {});
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

// ── delete files ─────────────────────────────────────────────────────────

/**
 * Delete files from a branch's worktree. This is a new primitive — the git
 * surface only had `add`/`patchWorktree`. We model deletion as setting the
 * tree entry to absent by computing new tree objects without the entry.
 *
 * Implementation note: we read the current tree, compute new tree objects with
 * the entry removed, then persist them. This mirrors how `applyEntriesToTree`
 * adds entries — we just walk up and remove instead.
 */
export async function deleteFiles(
  ctx: EditOpContext,
  args: { ref: string; paths: string[] },
): Promise<EditOpResult<{ rootTreeOid: string }>> {
  const git = ctx.client._.git;
  // Per-path content.delete gate — the authz gate for each path.
  for (const path of args.paths) {
    const deny = await ctx.authorize({ type: "content.delete", path });
    if (deny) return fail(deny);
  }
  const protectedRef = git.config.ref;
  if (protectedRef && args.ref === protectedRef) {
    return fail(
      `Cannot delete from "${protectedRef}" — this is the configured protected ref. Create a branch first.` +
        `\n\nExample: create_branch(name="agent/my-edit", base="${protectedRef}") then delete_files(ref="agent/my-edit", ...).`,
    );
  }
  try {
    const worktree = await git.db.refs.get({ ref: args.ref });
    if (!worktree) {
      throw new Error(`Worktree for "${args.ref}" is not loaded. Create or switch to the branch first.`);
    }
    const rootTreeOid = worktree.rootTree?.oid ?? worktree.commit?.treeOid;
    if (!rootTreeOid) throw new Error(`No root tree OID found for ${args.ref}`);

    const newRootTreeOid = await git.trees.removeEntriesFromTree({
      rootTreeOid,
      paths: args.paths,
    });

    await git.db.refs.setTreeOid({ ref: args.ref, treeOid: newRootTreeOid });
    await git.db.refs.updateVersions({ ref: args.ref, versions: [git.config.version] });

    ctx.onMutate?.();
    return ok({ rootTreeOid });
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

/**
 * Combined add + commit convenience op. Agents often want to save a file and
 * commit it in one step. This is the common case for "make an edit".
 */
export async function addAndCommit(
  ctx: EditOpContext,
  args: { ref: string; message: string; files: Record<string, string | Uint8Array> },
): Promise<EditOpResult<{ rootTreeOid?: string; commit?: unknown }>> {
  const addResult = await addFiles(ctx, args);
  if (!addResult.ok) return fail(addResult.error);
  const commitResult = await commit(ctx, args);
  if (!commitResult.ok) return fail(commitResult.error);
  return ok({ rootTreeOid: addResult.data.rootTreeOid, commit: commitResult.data });
}
