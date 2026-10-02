import { test, expect, vi, afterEach } from "vitest";
import { gatewayResponse } from "../src/gateway";
afterEach(() => vi.unstubAllGlobals());
const request = (
  target = "https://ai-gateway.vercel.sh/v4/ai/language-model",
  headers: Record<string, string> = {},
) =>
  new Request(`https://cms.test/cms/agent/gateway?target=${encodeURIComponent(target)}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ prompt: [] }),
  });
test("Gateway keeps protocol headers and chooses the personal key without leaking application credentials", async () => {
  const fetcher = vi.fn().mockResolvedValue(
    new Response("data: hello\n\n", {
      headers: { "content-type": "text/event-stream", "set-cookie": "untrusted=yes" },
    }),
  );
  vi.stubGlobal("fetch", fetcher);
  const result = await gatewayResponse(
    request(undefined, {
      "x-wildwood-gateway-key": "personal",
      authorization: "Bearer cms-token",
      cookie: "session=private",
      "ai-language-model-id": "test/model",
      "ai-language-model-specification-version": "4",
    }),
    "site-key",
  );
  const options = fetcher.mock.calls[0][1];
  expect(Object.fromEntries(options.headers)).toEqual({
    authorization: "Bearer personal",
    "content-type": "application/json",
    "ai-language-model-id": "test/model",
    "ai-language-model-specification-version": "4",
  });
  expect(options.redirect).toBe("error");
  expect(await result.text()).toBe("data: hello\n\n");
  expect(result.headers.has("set-cookie")).toBe(false);
  expect(result.headers.get("cache-control")).toContain("no-store");
});
test("Gateway falls back to the server key and refuses arbitrary hosts, ports, credentials, paths and redirects", async () => {
  const fetcher = vi.fn().mockImplementation(() => Promise.resolve(Response.json({ ok: true })));
  vi.stubGlobal("fetch", fetcher);
  await gatewayResponse(request(), "site-key");
  expect(fetcher.mock.calls[0][1].headers.get("authorization")).toBe("Bearer site-key");
  for (const target of [
    "https://evil.test/v4/ai/language-model",
    "http://ai-gateway.vercel.sh/v4/ai/language-model",
    "https://ai-gateway.vercel.sh:444/v4/ai/language-model",
    "https://user:pass@ai-gateway.vercel.sh/v4/ai/language-model",
    "https://ai-gateway.vercel.sh/admin",
    "https://ai-gateway.vercel.sh/v4/ai/language-model?redirect=evil",
  ])
    expect((await gatewayResponse(request(target), "site-key")).status).toBe(400);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect((await gatewayResponse(request())).status).toBe(503);
});
test("Gateway bounds streamed requests and hides provider error bodies", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(new Response("sensitive upstream diagnostics", { status: 401 }));
  vi.stubGlobal("fetch", fetcher);
  const result = await gatewayResponse(request(), "site-key");
  expect(result.status).toBe(401);
  expect(await result.text()).not.toContain("sensitive");
  await expect(
    gatewayResponse(
      new Request(
        "https://cms.test/cms/agent/gateway?target=https://ai-gateway.vercel.sh/v4/ai/language-model",
        { method: "POST", body: "a".repeat(2 * 1024 * 1024 + 1) },
      ),
      "site-key",
    ),
  ).rejects.toThrow("exceeds");
  expect(fetcher).toHaveBeenCalledTimes(1);
});
