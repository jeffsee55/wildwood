/**
 * `wildwood/nextjs/handlers/mcp-server`
 *
 * Model Context Protocol (MCP) server exposing the Wildwood client as tools so
 * a coding agent can read and write content given only a URL — no static
 * credentials. Auth is handled one layer up (`route.ts` wraps this in the
 * `@better-auth/mcp` `mcpHandler`, which performs the OAuth 2.1 bearer-token
 * check and 401 discovery handshake). By the time a request reaches here it is
 * already authenticated; the verified JWT (its `sub` is the user id) is
 * threaded in so tools can attribute writes and gate on authz.
 *
 * Transport: `WebStandardStreamableHTTPServerTransport` — a fetch-native
 * (`Request` → `Response`) Streamable HTTP transport, run in stateless mode
 * (no `sessionIdGenerator`): each POST spins up a fresh server+transport, which
 * is the simplest correct shape for a serverless/edge Next.js route and matches
 * how the MCP spec allows stateless JSON-RPC over HTTP.
 *
 * Tools delegate straight to the shared edit operations layer (`edit-ops.ts`)
 * so the HTTP API and MCP share one source of truth for behavior — the same
 * "no edits to protected ref" guard, the same `authorize` gate, and the same
 * query shape. This keeps the MCP path from drifting out of sync with the REST
 * API.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type { WildwoodClient } from "@/client/index";
import type { WildwoodAuthAction } from "@/nextjs/auth";
import {
  type EditOpContext,
  type EditOpResult,
  addAndCommit,
  addFiles,
  commit,
  createBranch,
  createPr,
  deleteFiles,
  discard,
  findFirst,
  findMany,
  findPr,
  getBlob,
  listBranches,
  listCollections,
  merge,
  pull,
  push,
  switchBranch,
} from "./edit-ops";
import { createPreviewToken as createPreviewTokenOp } from "./preview-token";

/** The verified caller identity, derived from the OAuth access-token JWT. */
export type McpAuthContext = {
  /** JWT `sub` — the better-auth user id. */
  userId: string;
  /** JWT `email` claim when present (informational; may be absent). */
  email?: string | undefined;
  /** Granted scopes, space-split from the token's `scope` claim. */
  scopes: string[];
};

/**
 * Per-action authorizer for the MCP server. The route layer resolves the
 * `authorize` function from the route options and passes it through so the MCP
 * tools run through the same authz gate as the HTTP API. Returns `null` to
 * allow, or a string error message to deny.
 */
export type McpAuthorizeFn = (action: WildwoodAuthAction) => Promise<string | null>;

/** Extra context the MCP server needs that isn't part of EditOpContext. */
export type McpServerContext = {
  /** Request origin, for building absolute preview URLs. */
  origin: string;
  /** Preview path (e.g. `/api/wildwood/preview`), for building share links. */
  previewPath: string;
  /** Auth instance, for creating preview tokens (needs DB access). */
  auth: unknown;
  /** Called after a successful mutation so the route layer can revalidate cache. */
  onMutate?: () => void;
};

function textResult(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
      },
    ],
  };
}

function errorResult(message: string) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: message }],
  };
}

/** Map an EditOpResult to an MCP tool result. */
function toToolResult<T>(result: EditOpResult<T>) {
  if (result.ok) return textResult(result.data);
  return errorResult(result.error);
}

/** Build an `EditOpContext` from the MCP auth context + authorizer. */
function buildEditOpContext(
  client: WildwoodClient,
  auth: McpAuthContext,
  authorize: McpAuthorizeFn,
  onMutate?: () => void,
): EditOpContext {
  return {
    client,
    user: {
      id: auth.userId,
      email: auth.email,
      name: undefined,
    },
    authorize,
    ...(onMutate ? { onMutate } : {}),
  };
}

/**
 * Build an `McpServer` wired to a Wildwood client for one authenticated caller.
 * A new server is created per request (stateless transport), so `auth` is fresh
 * each time and never shared across callers.
 *
 * @param authorize The per-action authorizer gate. The route layer passes this
 *   through so the MCP tools run through the same authz gate as the HTTP API.
 * @param serverCtx Extra context the preview-token tool needs (origin, previewPath, auth).
 */
export function buildWildwoodMcpServer(
  client: WildwoodClient,
  auth: McpAuthContext,
  authorize: McpAuthorizeFn,
  serverCtx: McpServerContext,
): McpServer {
  const server = new McpServer({
    name: "wildwood",
    version: "0.1.0",
  });

  const ctx = buildEditOpContext(client, auth, authorize, serverCtx.onMutate);

  // ── read ────────────────────────────────────────────────────────────────

  server.registerTool(
    "list_collections",
    {
      description:
        "List the content collections defined in this Wildwood project. Returns collection names usable as the `collection` argument to other tools.",
      inputSchema: {},
    },
    async () => {
      const res = await listCollections(client);
      return toToolResult(res);
    },
  );

  server.registerTool(
    "find_many",
    {
      description:
        "List entries in a collection. Supports the full query shape: `where` (filters), `with` (eager-load connections), `references` (reverse connections), `orderBy`, `limit`, `offset`, `variant`, and `ref`. Returns the collection name, the resolved commit oid, and the matched items.",
      inputSchema: {
        collection: z.string().describe("Collection name (see list_collections)."),
        ref: z.string().optional().describe("Git ref/branch to read. Defaults to the configured ref."),
        where: z.record(z.string(), z.unknown()).optional().describe(
          "Filter object, e.g. { title: { eq: 'Intro' } }, { slug: 'intro' }, or joined: { author: { name: { eq: 'Jeff' } } }. Compound: { AND: [...], OR: [...] }.",
        ),
        with: z.record(z.string(), z.unknown()).optional().describe(
          "Eager-load connections, e.g. { author: true }.",
        ),
        references: z.record(z.string(), z.unknown()).optional().describe(
          "Reverse connections, e.g. { docs: true }.",
        ),
        orderBy: z.record(z.string(), z.enum(["asc", "desc"])).optional().describe(
          "Order by field, e.g. { title: 'asc' }.",
        ),
        limit: z.number().int().positive().optional().describe("Max items to return."),
        offset: z.number().int().nonnegative().optional().describe("Items to skip."),
        variant: z.string().optional().describe("Content variant (e.g. locale)."),
      },
    },
    async (args) => {
      const res = await findMany(ctx, {
        collection: args.collection,
        ...(args.ref ? { ref: args.ref } : {}),
        ...(args.where ? { where: args.where } : {}),
        ...(args.with ? { with: args.with } : {}),
        ...(args.references ? { references: args.references } : {}),
        ...(args.orderBy ? { orderBy: args.orderBy } : {}),
        ...(args.limit ? { limit: args.limit } : {}),
        ...(args.offset ? { offset: args.offset } : {}),
        ...(args.variant ? { variant: args.variant } : {}),
      });
      return toToolResult(res);
    },
  );

  server.registerTool(
    "find_first",
    {
      description:
        "Fetch a single entry from a collection, optionally filtered by a `where` clause. Supports the full query shape: `where`, `with`, `references`, `variant`, and `ref`. Throws when no entry matches.",
      inputSchema: {
        collection: z.string().describe("Collection name (see list_collections)."),
        where: z.record(z.string(), z.unknown()).optional().describe(
          "Filter object, e.g. { slug: 'intro' } or { title: { eq: 'Intro' } }.",
        ),
        with: z.record(z.string(), z.unknown()).optional().describe(
          "Eager-load connections, e.g. { author: true }.",
        ),
        references: z.record(z.string(), z.unknown()).optional().describe(
          "Reverse connections, e.g. { docs: true }.",
        ),
        variant: z.string().optional().describe("Content variant (e.g. locale)."),
        ref: z.string().optional().describe("Git ref/branch to read. Defaults to the configured ref."),
      },
    },
    async (args) => {
      const res = await findFirst(ctx, {
        collection: args.collection,
        ...(args.where ? { where: args.where } : {}),
        ...(args.with ? { with: args.with } : {}),
        ...(args.references ? { references: args.references } : {}),
        ...(args.variant ? { variant: args.variant } : {}),
        ...(args.ref ? { ref: args.ref } : {}),
      });
      return toToolResult(res);
    },
  );

  server.registerTool(
    "get_blob",
    {
      description: "Read a raw git blob by its object id (oid). Returns the blob content as text.",
      inputSchema: {
        oid: z.string().describe("Git blob object id."),
      },
    },
    async (args) => {
      const res = await getBlob(ctx, args.oid);
      return toToolResult(res);
    },
  );

  // ── branches ────────────────────────────────────────────────────────────

  server.registerTool(
    "list_branches",
    {
      description:
        "List all branches available in the repository (local worktree refs + remote branches).",
      inputSchema: {},
    },
    async () => {
      const res = await listBranches(ctx);
      return toToolResult(res);
    },
  );

  server.registerTool(
    "create_branch",
    {
      description:
        "Create a new branch from a base ref. Use this before editing content — the protected ref (e.g. `main`) cannot be edited directly.",
      inputSchema: {
        name: z.string().describe("New branch name (e.g. 'agent/my-edit')."),
        baseRef: z.string().describe("Base ref to branch from (e.g. 'main')."),
      },
    },
    async (args) => {
      const res = await createBranch(ctx, { name: args.name, baseRef: args.baseRef });
      return toToolResult(res);
    },
  );

  server.registerTool(
    "switch_branch",
    {
      description:
        "Materialize the worktree for a ref so subsequent reads/writes target it. This is rarely needed — add_files and commit operate on the ref directly.",
      inputSchema: {
        ref: z.string().describe("Ref/branch to switch to."),
      },
    },
    async (args) => {
      const res = await switchBranch(ctx, { ref: args.ref });
      return toToolResult(res);
    },
  );

  // ── write ────────────────────────────────────────────────────────────────

  server.registerTool(
    "add_files",
    {
      description:
        "Stage file contents into the worktree for a ref (does not commit). Provide a map of repo-relative path -> file contents. The protected ref (e.g. `main`) cannot be edited directly — create a branch first.",
      inputSchema: {
        ref: z.string().describe("Ref/branch to write to (must not be the protected ref)."),
        files: z.record(z.string(), z.string()).describe("Map of repo-relative path to UTF-8 file contents."),
      },
    },
    async (args) => {
      const res = await addFiles(ctx, { ref: args.ref, files: args.files });
      return toToolResult(res);
    },
  );

  server.registerTool(
    "delete_files",
    {
      description:
        "Delete files from a branch's worktree (does not commit). Provide a list of repo-relative paths. The protected ref (e.g. `main`) cannot be edited directly — create a branch first.",
      inputSchema: {
        ref: z.string().describe("Ref/branch to delete from (must not be the protected ref)."),
        paths: z.array(z.string()).describe("Repo-relative paths to delete."),
      },
    },
    async (args) => {
      const res = await deleteFiles(ctx, { ref: args.ref, paths: args.paths });
      return toToolResult(res);
    },
  );

  server.registerTool(
    "commit",
    {
      description:
        "Create a commit on a ref with the currently staged worktree tree. The commit is attributed to the authenticated MCP user. The protected ref (e.g. `main`) cannot be committed directly — create a branch first.",
      inputSchema: {
        ref: z.string().describe("Ref/branch to commit on (must not be the protected ref)."),
        message: z.string().describe("Commit message."),
      },
    },
    async (args) => {
      const res = await commit(ctx, { ref: args.ref, message: args.message });
      return toToolResult(res);
    },
  );

  server.registerTool(
    "add_and_commit",
    {
      description:
        "Stage file contents and commit in one step. This is the common case for making an edit. The protected ref (e.g. `main`) cannot be edited directly — create a branch first.",
      inputSchema: {
        ref: z.string().describe("Ref/branch to write to (must not be the protected ref)."),
        message: z.string().describe("Commit message."),
        files: z.record(z.string(), z.string()).describe("Map of repo-relative path to UTF-8 file contents."),
      },
    },
    async (args) => {
      const res = await addAndCommit(ctx, { ref: args.ref, message: args.message, files: args.files });
      return toToolResult(res);
    },
  );

  server.registerTool(
    "discard",
    {
      description: "Discard uncommitted changes on a ref, resetting the worktree to the last commit.",
      inputSchema: {
        ref: z.string().describe("Ref/branch to discard changes on."),
      },
    },
    async (args) => {
      const res = await discard(ctx, { ref: args.ref });
      return toToolResult(res);
    },
  );

  server.registerTool(
    "push",
    {
      description:
        "Push unpushed commits on a ref to the remote. Optionally open/update a PR if this is a branch (not the protected ref).",
      inputSchema: {
        ref: z.string().describe("Ref/branch to push."),
        prTitle: z.string().optional().describe("PR title (only when creating a PR)."),
        prBody: z.string().optional().describe("PR body (only when creating a PR)."),
      },
    },
    async (args) => {
      const res = await push(ctx, {
        ref: args.ref,
        ...(args.prTitle || args.prBody
          ? { pr: { ...(args.prTitle ? { title: args.prTitle } : {}), ...(args.prBody ? { body: args.prBody } : {}) } }
          : {}),
      });
      return toToolResult(res);
    },
  );

  server.registerTool(
    "pull",
    {
      description: "Pull the latest changes from the remote for a ref into the local worktree.",
      inputSchema: {
        ref: z.string().describe("Ref/branch to pull."),
      },
    },
    async (args) => {
      const res = await pull(ctx, { ref: args.ref });
      return toToolResult(res);
    },
  );

  server.registerTool(
    "merge",
    {
      description:
        "Merge a branch back into the protected ref (e.g. `main`). On GitHub remote this creates/squashes a PR; on local dev it falls back to a local merge. Returns the PR number/url when available.",
      inputSchema: {
        ref: z.string().describe("Branch to merge into the protected ref."),
        message: z.string().optional().describe("Optional PR comment / merge message."),
      },
    },
    async (args) => {
      const res = await merge(ctx, { ref: args.ref, message: args.message });
      return toToolResult(res);
    },
  );

  server.registerTool(
    "create_pr",
    {
      description:
        "Create a PR from a branch into the protected ref (e.g. `main`). Returns the PR number/url. If a PR already exists it is returned unchanged.",
      inputSchema: {
        ref: z.string().describe("Branch to create a PR from."),
        title: z.string().optional().describe("PR title (defaults to a generated one)."),
        body: z.string().optional().describe("PR body (defaults to a generated one)."),
      },
    },
    async (args) => {
      const res = await createPr(ctx, { ref: args.ref, title: args.title, body: args.body });
      return toToolResult(res);
    },
  );

  server.registerTool(
    "find_pr",
    {
      description:
        "Find an existing PR for a branch into the protected ref (e.g. `main`). Returns null if none exists.",
      inputSchema: {
        ref: z.string().describe("Branch to find a PR for."),
      },
    },
    async (args) => {
      const res = await findPr(ctx, { ref: args.ref });
      return toToolResult(res);
    },
  );

  // ── preview sharing ─────────────────────────────────────────────────────

  server.registerTool(
    "create_preview_token",
    {
      description:
        "Generate a short-lived, read-only preview link for a branch that can be shared with anyone (no account needed). The link is scoped to the branch — visitors see only that branch's content. Multiple people can open the same link.",
      inputSchema: {
        branch: z.string().describe("Branch to share a preview for."),
      },
    },
    async (args) => {
      try {
        const result = await createPreviewTokenOp({
          auth: serverCtx.auth as never,
          db: client._.db,
          editor: { id: auth.userId, email: auth.email, isAnonymous: false },
          branch: args.branch,
          origin: serverCtx.origin,
          previewPath: serverCtx.previewPath,
        });
        return textResult(result);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  );

  return server;
}

/**
 * Handle one MCP HTTP request for an already-authenticated caller. Creates a
 * fresh stateless transport + server, connects them, and returns the fetch
 * `Response`. Cleans up on stream close.
 *
 * @param authorize The per-action authorizer gate. The route layer passes this
 *   through so the MCP tools run through the same authz gate as the HTTP API.
 * @param serverCtx Extra context the preview-token tool needs (origin, previewPath, auth).
 */
export async function handleMcpRequest(
  req: Request,
  client: WildwoodClient,
  auth: McpAuthContext,
  authorize: McpAuthorizeFn,
  serverCtx: McpServerContext,
): Promise<Response> {
  const server = buildWildwoodMcpServer(client, auth, authorize, serverCtx);
  const transport = new WebStandardStreamableHTTPServerTransport({
    // Stateless mode — one server/transport per request.
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    // Best-effort teardown; stateless transports don't persist.
    void server.close().catch(() => {});
  }
}
