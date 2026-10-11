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
test("Gateway retains experimental transcripts and drafts without restoring incompatible checkpoints", async () => {
  mocks.records.set("site:alice:new", {
    id: crypto.randomUUID(),
    draft: "draft-a",
    model: "subscription-model",
    provider: "chatgpt",
    checkpoint: new Uint8Array([1, 2, 3]),
    items: [{ kind: "user", id: "message", text: "Earlier task", at: 1 }],
    updated: 1,
  });
  const session = await loadSession(config);
  expect(session.draft).toBe("draft-a");
  expect(session.items[0]).toMatchObject({ text: "Earlier task" });
  expect(session.model).toBe(config.model);
  expect(session.checkpoint).toBeUndefined();
  expect(session.interrupted).toBe(true);
});
test("saved site defaults follow the server model while explicit model choices survive", async () => {
  const saved = {
    id: crypto.randomUUID(),
    draft: "draft-a",
    model: "anthropic/claude-sonnet-4.5",
    checkpoint: new Uint8Array([1]),
    items: [{ kind: "user", id: "message", text: "Earlier task", at: 1 }],
    updated: 1,
  };
  mocks.records.set("site:alice:new", saved);
  expect(await loadSession(config)).toMatchObject({
    model: config.model,
    modelPreference: "site",
    interrupted: true,
    items: saved.items,
  });
  expect((await loadSession(config)).checkpoint).toBeUndefined();
  mocks.records.set("site:alice:new", { ...saved, modelPreference: "custom" });
  expect((await loadSession(config)).model).toBe(saved.model);
});
test("a submitted message appears before slow connection setup and preserves newer tab history", async () => {
  let finishStart!: (response: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finishStart = resolve;
        }),
    ),
  );
  mocks.create.mockResolvedValue({
    prompt: completed,
    checkpoint: async () => new Uint8Array([1]),
    close: async () => {},
  });
  const session = await loadSession(config, "draft-a");
  mocks.records.set("site:alice:draft-a", {
    ...session,
    updated: session.updated + 100,
    items: [{ kind: "assistant", id: "other-tab", text: "Newer tab history" }],
  });
  const runtime = new AgentRuntime("/cms", { ...config, siteKey: true }, session);
  const sent = runtime.send("Edit immediately", { model: "test/model", personalKey: "" });
  expect(runtime.state.session.items).toEqual([
    expect.objectContaining({ kind: "user", text: "Edit immediately" }),
  ]);
  expect(runtime.state.running).toBe(true);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
  expect(mocks.create).not.toHaveBeenCalled();
  expect(runtime.state.session.items.map((item) => ("text" in item ? item.text : ""))).toEqual([
    "Newer tab history",
    "Edit immediately",
  ]);
  finishStart(
    Response.json({
      token: "private-mcp-token",
      draft: "draft-a",
      ref: "draft/a",
      name: "Draft A",
      endpoint: "https://site.test/cms/mcp",
      version: "1",
      variant: {},
    }),
  );
  await sent;
  expect(runtime.state.session.items.filter((item) => item.kind === "user")).toHaveLength(1);
  await runtime.close();
});
test("a wrapped FX stream failure shows the sanitized Gateway error", async () => {
  const start = fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn((input, init) =>
      String(input).includes("/agent/gateway")
        ? Promise.resolve(
            Response.json(
              {
                error: "AI Gateway denied this request. Check model access and available credits.",
              },
              { status: 403 },
            ),
          )
        : start(input, init),
    ),
  );
  mocks.create.mockImplementation(async (options) => ({
    prompt: () => ({
      ...completed(),
      async *[Symbol.asyncIterator]() {
        yield { type: "text_delta", delta: "Starting" };
        await options
          .fetch("https://ai-gateway.vercel.sh/v4/ai/language-model", { method: "POST" })
          .catch(() => {});
        throw new Error("HostStreamFailed");
      },
    }),
    checkpoint: async () => new Uint8Array([1]),
    close: async () => {},
  }));
  const runtime = new AgentRuntime("/cms", { ...config, siteKey: true }, await loadSession(config));
  await runtime.send("Edit");
  expect(runtime.state.error).toMatch(/model access and available credits/);
  expect(runtime.state.error).not.toContain("HostStreamFailed");
  await runtime.close();
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
test("branch switching preserves conversation identity, clears old checkpoints, and reauthorizes before another turn", async () => {
  const checkpoint = new Uint8Array([1]);
  const close = vi.fn(async () => {});
  mocks.create.mockResolvedValue({ prompt: completed, checkpoint: async () => checkpoint, close });
  const runtime = new AgentRuntime("/cms", { ...config, siteKey: true }, await loadSession(config));
  await runtime.send("First branch");
  const id = runtime.state.session.id;
  const items = runtime.state.session.items;
  const start = vi.fn(async (_url: string, init: RequestInit) => {
    const input = JSON.parse(String(init.body));
    return Response.json({
      token: "new-credential",
      draft: input.draft,
      bindingRevision: 1,
      ref: `draft/${input.draft}`,
      name: "Draft B",
      endpoint: "https://site.test/cms/mcp",
      version: "1",
      variant: {},
    });
  });
  vi.stubGlobal("fetch", start);
  await runtime.switchDraft("draft-b");
  expect(runtime.state.session.id).toBe(id);
  expect(runtime.state.session.items).toEqual(items);
  expect(runtime.state.session.checkpoint).toBeUndefined();
  expect(close).toHaveBeenCalledOnce();
  expect(start).not.toHaveBeenCalled();
  await runtime.send("Now edit B");
  expect(JSON.parse(String(start.mock.calls[0][1].body))).toMatchObject({
    session: id,
    draft: "draft-b",
    bindingRevision: 0,
  });
  expect(mocks.create.mock.calls[1][0].checkpoint).toBeUndefined();
  expect(mocks.create.mock.calls[1][0].instructions).toContain('"draft":"draft-b"');
  expect(mocks.create.mock.calls[1][0].instructions).toContain("First branch");
  expect(runtime.state.session.bindingRevision).toBe(1);
  const reopened = await loadSession(config, "draft-a");
  expect(reopened.id).toBe(id);
  expect(reopened.draft).toBe("draft-a");
  expect(reopened.bindingRevision).toBe(1);
  expect(reopened.checkpoint).toBeUndefined();
  expect(reopened.items.some((item) => item.kind === "user" && item.text === "Now edit B")).toBe(
    true,
  );
  await runtime.close();
});
test("rapid branch changes settle on the last selected draft", async () => {
  const runtime = new AgentRuntime(
    "/cms",
    { ...config, siteKey: true },
    await loadSession(config, "draft-a"),
  );
  const b = runtime.switchDraft("draft-b");
  const a = runtime.switchDraft("draft-a");
  await Promise.all([b, a]);
  expect(runtime.state.session.draft).toBe("draft-a");
  expect(runtime.state.switching).toBe(false);
  await runtime.close();
});
test("switching drafts waits for the cancelled turn to settle and never restores its checkpoint", async () => {
  let finish!: () => void;
  const waiting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const prompt = vi.fn(() => ({
    ...completed(),
    cancel: vi.fn(() => finish()),
    async *[Symbol.asyncIterator]() {
      yield { type: "text_delta", delta: "Working on A" };
      await waiting;
    },
  }));
  mocks.create.mockResolvedValue({
    prompt,
    checkpoint: async () => new Uint8Array([9]),
    close: async () => {},
  });
  const runtime = new AgentRuntime("/cms", { ...config, siteKey: true }, await loadSession(config));
  const sent = runtime.send("Edit A");
  await vi.waitFor(() => expect(prompt).toHaveBeenCalled());
  const switched = runtime.switchDraft("draft-b");
  expect(runtime.state.switching).toBe(true);
  await Promise.all([sent, switched]);
  expect(runtime.state.running).toBe(false);
  expect(runtime.state.session.draft).toBe("draft-b");
  expect(runtime.state.session.checkpoint).toBeUndefined();
  expect(
    runtime.state.session.items.some(
      (item) => item.kind === "assistant" && item.text === "Working on A",
    ),
  ).toBe(true);
  await runtime.close();
});
test("a busy target draft is refused before reauthorization or changing the browser view", async () => {
  const runtime = new AgentRuntime(
    "/cms",
    { ...config, siteKey: true },
    await loadSession(config, "draft-a"),
  );
  await runtime.switchDraft("draft-b");
  mocks.locks.add("wildwood-agent-draft:alice:draft-b");
  await runtime.send("Edit B");
  expect(runtime.state.error).toMatch(/another tab/);
  expect(fetch).not.toHaveBeenCalled();
  expect(mocks.create).not.toHaveBeenCalled();
  await runtime.close();
});

test("reopening a saved draft selects the website without starting MCP or loading WASM", async () => {
  const runtime = new AgentRuntime("/cms", config, {
    id: crypto.randomUUID(),
    draft: "draft-a",
    name: "Old name",
    model: config.model,
    items: [],
    updated: 1,
  });
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ draft: "draft-a", name: "Draft A" }));
  await runtime.restoreView();
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch).toHaveBeenCalledWith(
    "/cms/agent/view",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ draft: "draft-a" }),
    }),
  );
  expect(runtime.state.session.name).toBe("Draft A");
  expect(runtime.state.viewing).toBe(false);
  expect(mocks.create).not.toHaveBeenCalled();
  await runtime.close();
});

test("unavailable saved drafts leave the conversation visible and report why its view could not open", async () => {
  const runtime = new AgentRuntime("/cms", config, {
    id: crypto.randomUUID(),
    draft: "draft-a",
    model: config.model,
    items: [{ kind: "user", id: "old-message", text: "Earlier edit", at: 1 }],
    updated: 1,
  });
  vi.mocked(fetch).mockResolvedValueOnce(
    Response.json({ error: "Draft completed" }, { status: 403 }),
  );
  await runtime.restoreView();
  expect(runtime.state.error).toBe("Draft completed");
  expect(runtime.state.session.items[0]).toMatchObject({ text: "Earlier edit" });
  expect(runtime.state.viewing).toBe(false);
  await runtime.close();
});
