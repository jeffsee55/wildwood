import { createServer } from "node:http";
import { randomBytes, randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { once } from "node:events";
import { createRemoteJWKSet, jwtVerify } from "jose";

const issuer = "https://auth.openai.com";
const resource = "https://api.openai.com/v1";
const tokenEndpoint = `${issuer}/api/accounts/oauth/token`;
const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
const secret = () => randomBytes(32).toString("base64url");
const equal = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Tokens deliberately live in this process only, never in browser or Vercel storage. */
export function companion({
  origin,
  hostId,
  pairing = secret(),
  port = 1455,
  fetcher = fetch,
  registration,
  saveRegistration = async () => {},
}) {
  const redirect = `http://127.0.0.1:${port}/auth/callback`;
  let attempt;
  let account;
  let refresh;
  let loginError;
  let busy = false;
  let generation = 0;
  const controllers = new Set();
  const clear = () => {
    generation++;
    for (const controller of controllers) controller.abort();
    account = undefined;
    attempt = undefined;
  };
  async function token(body) {
    const response = await fetcher(tokenEndpoint, {
      method: "POST",
      body: new URLSearchParams(body),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error("ChatGPT authorization failed. Sign in again.");
    const value = await response.json();
    if (
      typeof value.access_token !== "string" ||
      !value.access_token ||
      !Number.isFinite(value.expires_in) ||
      value.expires_in <= 0 ||
      String(value.token_type).toLowerCase() !== "bearer"
    )
      throw new Error("Invalid token response.");
    return value;
  }
  async function credential() {
    if (!account) throw new Error("Continue with ChatGPT first.");
    if (account.expires > Date.now() + 60_000) return account;
    if (!refresh) {
      const previous = account;
      const current = generation;
      refresh = (async () => {
        const next = await token({
          grant_type: "refresh_token",
          client_id: previous.client,
          refresh_token: previous.refresh,
          resource,
        });
        if (current !== generation) throw new Error("ChatGPT disconnected.");
        const scopes = next.scope ?? previous.scope;
        if (!scopes.split(" ").includes("chatgpt.tokens.use.direct"))
          throw new Error("ChatGPT plan permission is missing.");
        account = {
          ...previous,
          access: next.access_token,
          refresh: next.refresh_token ?? previous.refresh,
          scope: scopes,
          expires: Date.now() + next.expires_in * 1000,
        };
        return account;
      })()
        .catch((error) => {
          if (current === generation) clear();
          throw error;
        })
        .finally(() => {
          refresh = undefined;
        });
    }
    return refresh;
  }
  async function body(req) {
    let size = 0;
    const parts = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) throw new Error("Request too large.");
      parts.push(chunk);
    }
    return JSON.parse(Buffer.concat(parts).toString() || "{}");
  }
  function json(res, data, status = 200) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  }
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    if (req.headers.host !== `127.0.0.1:${port}`) return json(res, { error: "Invalid host" }, 403);
    const url = new URL(req.url, redirect);
    let callbackGeneration;
    try {
      if (url.pathname === "/auth/callback" && req.method === "GET") {
        const pending = attempt;
        if (
          !pending ||
          pending.expires < Date.now() ||
          !equal(url.searchParams.get("state"), pending.state)
        )
          return json(
            res,
            { error: "Sign-in expired or invalid state. Start again in Wildwood." },
            400,
          );
        attempt = undefined;
        callbackGeneration = pending.generation;
        if (url.searchParams.has("error")) throw new Error("ChatGPT sign-in was declined.");
        const client = url.searchParams.get("client_id") ?? pending.client;
        const code = url.searchParams.get("code");
        if (!client || client === "dynamic_agent_client" || !code)
          throw new Error("Incomplete registration.");
        if (pending.client && client !== pending.client)
          throw new Error("ChatGPT registration mismatch.");
        const next = await token({
          grant_type: "authorization_code",
          client_id: client,
          code,
          code_verifier: pending.verifier,
          redirect_uri: redirect,
          resource,
        });
        const { payload } = await jwtVerify(next.id_token, jwks, {
          issuer,
          audience: client,
          algorithms: ["RS256", "ES256"],
          requiredClaims: ["sub", "exp", "iat"],
        });
        if (payload.nonce !== pending.nonce || !payload.sub)
          throw new Error("Invalid sign-in identity.");
        if (registration && payload.sub !== registration.subject)
          throw new Error("Sign in with the registered ChatGPT account.");
        if (!next.scope?.split(" ").includes("chatgpt.tokens.use.direct") || !next.refresh_token)
          throw new Error("Enable ChatGPT plan usage during sign-in.");
        if (pending.generation !== generation) throw new Error("Sign-in cancelled.");
        registration = { client, subject: payload.sub };
        await saveRegistration(registration);
        if (pending.generation !== generation) throw new Error("Sign-in cancelled.");
        account = {
          client,
          access: next.access_token,
          refresh: next.refresh_token,
          scope: next.scope,
          email: payload.email ?? "ChatGPT account",
          expires: Date.now() + next.expires_in * 1000,
        };
        loginError = undefined;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end(
          "Connected to Wildwood. Return to your agent tab. Credentials remain in the local companion's memory.",
        );
        return;
      }
      if (req.headers.origin !== origin) return json(res, { error: "Origin rejected" }, 403);
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      if (req.method === "OPTIONS") {
        res.setHeader("Access-Control-Allow-Methods", "GET, POST");
        res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
        res.setHeader("Access-Control-Allow-Private-Network", "true");
        res.writeHead(204);
        res.end();
        return;
      }
      if (!equal(req.headers.authorization, `Bearer ${pairing}`))
        return json(res, { error: "Invalid companion pairing code" }, 401);
      if (url.pathname === "/status" && req.method === "GET")
        return json(res, { connected: !!account, email: account?.email, error: loginError });
      if (url.pathname === "/cancel-login" && req.method === "POST") {
        generation++;
        attempt = undefined;
        return json(res, { cancelled: true });
      }
      if (url.pathname === "/login" && req.method === "POST") {
        if (attempt?.expires < Date.now()) attempt = undefined;
        if (busy || attempt)
          return json(res, { error: "A session or sign-in is already active." }, 409);
        clear();
        loginError = undefined;
        attempt = {
          state: secret(),
          nonce: secret(),
          verifier: secret(),
          expires: Date.now() + 10 * 60_000,
          generation,
          client: registration?.client,
        };
        const authorization = new URL(`${issuer}/api/accounts/authorize`);
        authorization.search = new URLSearchParams({
          client_id: registration?.client ?? "dynamic_agent_client",
          ...(!registration ? { agent_name_hint: "Wildwood" } : {}),
          ext_agent_host_id: hostId,
          response_type: "code",
          redirect_uri: redirect,
          scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
          resource,
          state: attempt.state,
          nonce: attempt.nonce,
          code_challenge_method: "S256",
          code_challenge: createHash("sha256").update(attempt.verifier).digest("base64url"),
        }).toString();
        return json(res, { url: authorization.href });
      }
      if (url.pathname === "/disconnect" && req.method === "POST") {
        const previous = account;
        clear();
        loginError = undefined;
        let revoked = !previous;
        if (previous) {
          try {
            const metadata = await fetcher(`${issuer}/.well-known/openid-configuration`, {
              signal: AbortSignal.timeout(10_000),
            }).then((r) => r.json());
            const endpoint = new URL(metadata.revocation_endpoint);
            if (endpoint.origin !== issuer) throw new Error("Invalid revocation endpoint");
            revoked = (
              await fetcher(endpoint, {
                method: "POST",
                redirect: "error",
                signal: AbortSignal.timeout(10_000),
                body: new URLSearchParams({
                  token: previous.refresh,
                  token_type_hint: "refresh_token",
                  client_id: previous.client,
                }),
              })
            ).ok;
          } catch {
            revoked = false;
          }
        }
        return json(res, { disconnected: true, revoked });
      }
      if (url.pathname === "/models" && req.method === "GET") {
        const active = await credential();
        const upstream = await fetcher(`${resource}/models`, {
          headers: { authorization: `Bearer ${active.access}` },
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
        });
        if (!upstream.ok) throw new Error("Could not load your ChatGPT models.");
        const catalog = await upstream.json();
        return json(res, {
          models: (catalog.models ?? [])
            .filter((m) => m.visibility === "list")
            .map((m) => ({ id: m.slug, name: m.display_name })),
        });
      }
      if (url.pathname === "/responses" && req.method === "POST") {
        if (busy)
          return json(res, { error: "Another ChatGPT turn is running. Stop it first." }, 409);
        busy = true;
        const abort = new AbortController();
        controllers.add(abort);
        res.once("close", () => abort.abort());
        try {
          const input = await body(req);
          const active = await credential();
          const upstream = await fetcher(`${resource}/responses`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${active.access}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              model: input.model,
              instructions: input.instructions,
              input: input.input,
              tools: input.tools,
              store: false,
              stream: true,
              include: ["reasoning.encrypted_content"],
            }),
            redirect: "error",
            signal: AbortSignal.any([abort.signal, AbortSignal.timeout(180_000)]),
          });
          if (!upstream.ok) {
            await upstream.body?.cancel();
            return json(
              res,
              {
                error: `ChatGPT request failed (${upstream.status}). Check plan access or sign in again.`,
              },
              upstream.status,
            );
          }
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          for await (const chunk of upstream.body)
            if (!res.write(chunk)) await once(res, "drain", { signal: abort.signal });
          res.end();
        } finally {
          busy = false;
          controllers.delete(abort);
        }
        return;
      }
      json(res, { error: "Not found" }, 404);
    } catch (error) {
      if (url.pathname === "/auth/callback" && callbackGeneration === generation)
        loginError = error.message;
      if (!res.headersSent) json(res, { error: error.message }, 400);
      else res.destroy();
    }
  });
  return { server, pairing, clear };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const origin = new URL(process.env.WILDWOOD_ORIGIN ?? "https://wildwood-docs-bice.vercel.app")
    .origin;
  const directory = join(homedir(), ".config", "wildwood");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "chatgpt-host.json");
  let hostId;
  let registration;
  try {
    const saved = JSON.parse(await readFile(path, "utf8"));
    hostId = saved.hostId;
    registration = saved.registration;
  } catch {}
  if (!/^urn:uuid:[0-9a-f-]{36}$/.test(hostId ?? "")) {
    hostId = `urn:uuid:${randomUUID()}`;
    await writeFile(`${path}.tmp`, JSON.stringify({ hostId }), { mode: 0o600 });
    await rename(`${path}.tmp`, path);
  }
  const { server, pairing, clear } = companion({
    origin,
    hostId,
    registration,
    saveRegistration: async (value) => {
      await writeFile(`${path}.tmp`, JSON.stringify({ hostId, registration: value }), {
        mode: 0o600,
      });
      await rename(`${path}.tmp`, path);
    },
  });
  server.listen(1455, "127.0.0.1", () => {
    console.log(
      `Wildwood ChatGPT companion ready for ${origin}\nPairing code: ${pairing}\nEnter this code in the agent's ChatGPT settings. ChatGPT credentials stay in process memory.`,
    );
  });
  server.on("error", () => {
    console.error("Cannot start companion. Port 1455 may already be in use.");
    process.exitCode = 1;
  });
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => {
      clear();
      server.close();
    });
}
