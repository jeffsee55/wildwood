// Local browser integration fixture. Never imported by application code.
// NODE_OPTIONS="--import=/absolute/path/to/this/file" pnpm --filter docs next:dev
if (process.env.NODE_ENV === "production" || process.env.VERCEL)
  throw new Error("The fixture must never run in production");
const realFetch = globalThis.fetch;
const encoder = new TextEncoder();
const finish = (reason) => ({
  type: "finish",
  finishReason: { unified: reason, raw: reason },
  usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } },
});
const sse = (events) =>
  new Response(
    new ReadableStream({
      async start(controller) {
        for (const event of events) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          await new Promise((r) => setTimeout(r, 30));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
const call = (name, input) =>
  sse([
    { type: "tool-call", toolCallId: crypto.randomUUID(), toolName: name, input },
    finish("tool-calls"),
  ]);
globalThis.fetch = async (url, init = {}) => {
  if (new URL(String(url?.url ?? url)).origin !== "https://ai-gateway.vercel.sh")
    return realFetch(url, init);
  if (init.method === "GET")
    return Response.json({ data: [{ id: "fixture/model", type: "language", tags: ["tool-use"] }] });
  if (new Headers(init.headers).get("ai-language-model-id") !== "fixture/model")
    return Response.json(
      { error: "Select fixture/model for local integration testing" },
      { status: 400 },
    );
  const { prompt } = JSON.parse(
    typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body),
  );
  const last = prompt.findLastIndex((m) => m.role === "user");
  const results = prompt
    .slice(last + 1)
    .filter((m) => m.role === "tool")
    .flatMap((m) => m.content)
    .filter((p) => p.type === "tool-result");
  const value = (name) => {
    const p = results.findLast((p) => p.toolName === name);
    if (!p) return null;
    try {
      return JSON.parse(p.output.value);
    } catch {
      return null;
    }
  };
  if (!results.length) return call("discover_content", {});
  if (!value("read_source")) return call("read_source", { path: "content/pages/introduction.md" });
  if (!value("apply_changes")) {
    const source = value("read_source");
    return call("apply_changes", {
      revision: source.revision,
      command: crypto.randomUUID(),
      changes: [
        {
          path: source.path,
          source: source.source + "\n\nA browser agent made this isolated test edit.\n",
        },
      ],
    });
  }
  if (!value("validate_content")) return call("validate_content", {});
  if (!value("submit_review")) return call("submit_review", {});
  return sse([
    {
      type: "text-delta",
      id: "answer",
      delta: `Updated the introduction in the isolated draft and validated it. [Review the changes](${value("submit_review").url}). Published content was unchanged. (Local fixture model.)`,
    },
    finish("stop"),
  ]);
};
