export type ThreadItem =
  /** `steer`: sent while the turn was running and folded in with fx's turn.steer(). */
  | { kind: "user"; id: string; text: string; at: number; steer?: boolean }
  | { kind: "assistant"; id: string; text: string }
  | {
      kind: "tool";
      id: string;
      /** fx tool-call id; only unique within a turn. */
      callId?: string;
      name: string;
      input: unknown;
      output?: string;
      isError?: boolean;
      status: "running" | "done" | "error";
    }
  | {
      kind: "notice";
      id: string;
      text: string;
      tone: "error" | "info";
      link?: { href: string; label: string };
    }
  | { kind: "reasoning"; id: string; text: string; done: boolean }
  /** End-of-turn summary from fx's turn result. */
  | {
      kind: "turn";
      id: string;
      durationMs: number;
      inputTokens?: number;
      outputTokens?: number;
      stopReason: string;
    };

/** Live phase of an fx session, derived from turn events and libfx transport events. */
export type Activity =
  | { phase: "starting"; since: number }
  | { phase: "waiting"; since: number; attempt: number }
  | { phase: "streaming"; since: number; bytes: number }
  | { phase: "tool"; since: number; name: string }
  | { phase: "retrying"; since: number; attempt: number; error?: string };
