import { test, expect } from "vitest";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { createContent, collection, markdown, libsql } from "wildwood-core";
import { z } from "zod";
import { createIdentity } from "../src/auth";
import { createWeb } from "../src/server";

test("real OAuth PKCE, consent, refresh, scoped draft tools and revocation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ww-oauth-"));
  const client = createClient({ url: `file:${join(dir, "test.db")}` });
  let web: ReturnType<typeof createWeb>;
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers))
        if (value) headers.set(key, Array.isArray(value) ? value.join(",") : value);
      const response = await web.handler(
        new Request(`${origin}${req.url}`, {
          method: req.method,
          headers,
          ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
        }),
      );
      res.writeHead(response.status, {
        ...Object.fromEntries(response.headers),
        "set-cookie": response.headers.getSetCookie(),
      });
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      res.writeHead(500);
      res.end(String(error));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const database = libsql(client);
    const engine = createContent({
      repository: "oauth",
      version: "1",
      database,
      collections: {
        docs: collection({
          match: "*.md",
          parse: markdown(z.object({ title: z.string(), body: z.string() })),
        }),
      },
    });
    await engine.branch("production");
    await engine.apply({
      ref: "production",
      expectedRevision: 0,
      idempotencyKey: "seed",
      changes: [{ path: "a.md", content: "---\ntitle: Original\n---\nBody" }],
    });
    const identity = createIdentity({
      client,
      origin,
      development: true,
      secret: "oauth-integration-test-secret-at-least-32-characters",
    });
    web = createWeb({
      database,
      engines: { "1": engine },
      version: "1",
      ref: "production",
      origin,
      identity,
      development: true,
    });
    const jar = new Map<string, string>();
    async function request(path: string, body?: unknown, authenticated = true) {
      const response = await fetch(new URL(path, origin), {
        method: body ? "POST" : "GET",
        redirect: "manual",
        headers: {
          origin,
          accept: "application/json",
          ...(body ? { "content-type": "application/json" } : {}),
          ...(authenticated ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (authenticated)
        for (const cookie of response.headers.getSetCookie()) {
          const [pair] = cookie.split(";");
          const i = pair.indexOf("=");
          jar.set(pair.slice(0, i), pair.slice(i + 1));
        }
      return response;
    }
    const resourceMetadata = await (
      await request("/.well-known/oauth-protected-resource/cms/mcp", undefined, false)
    ).json();
    expect(resourceMetadata.authorization_servers).toEqual([`${origin}/cms/auth`]);
    const authMetadata = await (
      await request("/.well-known/oauth-authorization-server/cms/auth", undefined, false)
    ).json();
    expect(authMetadata.code_challenge_methods_supported).toContain("S256");
    const register = await request(
      "/cms/auth/oauth2/register",
      {
        client_name: "Test harness",
        redirect_uris: ["http://127.0.0.1:54321/callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        scope: "content:read content:write drafts:create offline_access",
      },
      false,
    );
    expect(register.status, await register.clone().text()).toBe(201);
    const registration = await register.json();
    const verifier = "a".repeat(64);
    const query = new URLSearchParams({
      client_id: registration.client_id,
      redirect_uri: "http://127.0.0.1:54321/callback",
      response_type: "code",
      scope: "content:read content:write drafts:create offline_access",
      resource: `${origin}/cms/mcp`,
      state: "test-state",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    });
    const auth = await request(`/cms/auth/oauth2/authorize?${query}`);
    const authBody = await auth.clone().text();
    const signin = auth.headers.get("location") ?? JSON.parse(authBody).url;
    expect(signin, authBody).toContain("/cms/sign-in");
    const signed = new URL(signin, origin).searchParams.toString();
    const login = await request("/cms/auth/sign-in/local", { oauth_query: signed });
    const loginData = await login.json();
    expect(login.status, JSON.stringify(loginData)).toBe(200);
    const consentUrl = loginData.url ?? loginData.redirect_uri;
    expect(consentUrl, JSON.stringify(loginData)).toContain("/cms/consent");
    const consentPage = await request(consentUrl);
    expect(await consentPage.text()).toContain("Create drafts");
    const tampered = new URL(consentUrl, origin).searchParams;
    tampered.set("client_id", "different-client");
    const rejected = await request("/cms/auth/oauth2/consent", {
      accept: true,
      scope: "content:read content:write drafts:create offline_access",
      oauth_query: tampered.toString(),
    });
    expect(rejected.status).toBe(400);
    expect(
      (await database.execute("SELECT id FROM ww_web_records WHERE kind='oauth-agent'")).rows,
    ).toHaveLength(0);
    const consent = await request("/cms/auth/oauth2/consent", {
      accept: true,
      scope: "content:read content:write drafts:create offline_access",
      oauth_query: new URL(consentUrl, origin).searchParams.toString(),
    });
    const consentData = await consent.json();
    expect(consent.status, JSON.stringify(consentData)).toBe(200);
    const callback = new URL(consentData.redirect_uri ?? consentData.url);
    expect(callback.searchParams.get("state")).toBe("test-state");
    const tokenRequest = (data: Record<string, string>) =>
      fetch(`${origin}/cms/auth/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(data),
      });
    const tokensResponse = await tokenRequest({
      grant_type: "authorization_code",
      client_id: registration.client_id,
      code: callback.searchParams.get("code")!,
      redirect_uri: "http://127.0.0.1:54321/callback",
      code_verifier: verifier,
      resource: `${origin}/cms/mcp`,
    });
    const tokens = await tokensResponse.json();
    expect(tokensResponse.status, JSON.stringify(tokens)).toBe(200);
    expect(tokens.refresh_token).toBeTruthy();
    async function mcp(token: string, name?: string, args = {}) {
      return fetch(`${origin}/cms/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: name ? "tools/call" : "tools/list",
          params: name ? { name, arguments: args } : {},
        }),
      });
    }
    const tools = await mcp(tokens.access_token);
    expect(tools.status, await tools.clone().text()).toBe(200);
    expect((await tools.json()).result.tools.map((t: { name: string }) => t.name)).toContain(
      "create_draft",
    );
    const created = await (
      await mcp(tokens.access_token, "create_draft", { command: "oauth-draft" })
    ).json();
    expect(created.result.isError, JSON.stringify(created)).not.toBe(true);
    const draft = JSON.parse(created.result.content[0].text);
    const refreshedResponse = await tokenRequest({
      grant_type: "refresh_token",
      client_id: registration.client_id,
      refresh_token: tokens.refresh_token,
      resource: `${origin}/cms/mcp`,
    });
    const refreshed = await refreshedResponse.json();
    expect(refreshedResponse.status, JSON.stringify(refreshed)).toBe(200);
    const write = await (
      await mcp(refreshed.access_token, "write_source", {
        draft: draft.draft,
        path: "a.md",
        source: "---\ntitle: OAuth edit\n---\nBody",
        revision: 0,
        command: "write",
      })
    ).json();
    expect(write.result.isError, JSON.stringify(write)).not.toBe(true);
    const reducedResponse = await tokenRequest({
      grant_type: "refresh_token",
      client_id: registration.client_id,
      refresh_token: refreshed.refresh_token,
      resource: `${origin}/cms/mcp`,
      scope: "content:read offline_access",
    });
    const reduced = await reducedResponse.json();
    expect(reducedResponse.status, JSON.stringify(reduced)).toBe(200);
    const readonlyTools = await (await mcp(reduced.access_token)).json();
    expect(readonlyTools.result.tools.map((t: { name: string }) => t.name)).not.toContain(
      "write_source",
    );
    expect(readonlyTools.result.tools.map((t: { name: string }) => t.name)).not.toContain(
      "create_draft",
    );
    const view = await web.view(
      new Headers({ cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") }),
    );
    const record = (
      await database.execute("SELECT id FROM ww_web_records WHERE kind='oauth-agent'")
    ).rows[0];
    await web.command(view, { type: "revoke", id: String(record.id) });
    expect((await mcp(refreshed.access_token)).status).toBe(403);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    client.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);
