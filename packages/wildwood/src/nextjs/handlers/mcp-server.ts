/**
 * `wildwood/nextjs/handlers/mcp-server`
 *
 * Model Context Protocol (MCP) server exposing the Wildwood client as tools so
 * a coding agent can read and write content given only a URL — no static
 * credentials. Auth is handled one layer up (`route.ts` wraps this in the
 * `@better-auth/oauth-provider` `mcpHandler`, which performs the OAuth 2.1
 * bearer-token check and 401 discovery handshake). By the time a request
 * reaches here it is already authenticated; the verified JWT (its `sub` is the
 * user id) is threaded in so tools can attribute writes and, later, gate on
 * authz.
 *
 * Transport: `WebStandardStreamableHTTPServerTransport` — a fetch-native
 * (`Request` → `Response`) Streamable HTTP transport, run in stateless mode
 * (no `sessionIdGenerator`): each POST spins up a fresh server+transport, which
 * is the simplest correct shape for a serverless/edge Next.js route and matches
 * how the MCP spec allows stateless JSON-RPC over HTTP.
 *
 * Tools are intentionally minimal (read: list/get/blob, write: commit/branch)
 * and delegate straight to the existing client + git surface so there is one
 * source of truth for behavior.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type { WildwoodClient } from "@/client/index";

/** The verified caller identity, derived from the OAuth access-token JWT. */
export type McpAuthContext = {
  /** JWT `sub` — the better-auth user id. */
  userId: string;
  /** JWT `email` claim when present (informational; may be absent). */
  email?: string | undefined;
  /** Granted scopes, space-split from the token's `scope` claim. */
  scopes: string[];
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

/**
 * Build an `McpServer` wired to a Wildwood client for one authenticated caller.
 * A new server is created per request (stateless transport), so `auth` is fresh
 * each time and never shared across callers.
 */
export function buildWildwoodMcpServer(client: WildwoodClient, auth: McpAuthContext): McpServer {
  const server = new McpServer({
    name: "wildwood",
    version: "0.1.0",
  });

  const git = client._.git;
  const collections = Object.keys(client._.config.configObject.collections ?? {});

  // ── read ────────────────────────────────────────────────────────────────

  server.registerTool(
    "list_collections",
    {
      description:
        "List the content collections defined in this Wildwood project. Returns collection names usable as the `collection` argument to other tools.",
      inputSchema: {},
    },
    async () => textResult({ collections }),
  );

  server.registerTool(
    "find_many",
    {
      description:
        "List entries in a collection. Returns the collection name, the resolved commit oid, and the matched items.",
      inputSchema: {
        collection: z.string().describe("Collection name (see list_collections)."),
        ref: z.string().optional().describe("Git ref/branch to read. Defaults to the configured ref."),
        limit: z.number().int().positive().optional().describe("Max items to return."),
        offset: z.number().int().nonnegative().optional().describe("Items to skip."),
      },
    },
    async ({ collection, ref, limit, offset }) => {
      const coll = (client as Record<string, unknown>)[collection] as
        | { findMany: (a: unknown) => Promise<unknown> }
        | undefined;
      if (!coll?.findMany) return errorResult(`Unknown collection: ${collection}`);
      try {
        const res = await coll.findMany({
          ...(ref ? { ref } : {}),
          ...(limit ? { limit } : {}),
          ...(offset ? { offset } : {}),
        });
        return textResult(res);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "find_first",
    {
      description: "Fetch a single entry from a collection, optionally filtered by a `where` clause.",
      inputSchema: {
        collection: z.string().describe("Collection name (see list_collections)."),
        where: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Filter object, e.g. { _sys: { relativePath: 'foo.md' } }."),
        ref: z.string().optional().describe("Git ref/branch to read. Defaults to the configured ref."),
      },
    },
    async ({ collection, where, ref }) => {
      const coll = (client as Record<string, unknown>)[collection] as
        | { findFirst: (a: unknown) => Promise<unknown> }
        | undefined;
      if (!coll?.findFirst) return errorResult(`Unknown collection: ${collection}`);
      try {
        const res = await coll.findFirst({
          ...(where ? { where } : {}),
          ...(ref ? { ref } : {}),
        });
        return textResult(res);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
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
    async ({ oid }) => {
      try {
        const blob = await git.getBlob(oid);
        if (!blob) return errorResult(`Blob not found: ${oid}`);
        return textResult(blob);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  );

  // ── write ─────────────────────────────────────────────────────────────

  server.registerTool(
    "create_branch",
    {
      description: "Create a new branch from a base ref.",
      inputSchema: {
        name: z.string().describe("New branch name."),
        base: z.string().describe("Base ref to branch from."),
      },
    },
    async ({ name, base }) => {
      try {
        const res = await git.createBranch({ name, base });
        return textResult(res ?? { ref: name, base });
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "switch_branch",
    {
      description: "Switch (materialize) the worktree to a given ref so subsequent reads/writes target it.",
      inputSchema: {
        ref: z.string().describe("Ref/branch to switch to."),
      },
    },
    async ({ ref }) => {
      try {
        const res = await git.switch({ ref });
        return textResult(res ?? { ref });
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "add_files",
    {
      description:
        "Stage file contents into the worktree for a ref (does not commit). Provide a map of repo-relative path -> file contents.",
      inputSchema: {
        ref: z.string().describe("Ref/branch to write to."),
        files: z
          .record(z.string(), z.string())
          .describe("Map of repo-relative path to UTF-8 file contents."),
      },
    },
    async ({ ref, files }) => {
      try {
        const res = await git.add({ ref, files });
        return textResult(res);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "commit",
    {
      description:
        "Create a commit on a ref with the currently staged worktree tree. The commit is attributed to the authenticated MCP user.",
      inputSchema: {
        ref: z.string().describe("Ref/branch to commit on."),
        message: z.string().describe("Commit message."),
      },
    },
    async ({ ref, message }) => {
      try {
        const res = await git.commit({
          ref,
          commit: {
            message,
            author: {
              name: auth.email ?? auth.userId,
              email: auth.email ?? `${auth.userId}@users.noreply.wildwood`,
            },
          },
        });
        return textResult(res);
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
 */
export async function handleMcpRequest(
  req: Request,
  client: WildwoodClient,
  auth: McpAuthContext,
): Promise<Response> {
  const server = buildWildwoodMcpServer(client, auth);
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
