import { afterEach, expect, test, vi } from "vitest";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
const identity = vi.hoisted(() => ({ nonce: "", valid: true }));
vi.mock("jose", () => ({
  createRemoteJWKSet: () => ({}),
  jwtVerify: async () => {
    if (!identity.valid) throw new Error("Invalid signature");
    return { payload: { sub: "user", nonce: identity.nonce, email: "test@example.com" } };
  },
}));
import { companion } from "../scripts/chatgpt-companion.mjs";
const origin = "https://wildwood-docs-bice.vercel.app";
const port = 18455;
let server;
afterEach(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  server = undefined;
  identity.valid = true;
});
async function start(fetcher = vi.fn()) {
  const value = companion({ origin, port, hostId: "urn:uuid:host", pairing: "pairing", fetcher });
  server = value.server;
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  return (path, init = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      ...init,
      headers: { origin, authorization: "Bearer pairing", connection: "close", ...init.headers },
    });
}
test("companion rejects unpaired requests, other origins, and DNS rebinding hosts", async () => {
  const request = await start();
  expect((await request("/status", { headers: { origin: "https://evil.test" } })).status).toBe(403);
  expect((await request("/status", { headers: { authorization: "Bearer wrong" } })).status).toBe(
    401,
  );
  const rebound = await new Promise((resolve) => {
    httpRequest(
      `http://127.0.0.1:${port}/status`,
      { headers: { host: `evil.test:${port}`, origin, authorization: "Bearer pairing" } },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    ).end();
  });
  expect(rebound).toBe(403);
  const preflight = await request("/responses", { method: "OPTIONS" });
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get("access-control-allow-origin")).toBe(origin);
});
test("PKCE callback validates state and identity before making credentials available", async () => {
  const upstream = vi.fn(async () =>
    Response.json({
      access_token: "access-secret",
      refresh_token: "refresh-secret",
      id_token: "identity",
      token_type: "Bearer",
      expires_in: 3600,
      scope: "chatgpt.tokens.use.direct",
    }),
  );
  const request = await start(upstream);
  const login = await (await request("/login", { method: "POST" })).json();
  const authorization = new URL(login.url);
  expect(authorization.searchParams.get("client_id")).toBe("dynamic_agent_client");
  expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
  identity.nonce = authorization.searchParams.get("nonce");
  expect((await request("/auth/callback?state=wrong&code=x&client_id=oaiapp_test")).status).toBe(
    400,
  );
  expect(upstream).not.toHaveBeenCalled();
  const callback = `/auth/callback?state=${authorization.searchParams.get("state")}&code=x&client_id=oaiapp_test`;
  expect((await request(callback)).status).toBe(200);
  const status = await (await request("/status")).text();
  expect(status).toContain('"connected":true');
  expect(status).not.toContain("secret");
  expect(upstream.mock.calls[0][1].body.get("code_verifier")).toBeTruthy();
  expect((await request(callback)).status).toBe(400);
});
test("bad ID token signatures never activate an account", async () => {
  const request = await start(async () =>
    Response.json({
      access_token: "access",
      refresh_token: "refresh",
      id_token: "bad",
      token_type: "Bearer",
      expires_in: 3600,
      scope: "chatgpt.tokens.use.direct",
    }),
  );
  const login = new URL((await (await request("/login", { method: "POST" })).json()).url);
  identity.valid = false;
  const callback = await request(
    `/auth/callback?state=${login.searchParams.get("state")}&code=x&client_id=oaiapp_test`,
  );
  expect(callback.status).toBe(400);
  expect((await (await request("/status")).json()).connected).toBe(false);
});

test("cancelled sign-in rejects its old callback and allows a fresh attempt", async () => {
  const upstream = vi.fn();
  const request = await start(upstream);
  const login = new URL((await (await request("/login", { method: "POST" })).json()).url);
  await request("/cancel-login", { method: "POST" });
  expect(
    (
      await request(
        `/auth/callback?state=${login.searchParams.get("state")}&code=x&client_id=oaiapp_test`,
      )
    ).status,
  ).toBe(400);
  expect(upstream).not.toHaveBeenCalled();
  expect((await request("/login", { method: "POST" })).status).toBe(200);
});

test("inference sends only local credentials to the fixed public Responses endpoint", async () => {
  const upstream = vi.fn(async (url) =>
    String(url).endsWith("/oauth/token")
      ? Response.json({
          access_token: "access-secret",
          refresh_token: "refresh-secret",
          id_token: "identity",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "chatgpt.tokens.use.direct",
        })
      : new Response('data: {"type":"response.completed"}\n\n', {
          headers: { "content-type": "text/event-stream" },
        }),
  );
  const request = await start(upstream);
  const login = new URL((await (await request("/login", { method: "POST" })).json()).url);
  identity.nonce = login.searchParams.get("nonce");
  await request(
    `/auth/callback?state=${login.searchParams.get("state")}&code=x&client_id=oaiapp_test`,
  );
  const response = await request("/responses", {
    method: "POST",
    body: JSON.stringify({
      model: "account-model",
      input: [],
      store: true,
      stream: false,
      target: "https://evil.test",
    }),
  });
  expect(await response.text()).toContain("response.completed");
  expect(upstream.mock.calls.at(-1)[0]).toBe("https://api.openai.com/v1/responses");
  const forwarded = upstream.mock.calls.at(-1)[1];
  expect(forwarded.headers.authorization).toBe("Bearer access-secret");
  expect(forwarded.headers.origin).toBeUndefined();
  expect(forwarded.headers.cookie).toBeUndefined();
  expect(JSON.parse(forwarded.body)).toMatchObject({ store: false, stream: true });
  expect(forwarded.body).not.toContain("evil.test");
});
