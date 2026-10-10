import { afterEach, expect, test, vi } from "vitest";
import { createChatGPTAgent, responseEvents } from "../browser/agent/chatgpt";

afterEach(() => vi.unstubAllGlobals());
const stream = (events: unknown[]) =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(""));
const completion = (output: unknown[]) => ({
  type: "response.completed",
  response: { output, usage: { input_tokens: 3, output_tokens: 2 } },
});

test("ChatGPT runs MCP tools and resumes their results without persisting pairing credentials", async () => {
  const execute = vi.fn(async () => ({ saved: true }));
  const calls: Record<string, unknown>[] = [];
  const transport = vi.fn(async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return calls.length === 1
      ? stream([
          completion([
            {
              type: "function_call",
              name: "write_file",
              call_id: "call-1",
              arguments: '{"path":"a.md"}',
            },
          ]),
        ])
      : stream([
          { type: "response.output_text.delta", delta: "Saved" },
          completion([
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Saved" }],
            },
          ]),
        ]);
  });
  vi.stubGlobal("fetch", transport);
  const options = {
    apiKey: "pairing-secret",
    model: "account-model",
    tools: [{ name: "write_file", description: "Write", inputSchema: { type: "object" }, execute }],
  };
  const agent = createChatGPTAgent(options);
  const turn = agent.prompt("Edit");
  const events = [];
  for await (const event of turn) events.push(event);
  expect((await turn.result).stopReason).toBe("end_turn");
  expect(execute).toHaveBeenCalledTimes(1);
  expect(events.map((event) => event.type)).toEqual(["tool_start", "tool_end", "text_delta"]);
  expect(calls[1].input).toContainEqual({
    type: "function_call_output",
    call_id: "call-1",
    output: '{"saved":true}',
  });
  const checkpoint = await agent.checkpoint();
  expect(new TextDecoder().decode(checkpoint)).not.toContain("pairing-secret");
  const restored = createChatGPTAgent({ ...options, checkpoint });
  const next = restored.prompt("Continue");
  for await (const _event of next) {
    /* drain */
  }
  expect((await next.result).stopReason).toBe("end_turn");
  expect(execute).toHaveBeenCalledTimes(1);
  expect(transport.mock.calls[0][1].credentials).toBe("omit");
  await restored.close();
  await agent.close();
});

test("a failed or truncated stream cannot execute tools or masquerade as completion", async () => {
  const execute = vi.fn();
  vi.stubGlobal("fetch", async () =>
    stream([
      {
        type: "response.output_item.done",
        item: { type: "function_call", name: "write_file", call_id: "1", arguments: "{}" },
      },
    ]),
  );
  const agent = createChatGPTAgent({
    apiKey: "pair",
    tools: [{ name: "write_file", description: "", inputSchema: {}, execute }],
  });
  const turn = agent.prompt("Edit");
  await expect(async () => {
    for await (const _event of turn) {
      /* drain */
    }
  }).rejects.toThrow("interrupted");
  await expect(turn.result).rejects.toThrow("interrupted");
  expect(execute).not.toHaveBeenCalled();
  expect(await agent.checkpoint()).toBeInstanceOf(Uint8Array);
});

test("cancellation keeps completed writes and records skipped calls without replay", async () => {
  vi.stubGlobal("fetch", async () =>
    stream([
      completion([
        { type: "function_call", name: "write", call_id: "1", arguments: "{}" },
        { type: "function_call", name: "write", call_id: "2", arguments: "{}" },
      ]),
    ]),
  );
  const abort = new AbortController();
  const execute = vi.fn(async () => {
    abort.abort();
    return "saved";
  });
  const agent = createChatGPTAgent({
    apiKey: "pair",
    tools: [{ name: "write", description: "", inputSchema: {}, execute }],
  });
  const turn = agent.prompt("Edit", { signal: abort.signal });
  for await (const _event of turn) {
    /* drain */
  }
  expect((await turn.result).stopReason).toBe("cancelled");
  expect(execute).toHaveBeenCalledTimes(1);
  const saved = JSON.parse(new TextDecoder().decode(await agent.checkpoint()));
  expect(
    saved.input.filter((item: { type?: string }) => item.type === "function_call_output"),
  ).toHaveLength(2);
  expect(saved.input.at(-2).output).toBe("saved");
  expect(saved.input.at(-1).output).toContain("Interrupted");
});

test("SSE framing survives split Unicode and CRLF boundaries", async () => {
  const encoded = new TextEncoder().encode('data: {"type":"text","delta":"é"}\r\n\r\n');
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of encoded) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    },
  });
  const events = [];
  for await (const event of responseEvents(body)) events.push(event);
  expect(events).toEqual([{ type: "text", delta: "é" }]);
});
