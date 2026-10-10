import type { FxAgent, FxAgentOptions, FxTurn, FxTurnEvent, FxTurnResult } from "libfx/browser";

const endpoint = "http://127.0.0.1:1455";
export async function companionRequest(path: string, pairing: string, init?: RequestInit) {
  const response = await fetch(`${endpoint}${path}`, {
    ...init,
    credentials: "omit",
    redirect: "error",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${pairing}`,
      ...init?.headers,
    },
  }).catch(() => {
    throw new Error(
      "Start the local ChatGPT companion and allow this site to connect to your local network.",
    );
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error ?? `Companion request failed (${response.status})`);
  }
  return response;
}

/** SSE framing must survive arbitrary byte boundaries, CRLF, and multi-line data. */
export async function* responseEvents(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end).replace(/\r$/, "");
        buffer = buffer.slice(end + 1);
        if (!line && data.length) {
          const payload = data.join("\n");
          data = [];
          if (payload !== "[DONE]") yield JSON.parse(payload);
        } else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (buffer.length + data.join("").length > 4 * 1024 * 1024)
        throw new Error("ChatGPT event exceeds the size limit.");
      if (done) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

type Item = Record<string, unknown>;
export function createChatGPTAgent(options: FxAgentOptions): FxAgent {
  let history: Item[] = [];
  if (options.checkpoint) {
    const saved = JSON.parse(new TextDecoder().decode(options.checkpoint));
    if (saved.provider !== "chatgpt" || saved.version !== 1 || !Array.isArray(saved.input))
      throw new Error("Invalid ChatGPT checkpoint.");
    history = saved.input;
  }
  let closed = false;
  let running = false;
  let active: AbortController | undefined;
  const tools = new Map((options.tools ?? []).map((tool) => [tool.name, tool]));
  return {
    prompt(text, opts): FxTurn {
      if (closed || running) throw new Error("Agent unavailable or already running.");
      running = true;
      const abort = new AbortController();
      active = abort;
      const signal = opts?.signal ? AbortSignal.any([abort.signal, opts.signal]) : abort.signal;
      const queued: string[] = [];
      let resolve!: (result: FxTurnResult) => void;
      let reject!: (error: unknown) => void;
      const result = new Promise<FxTurnResult>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      // The event consumer observes the same failure; avoid an unhandled rejection before it awaits result.
      void result.catch(() => {});
      const usage = { inputTokens: 0, outputTokens: 0 };
      async function* run(): AsyncGenerator<FxTurnEvent> {
        try {
          signal.throwIfAborted();
          history.push({ role: "user", content: text });
          for (let step = 0; step < 32; step++) {
            signal.throwIfAborted();
            for (const guidance of queued.splice(0)) {
              history.push({ role: "user", content: guidance });
              yield { type: "user_message", text: guidance };
            }
            options.onEvent?.({ type: "transport.start", timestamp: Date.now() });
            const response = await companionRequest("/responses", options.apiKey, {
              method: "POST",
              signal,
              body: JSON.stringify({
                model: options.model,
                instructions: options.instructions,
                input: history,
                tools: [...tools.values()].map((tool) => ({
                  type: "function",
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.inputSchema,
                  strict: false,
                })),
              }),
            });
            if (!response.body) throw new Error("ChatGPT returned an empty stream.");
            let completed:
              | { output: Item[]; usage?: { input_tokens?: number; output_tokens?: number } }
              | undefined;
            for await (const event of responseEvents(response.body)) {
              options.onEvent?.({ type: "transport.activity", timestamp: Date.now() });
              if (event.type === "response.output_text.delta")
                yield { type: "text_delta", delta: event.delta };
              else if (event.type === "response.reasoning_summary_text.delta")
                yield { type: "reasoning_delta", delta: event.delta };
              else if (["error", "response.failed", "response.incomplete"].includes(event.type))
                throw new Error(
                  event.response?.error?.message ??
                    event.error?.message ??
                    event.message ??
                    "ChatGPT could not complete the response. Check your plan usage.",
                );
              else if (event.type === "response.completed") completed = event.response;
            }
            if (!completed || !Array.isArray(completed.output))
              throw new Error("ChatGPT stream was interrupted before completion.");
            history.push(...completed.output);
            usage.inputTokens += completed.usage?.input_tokens ?? 0;
            usage.outputTokens += completed.usage?.output_tokens ?? 0;
            const calls = completed.output.filter((item) => item.type === "function_call");
            // Retain a result for every call even on cancellation; never replay a completed write.
            for (const call of calls) {
              const name = String(call.name);
              const id = String(call.call_id);
              let input: unknown;
              let content: string;
              let isError = false;
              try {
                signal.throwIfAborted();
                input = JSON.parse(String(call.arguments));
                yield { type: "tool_start", id, name, input };
                const tool = tools.get(name);
                if (!tool) throw new Error(`Unknown tool: ${name}`);
                const value = await tool.execute(input, { signal });
                content = typeof value === "string" ? value : (JSON.stringify(value) ?? "null");
              } catch (error) {
                isError = true;
                content = signal.aborted
                  ? "Interrupted. Inspect the current draft before retrying this operation."
                  : (error as Error).message;
              }
              history.push({ type: "function_call_output", call_id: id, output: content });
              yield { type: "tool_end", id, name, content, isError };
            }
            signal.throwIfAborted();
            if (!calls.length && !queued.length) {
              resolve({ stopReason: "end_turn", usage });
              return;
            }
          }
          resolve({ stopReason: "max_model_turns", usage });
        } catch (error) {
          if (signal.aborted) resolve({ stopReason: "cancelled", usage });
          else {
            reject(error);
            throw error;
          }
        } finally {
          running = false;
          resolve({ stopReason: "cancelled", usage });
        }
      }
      return {
        result,
        cancel: () => abort.abort(),
        steer: async (guidance) => {
          if (!running || signal.aborted) throw new Error("Turn already finished.");
          queued.push(guidance);
        },
        [Symbol.asyncIterator]: run,
      };
    },
    checkpoint: async () => {
      if (running) throw new Error("Wait for the turn before saving.");
      const bytes = new TextEncoder().encode(
        JSON.stringify({ provider: "chatgpt", version: 1, input: history }),
      );
      if (bytes.length > 4 * 1024 * 1024)
        throw new Error("Conversation exceeds checkpoint limit. Start a new conversation.");
      return bytes;
    },
    close: async () => {
      closed = true;
      active?.abort();
    },
  };
}
