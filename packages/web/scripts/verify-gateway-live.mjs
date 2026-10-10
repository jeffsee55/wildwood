/** Explicit live-key smoke test: isolated SQL content, real Gateway, ordinary authorized MCP. */
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { createContent, collection, markdown, libsql } from "wildwood-core";
import { z } from "zod";
import { createWeb } from "../dist/server.mjs";
import { createFxAgent } from "libfx/node";
import { createMcpAdapter } from "libfx/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker-provider.js";

if (!process.env.AI_GATEWAY_API_KEY) throw new Error("AI_GATEWAY_API_KEY is required.");
const origin = "http://localhost:9999";
const sql = createClient({ url: ":memory:" });
let agent;
let client;
try {
  const database = libsql(sql);
  const engine = createContent({
    database,
    repository: "gateway-live-smoke",
    version: "1",
    collections: {
      pages: collection({
        match: "pages/*.md",
        parse: markdown(z.object({ title: z.string(), body: z.string() })),
      }),
    },
  });
  await engine.branch("main");
  await engine.apply({
    ref: "main",
    expectedRevision: 0,
    idempotencyKey: "seed",
    changes: [
      { path: "pages/start.md", content: "---\ntitle: Gateway test\n---\nOriginal body.\n" },
    ],
  });
  const web = createWeb({
    database,
    engines: { 1: engine },
    version: "1",
    ref: "main",
    origin,
    development: true,
    agent: { apiKey: process.env.AI_GATEWAY_API_KEY },
  });
  const login = await web.handler(
    new Request(`${origin}/cms/local-login`, { method: "POST", headers: { origin } }),
  );
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const headers = { origin, cookie, "content-type": "application/json" };
  const configuration = await (
    await web.handler(new Request(`${origin}/cms/agent/config`, { headers }))
  ).json();
  assert.equal(configuration.siteKey, true);
  assert.ok(!JSON.stringify(configuration).includes(process.env.AI_GATEWAY_API_KEY));
  const connectionResponse = await web.handler(
    new Request(`${origin}/cms/agent/start`, {
      method: "POST",
      headers,
      body: JSON.stringify({ session: crypto.randomUUID() }),
    }),
  );
  assert.equal(connectionResponse.status, 200);
  const connection = await connectionResponse.json();
  client = new Client(
    { name: "wildwood-live-smoke", version: "1" },
    { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(connection.endpoint), {
      requestInit: { headers: { authorization: `Bearer ${connection.token}` } },
      fetch: (input, init) => web.handler(new Request(input, init)),
    }),
  );
  const adapter = await createMcpAdapter(client);
  const completed = new Set();
  agent = await createFxAgent({
    apiKey: "proxied-by-wildwood",
    model: process.env.FX_MODEL ?? "anthropic/claude-sonnet-4.5",
    backend: "native",
    instructions: `You are testing an isolated content draft. Use only the supplied MCP tools. Discover schemas and read files/revisions before editing. Use unique command keys for writes. You cannot publish. ${adapter.instructions}`,
    tools: adapter.tools.map((tool) => ({
      ...tool,
      execute: async (input, context) => {
        const result = await tool.execute(input, context);
        if (!result?.isError) completed.add(tool.name);
        console.log(`MCP ${tool.name}`);
        return result;
      },
    })),
    fetch: async (input, init) => {
      const target = input instanceof Request ? input.url : String(input);
      const proxied = new Headers(init?.headers);
      proxied.delete("authorization");
      proxied.set("origin", origin);
      proxied.set("cookie", cookie);
      proxied.set("sec-fetch-site", "same-origin");
      const response = await web.handler(
        new Request(`${origin}/cms/agent/gateway?target=${encodeURIComponent(target)}`, {
          ...init,
          headers: proxied,
        }),
      );
      console.log(`Gateway ${new URL(target).pathname}: ${response.status}`);
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        console.error(error.error ?? "Gateway request failed");
        throw new Error(`Authenticated Gateway proxy rejected request (${response.status}).`);
      }
      return response;
    },
  });
  const turn = agent.prompt(
    `On your current draft, discover and read pages/start.md. Replace its body with exactly 'Verified live AI Gateway and MCP.' preserving the title. Validate the draft, then submit it for review. Do not publish.`,
    { signal: AbortSignal.timeout(150_000) },
  );
  for await (const event of turn)
    if (event.type === "tool_start") console.log(`Calling ${event.name}`);
  const result = await turn.result;
  assert.equal(result.stopReason, "end_turn");
  assert.ok(completed.has("submit_review"), "Model must submit review through real MCP.");
  const draftFiles = await engine.files((await engine.ref(connection.ref)).snapshot);
  const changed = draftFiles.find((file) => file.path === "pages/start.md");
  assert.match(
    new TextDecoder().decode(await engine.bytes(changed.blob)),
    /Verified live AI Gateway and MCP/,
  );
  const publishedFiles = await engine.files((await engine.ref("main")).snapshot);
  const published = publishedFiles.find((file) => file.path === "pages/start.md");
  assert.match(new TextDecoder().decode(await engine.bytes(published.blob)), /Original body/);
  console.log(
    JSON.stringify({
      gateway: "passed",
      serverKey: "passed",
      mcpEdit: "passed",
      review: "passed",
      publishedUnchanged: "passed",
    }),
  );
} catch (error) {
  console.error(`Live Gateway verification failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await agent?.close();
  await client?.close();
  sql.close();
}
