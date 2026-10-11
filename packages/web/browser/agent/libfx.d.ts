declare module "libfx/browser" {
  export interface FxToolContext {
    signal: AbortSignal;
  }

  export interface FxHostTool {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    // Method syntax keeps parameters bivariant so tools can declare their own input shape.
    execute(input: unknown, ctx: FxToolContext): unknown | Promise<unknown>;
  }

  export type FxTurnEvent =
    | { type: "text_delta"; delta: string }
    | { type: "reasoning_delta"; delta: string }
    | { type: "tool_start"; id: string; name: string; input: unknown }
    | { type: "tool_end"; id: string; name: string; content: string; isError: boolean }
    | { type: "user_message"; text?: string; [key: string]: unknown };

  export interface FxTurnResult {
    stopReason: string;
    usage?: { inputTokens?: number; outputTokens?: number };
  }

  export interface FxTurn extends AsyncIterable<FxTurnEvent> {
    result: Promise<FxTurnResult>;
    steer(text: string): Promise<void>;
    cancel(): void;
  }

  export interface FxAgentOptions {
    apiKey: string;
    model?: string;
    instructions?: string;
    tools?: FxHostTool[];
    fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    checkpoint?: Uint8Array;
    wasm?: string;
    gatewayChatUrl?: string;
    effort?: string;
    onEvent?: (event: { type: string; timestamp: number; [key: string]: unknown }) => void;
  }

  export interface FxAgent {
    prompt(input: string, opts?: { signal?: AbortSignal }): FxTurn;
    checkpoint(): Promise<Uint8Array>;
    close(): Promise<void>;
  }

  export function createFxAgent(options: FxAgentOptions): Promise<FxAgent>;
  export function supportsJspi(): boolean;
  export const libfxApiVersion: number;
}

declare module "libfx/mcp" {
  import type { FxHostTool } from "libfx/browser";

  export interface McpClientLike {
    listTools(params?: { cursor?: string }): Promise<{ tools: unknown[]; nextCursor?: string }>;
    callTool(
      params: { name: string; arguments?: unknown },
      resultSchema?: unknown,
      options?: { signal?: AbortSignal },
    ): Promise<unknown>;
    readResource?(params: { uri: string }): Promise<unknown>;
    getPrompt?(params: { name: string }): Promise<unknown>;
    close?(): Promise<void> | void;
  }

  export function createMcpAdapter(
    client: McpClientLike,
    options?: { prefix?: string; resources?: string[]; prompts?: (string | { name: string })[] },
  ): Promise<{ tools: FxHostTool[]; instructions: string; close(): Promise<void> }>;
}
