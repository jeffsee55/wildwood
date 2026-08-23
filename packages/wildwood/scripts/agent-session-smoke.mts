import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readFile } from "node:fs/promises";

const baseUrl = process.env.WILDWOOD_BASE_URL ?? "http://localhost:3000";
const email = process.env.WILDWOOD_DEV_EMAIL ?? "owner@wildwood.com";
const password = process.env.WILDWOOD_DEV_PASSWORD ?? "wildwood-dev-password";
const name = process.env.WILDWOOD_DEV_NAME ?? "Wildwood Owner";
const waitForApproval = process.env.WILDWOOD_WAIT_FOR_APPROVAL === "1";
const autoApprove = process.env.WILDWOOD_AUTO_APPROVE === "1";
const requestMerge = process.env.WILDWOOD_REQUEST_MERGE !== "0";
const homeTitle = process.env.WILDWOOD_HOME_TITLE?.trim();
const existingRef = process.env.WILDWOOD_REF?.trim();
const skipCommit = process.env.WILDWOOD_SKIP_COMMIT === "1";

async function post(path: string, body: unknown, cookie?: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: baseUrl,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function responseError(response: Response): Promise<Error> {
  return new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
}

function sessionCookie(response: Response): string {
  const values = (
    response.headers as Headers & { getSetCookie?: () => string[] }
  ).getSetCookie?.() ?? [response.headers.get("set-cookie") ?? ""];
  return values
    .filter(Boolean)
    .map((value) => value.split(";", 1)[0])
    .join("; ");
}

async function signIn(): Promise<string> {
  let response = await post("/api/auth/sign-in/email", { email, password });
  if (!response.ok) {
    const created = await post("/api/auth/sign-up/email", { email, password, name });
    if (!created.ok) throw await responseError(created);
    response = await post("/api/auth/sign-in/email", { email, password });
  }
  if (!response.ok) throw await responseError(response);
  const cookie = sessionCookie(response);
  if (!cookie) throw new Error("Better Auth did not return a session cookie");
  return cookie;
}

function toolText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content ?? [])
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

const cookie = await signIn();
let ref = existingRef;
if (!ref) {
  const branchResponse = await post(
    "/api/wildwood/git/create-branch",
    {
      // Managed auth deliberately ignores this caller-controlled value.
      name: "users/agent-should-not-control-this/real-session",
      baseRef: "main",
    },
    cookie,
  );
  if (!branchResponse.ok) throw await responseError(branchResponse);
  ({ ref } = (await branchResponse.json()) as { ref: string });
}

const sessionResponse = await post(
  "/api/wildwood/access/agent",
  {
    ref,
    permissions: ["content.read", "content.write", "merge.request"],
    ttlSeconds: 15 * 60,
  },
  cookie,
);
if (!sessionResponse.ok) throw await responseError(sessionResponse);
const session = (await sessionResponse.json()) as {
  agentId: string;
  token: string;
  expiresAt: string;
  mcp: string;
};

console.log(`Issued branch: ${ref}`);
console.log(`Agent: ${session.agentId}`);
console.log(`Credential: ${session.token.slice(0, 12)}…${session.token.slice(-4)}`);
console.log(`Expires: ${session.expiresAt}`);

const client = new Client({ name: "wildwood-real-agent-smoke", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}${session.mcp}`), {
  requestInit: { headers: { authorization: `Bearer ${session.token}` } },
});

try {
  await client.connect(transport);
  const listed = await client.listTools();
  console.log(`MCP connected: ${listed.tools.length} tools`);

  if (!skipCommit) {
    const path = homeTitle ? "content/nav/index.json" : `content/docs/agent-session-${ref}.md`;
    const file = homeTitle
      ? `${JSON.stringify(
          {
            ...JSON.parse(
              await readFile(new URL("../../../content/nav/index.json", import.meta.url), "utf8"),
            ),
            title: homeTitle,
          },
          null,
          2,
        )}\n`
      : [
          "---",
          `title: Agent session ${ref}`,
          "description: Written through an exact-ref Wildwood agent credential.",
          "---",
          "",
          `This page was committed by a short-lived agent session scoped to \`${ref}\`.`,
          "",
        ].join("\n");
    const committed = await client.callTool({
      name: "add_and_commit",
      arguments: {
        ref,
        message: homeTitle
          ? `Set homepage title to ${homeTitle}`
          : `Agent session smoke test on ${ref}`,
        files: { [path]: file },
      },
    });
    console.log(`Commit (isError=${Boolean(committed.isError)}): ${toolText(committed)}`);
  }

  const escaped = await client.callTool({
    name: "find_many",
    arguments: { collection: "docs", ref: "main", limit: 1 },
  });
  console.log(`Cross-ref read (isError=${Boolean(escaped.isError)}): ${toolText(escaped)}`);

  if (requestMerge) {
    const merge = await client.callTool({
      name: "merge",
      arguments: {
        ref,
        message: "Approve this exact agent branch for the smoke test",
      },
    });
    console.log(`Merge attempt (isError=${Boolean(merge.isError)}): ${toolText(merge)}`);

    const approvalRequired = merge.isError && toolText(merge).includes("approval_required");
    if (approvalRequired && autoApprove) {
      const approval = JSON.parse(toolText(merge)) as { approvalId: string };
      const decision = await post(
        `/api/wildwood/access/approvals/${encodeURIComponent(approval.approvalId)}`,
        { decision: "approve" },
        cookie,
      );
      if (!decision.ok) throw await responseError(decision);
      console.log(`Approved: ${approval.approvalId}`);
    } else if (approvalRequired && waitForApproval) {
      console.log("Waiting for approval; press Enter to retry with this same agent credential.");
      await new Promise<void>((resolve) => process.stdin.once("data", () => resolve()));
    }

    if (approvalRequired && (autoApprove || waitForApproval)) {
      const retried = await client.callTool({
        name: "merge",
        arguments: {
          ref,
          message: "Approved exact-commit agent merge smoke test",
        },
      });
      console.log(`Merge retry (isError=${Boolean(retried.isError)}): ${toolText(retried)}`);
    }
  }
} finally {
  await client.close();
}
