/** Read-only production smoke check. Never logs tokens or provider credentials. */
import assert from "node:assert/strict";
const origin = new URL(process.argv[2] ?? "http://localhost:3000").origin;
async function read(path) {
  const response = await fetch(origin + path, {
    redirect: "manual",
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(response.status, 200, `${path}: HTTP ${response.status}`);
  return response;
}
const home = await read("/");
assert.match(await home.text(), /Your agent writes/);
const health = await (await read("/cms/health")).json();
assert.equal(health.database, "ready");
const resource = await (await read("/.well-known/oauth-protected-resource/cms/mcp")).json();
assert.equal(
  resource.resource,
  `${origin}/cms/mcp`,
  "MCP must advertise the canonical public origin",
);
const issuer = await (await read("/.well-known/oauth-authorization-server/cms/auth")).json();
assert.equal(issuer.issuer, `${origin}/cms/auth`);
assert.ok(issuer.code_challenge_methods_supported.includes("S256"));
assert.ok(issuer.grant_types_supported.includes("refresh_token"));
const unauthorized = await fetch(`${origin}/cms/mcp`, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
});
assert.equal(unauthorized.status, 401);
assert.ok(unauthorized.headers.get("www-authenticate")?.includes("resource_metadata"));
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname)) {
  const devLogin = await fetch(`${origin}/cms/local-login`, {
    method: "POST",
    headers: { origin },
    redirect: "manual",
  });
  assert.notEqual(devLogin.status, 303, "Production must not allow local sign-in");
}
console.log(
  JSON.stringify(
    {
      origin,
      homepage: "passed",
      database: "passed",
      discovery: "passed",
      pkce: "passed",
      refresh: "advertised",
      unauthorized: "rejected",
      authentication: health.authentication,
    },
    null,
    2,
  ),
);
if (health.authentication !== "configured") {
  console.error(
    "Hosted sign-in is not configured. Add the GitHub client ID and secret, then redeploy.",
  );
  process.exitCode = 1;
}
