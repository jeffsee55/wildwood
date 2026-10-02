import { readBody } from "./http";

/** A deliberately narrow transport for libfx. Never forward cookies or arbitrary targets. */
export async function gatewayResponse(request: Request, siteKey?: string): Promise<Response> {
  const target = new URL(new URL(request.url).searchParams.get("target") ?? "https://invalid");
  const catalog = target.pathname === "/coding-agent/v1/models";
  if (
    target.origin !== "https://ai-gateway.vercel.sh" ||
    target.username ||
    target.password ||
    target.search ||
    target.hash ||
    !(catalog
      ? request.method === "GET"
      : request.method === "POST" &&
        ["/v3/ai/language-model", "/v4/ai/language-model"].includes(target.pathname))
  )
    return Response.json({ error: "Unsupported Gateway request" }, { status: 400 });
  const personal = request.headers.get("x-wildwood-gateway-key");
  const key = personal || siteKey;
  if (!key)
    return Response.json({ error: "Add your AI Gateway key to start a session." }, { status: 503 });
  if (key.length > 4096 || /[\r\n]/.test(key))
    return Response.json({ error: "Invalid Gateway key" }, { status: 400 });
  const body = catalog ? undefined : new Uint8Array(await readBody(request, 2 * 1024 * 1024));
  const headers = new Headers({
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
  });
  for (const name of [
    "ai-gateway-protocol-version",
    "ai-language-model-id",
    "ai-language-model-specification-version",
    "ai-language-model-streaming",
    "x-session-affinity",
    "x-session-id",
  ]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const upstream = await fetch(target, {
    method: request.method,
    headers,
    body,
    redirect: "error",
    signal: AbortSignal.any([request.signal, AbortSignal.timeout(55_000)]),
  });
  if (!upstream.ok) {
    await upstream.body?.cancel();
    return Response.json(
      {
        error:
          upstream.status === 401 || upstream.status === 403
            ? "AI Gateway rejected this key. Check its access and try again."
            : `AI Gateway request failed (${upstream.status}).`,
      },
      { status: upstream.status, headers: { "Cache-Control": "private, no-store" } },
    );
  }
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "Content-Type": upstream.headers.get("content-type") ?? "application/json",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
