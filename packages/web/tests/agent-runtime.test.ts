import { test, expect, vi, afterEach, beforeEach } from "vitest";
const mocks = vi.hoisted(() => ({
  records: new Map<string, unknown>(),
  create: vi.fn(),
  locks: new Set<string>(),
  supported: true,
  closed: vi.fn(),
}));
vi.mock("idb-keyval", () => ({
  createStore: () => ({}),
  get: async (key: string) => structuredClone(mocks.records.get(key)),
  set: async (key: string, value: unknown) => {
    mocks.records.set(key, structuredClone(value));
  },
}));
vi.mock("libfx/browser", () => ({
  supportsJspi: () => mocks.supported,
  createFxAgent: mocks.create,
}));
vi.mock("libfx/mcp", () => ({ createMcpAdapter: async () => ({ tools: [], instructions: "" }) }));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    connect = async () => {};
    close = mocks.closed;
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {
    constructor(readonly url: URL) {}
  },
}));
import { AgentRuntime, loadSession, type AgentConfig } from "../browser/agent/runtime";
const config: AgentConfig = {
  actor: { id: "alice", name: "Alice" },
  repository: "site",
  siteKey: false,
  model: "test/model",
  wasm: "/fx.wasm",
};
beforeEach(() => {
  mocks.records.clear();
  mocks.locks.clear();
  mocks.supported = true;
  mocks.create.mockReset();
  mocks.closed.mockReset();
  vi.stubGlobal("navigator", {
    locks: {
      request: async (name: string, _options: unknown, fn: (lock: unknown) => Promise<unknown>) => {
        if (mocks.locks.has(name)) return fn(null);
        mocks.locks.add(name);
        try {
          return await fn({});
        } finally {
          mocks.locks.delete(name);
        }
      },
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        token: "private-mcp-token",
        draft: "draft-a",
        ref: "draft/a",
        name: "Draft A",
        endpoint: "https://site.test/cms/mcp",
        version: "1",
        variant: { locale: "en" },
      }),
    ),
  );
});
afterEach(() => vi.unstubAllGlobals());
const completed = () => ({
  result: Promise.resolve({ stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 2 } }),
  cancel: vi.fn(),
  steer: vi.fn(),
  async *[Symbol.asyncIterator]() {
    yield { type: "text_delta", delta: "Finished" };
  },
});
test("libfx resumes its checkpoint without persisting Gateway keys or MCP credentials", async () => {
  const checkpoint = new Uint8Array([1, 2, 3]);
  mocks.create.mockImplementation(async () => ({
    prompt: completed,
    checkpoint: async () => checkpoint,
    close: async () => {},
  }));
  const runtime = new AgentRuntime("/cms", config, await loadSession(config));
  await runtime.configure("test/model", "personal-secret");
  await runtime.send("Edit content");
  expect(runtime.state.error).toBeUndefined();
  expect(runtime.state.tools).toBe(0);
  const saved = await loadSession(config, "draft-a");
  expect(saved.checkpoint).toEqual(checkpoint);
  expect(saved.items.some((i) => i.kind === "assistant" && i.text === "Finished")).toBe(true);
  const serialized = JSON.stringify([...mocks.records.values()]);
  expect(serialized).not.toContain("personal-secret");
  expect(serialized).not.toContain("private-mcp-token");
  expect(mocks.create.mock.calls[0][0].apiKey).toBe("proxied-by-wildwood");
  await runtime.close();
  const restored = new AgentRuntime("/cms", { ...config, siteKey: true }, saved);
  await restored.send("Continue");
  expect(mocks.create.mock.calls[1][0].checkpoint).toEqual(checkpoint);
  expect(
    (await loadSession({ ...config, actor: { id: "bob", name: "Bob" } }, "draft-a")).items,
  ).toEqual([]);
  await restored.close();
});
test("a locked draft and unsupported browser cannot start a model turn", async () => {
  const runtime = new AgentRuntime(
    "/cms",
    { ...config, siteKey: true },
    await loadSession(config, "draft-a"),
  );
  mocks.locks.add(`wildwood-agent-session:alice:${runtime.state.session.id}`);
  await runtime.send("Edit content");
  expect(runtime.state.error).toMatch(/another tab/);
  expect(mocks.create).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  mocks.locks.clear();
  mocks.supported = false;
  await runtime.send("Edit content");
  expect(runtime.state.error).toMatch(/Chrome or Edge/);
  expect(fetch).not.toHaveBeenCalled();
  await runtime.close();
});
test("an interrupted checkpoint explicitly requires inspecting the draft before any replay", async () => {
  const prompt = vi.fn((_text: string) => completed());
  mocks.create.mockResolvedValue({
    prompt,
    checkpoint: async () => new Uint8Array([1]),
    close: async () => {},
  });
  const session = {
    ...(await loadSession(config)),
    running: true,
    checkpoint: new Uint8Array([9]),
  };
  const runtime = new AgentRuntime("/cms", { ...config, siteKey: true }, session);
  await runtime.send("Continue");
  expect(prompt.mock.calls[0][0]).toContain("Do not blindly replay writes");
  expect(mocks.create.mock.calls[0][0].checkpoint).toEqual(new Uint8Array([9]));
  await runtime.close();
});
