/**
 * Turn plumbing shared by browser sessions (libfx/browser) and server sessions (libfx native):
 * folds fx turn events and libfx transport diagnostics into thread items and live activity.
 */
import type { FxAgentOptions, FxTurn } from "libfx/browser";
import type { Activity, ThreadItem } from "./types";

export const uid = () => crypto.randomUUID();

export type FxTools = NonNullable<FxAgentOptions["tools"]>;

/**
 * fx truncates tool_end.content in its event stream (the model still receives the full
 * result), so the host keeps its own copy of each result, keyed by tool name + input.
 */
export class ToolLog {
  private results = new Map<string, string[]>();
  private key = (name: string, input: unknown) => `${name}\u0000${JSON.stringify(input)}`;

  wrap(tools: FxTools): FxTools {
    return tools.map((tool) => ({
      ...tool,
      execute: async (input: unknown, ctx: { signal: AbortSignal }) => {
        const value = await tool.execute(input, ctx);
        const k = this.key(tool.name, input);
        this.results.set(k, [
          ...(this.results.get(k) ?? []),
          typeof value === "string" ? value : JSON.stringify(value),
        ]);
        return value;
      },
    }));
  }

  take(name: string, input: unknown) {
    const k = this.key(name, input);
    const list = this.results.get(k);
    const value = list?.shift();
    if (list && !list.length) this.results.delete(k);
    return value;
  }
}

export type FxEvent = { type: string; [key: string]: unknown };

/** Where a session's turns render: the main thread or one sub-task. */
export interface SessionSink {
  items(fn: (items: ThreadItem[]) => ThreadItem[]): void;
  activity(next: Activity | undefined): void;
}

/**
 * Maps libfx transport diagnostics onto the session's live phase. Tool phases come from
 * turn events in pumpTurn; this covers the model request/stream/retry side.
 */
export function transportActivity(sink: SessionSink) {
  let last: Activity | undefined;
  let lastAt = 0;
  const set = (next: Activity) => {
    const now = Date.now();
    if (last?.phase === next.phase && next.phase === "streaming" && now - lastAt < 400) return;
    last = next;
    lastAt = now;
    sink.activity(next);
  };
  return (ev: FxEvent) => {
    const now = Date.now();
    if (ev.type === "transport.start")
      set({ phase: "waiting", since: now, attempt: Number(ev.attempt ?? 1) });
    else if (ev.type === "transport.activity") {
      set({
        phase: "streaming",
        since: last?.phase === "streaming" ? last.since : now,
        bytes: Number(ev.totalBytes ?? 0),
      });
    } else if (ev.type === "transport.retry") {
      set({
        phase: "retrying",
        since: now,
        attempt: Number(ev.nextAttempt ?? 2),
        error: String(ev.error ?? ""),
      });
    }
  };
}

/** Streams one fx turn into thread items, then appends a turn summary. */
export async function pumpTurn(turn: FxTurn, sink: SessionSink, log: ToolLog, startedAt: number) {
  const inputs = new Map<string, { name: string; input: unknown }>();
  const closeReasoning = (items: ThreadItem[]) => {
    const last = items.at(-1);
    return last?.kind === "reasoning" && !last.done
      ? [...items.slice(0, -1), { ...last, done: true }]
      : items;
  };
  for await (const ev of turn) {
    if (ev.type === "reasoning_delta") {
      sink.items((items) => {
        const last = items.at(-1);
        if (last?.kind === "reasoning" && !last.done)
          return [...items.slice(0, -1), { ...last, text: last.text + ev.delta }];
        return [...items, { kind: "reasoning", id: uid(), text: ev.delta, done: false }];
      });
    } else if (ev.type === "text_delta") {
      sink.items((raw) => {
        const items = closeReasoning(raw);
        const last = items.at(-1);
        if (last?.kind === "assistant")
          return [...items.slice(0, -1), { ...last, text: last.text + ev.delta }];
        return [...items, { kind: "assistant", id: uid(), text: ev.delta }];
      });
    } else if (ev.type === "user_message") {
      const text = (typeof ev.text === "string" ? ev.text : "").replace(
        /^<review_note>[\s\S]*?<\/review_note>\s*/,
        "",
      );
      if (text)
        sink.items((items) => [
          ...closeReasoning(items),
          { kind: "user", id: uid(), text, at: Date.now(), steer: true },
        ]);
    } else if (ev.type === "tool_start") {
      inputs.set(ev.id, { name: ev.name, input: ev.input });
      sink.activity({ phase: "tool", since: Date.now(), name: ev.name });
      sink.items((items) => [
        ...closeReasoning(items),
        {
          kind: "tool",
          id: `${ev.id}:${uid()}`,
          callId: ev.id,
          name: ev.name,
          input: ev.input,
          status: "running",
        },
      ]);
    } else if (ev.type === "tool_end") {
      const started = inputs.get(ev.id);
      const output = (started && log.take(started.name, started.input)) ?? ev.content;
      sink.items((items) =>
        items.map((it) =>
          it.kind === "tool" && (it.callId ?? it.id) === ev.id && it.status === "running"
            ? { ...it, output, isError: ev.isError, status: ev.isError ? "error" : "done" }
            : it,
        ),
      );
    }
  }
  const result = await turn.result;
  sink.activity(undefined);
  sink.items((items) => [
    ...closeReasoning(items),
    {
      kind: "turn",
      id: uid(),
      durationMs: Date.now() - startedAt,
      inputTokens: result?.usage?.inputTokens,
      outputTokens: result?.usage?.outputTokens,
      stopReason: result?.stopReason ?? "unknown",
    },
  ]);
  return result;
}
