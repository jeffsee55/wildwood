import { test, expect } from "vitest";
import { createClient } from "@libsql/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIdentity } from "../src/auth";

test("identity initializes its own auth schema and serves OAuth discovery without the legacy CMS", async () => {
  const folder = await mkdtemp(join(tmpdir(), "wildwood-auth-"));
  const client = createClient({ url: `file:${join(folder, "auth.db")}` });
  try {
    const identity = createIdentity({
      client,
      origin: "http://localhost:9999",
      secret: "test-only-secret-with-at-least-thirty-two-characters",
    });
    await identity.ready();
    expect(await identity.user(new Headers())).toBeNull();
    const response = await identity.handler(
      new Request("http://localhost:9999/cms/auth/.well-known/oauth-authorization-server"),
    );
    expect(response.status).toBe(200);
    const metadata = await response.json();
    expect(metadata.issuer).toBe("http://localhost:9999/cms/auth");
    expect(metadata.token_endpoint).toContain("/cms/auth/");
  } finally {
    client.close();
    await rm(folder, { recursive: true, force: true });
  }
});

test("concurrent serverless workers converge on one auth schema", async () => {
  const folder = await mkdtemp(join(tmpdir(), "wildwood-auth-race-"));
  const path = join(folder, "auth.db");
  const clients = [createClient({ url: `file:${path}` }), createClient({ url: `file:${path}` })];
  try {
    const identities = clients.map((client) =>
      createIdentity({
        client,
        origin: "http://localhost:9999",
        secret: "test-only-secret-with-at-least-thirty-two-characters",
      }),
    );
    await Promise.all(identities.map((identity) => identity.ready()));
    await Promise.all(identities.map((identity) => identity.ready()));
    expect(await identities[0].user(new Headers())).toBeNull();
  } finally {
    clients.forEach((client) => client.close());
    await rm(folder, { recursive: true, force: true });
  }
});
