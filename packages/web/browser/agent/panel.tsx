import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import ReactMarkdown from "react-markdown";
import {
  ArrowUp,
  Bot,
  ChevronRight,
  CircleAlert,
  GitBranch,
  Loader2,
  Plus,
  Settings2,
  Square,
  X,
} from "lucide-react";
import { AgentRuntime, freshSession, loadSession, type AgentConfig } from "./runtime";
import type { ThreadItem } from "./types";
import { requestJson } from "../request";

export type AgentReference = {
  id: string;
  path: string;
  revision: string;
  side: "before" | "after";
  start: number;
  end: number;
  text: string;
};
export function AgentPanel({
  endpoint,
  draft,
  reference,
  onReferenceUsed,
  onChanged,
}: {
  endpoint: string;
  draft?: string;
  reference?: AgentReference;
  onReferenceUsed?: () => void;
  onChanged?: () => void;
}) {
  const [runtime, setRuntime] = useState<AgentRuntime>();
  const [error, setError] = useState("");
  useEffect(
    () => () => {
      void runtime?.close();
    },
    [runtime],
  );
  useEffect(() => {
    let live = true;
    let instance: AgentRuntime | undefined;
    (async () => {
      const config: AgentConfig = await requestJson(`${endpoint}/agent/config`);
      const session = await loadSession(config, draft);
      if (!live) return;
      instance = new AgentRuntime(endpoint, config, session);
      setRuntime(instance);
    })().catch((e) => live && setError(e.message));
    return () => {
      live = false;
      void instance?.close();
    };
  }, [endpoint, draft]);
  if (error)
    return (
      <div className="agent-empty" role="alert">
        <CircleAlert />
        <p>{error}</p>
        <a href={`${endpoint}/sign-in`}>Sign in</a>
      </div>
    );
  if (!runtime)
    return (
      <div className="agent-empty">
        <Loader2 className="spin" />
        <p>Opening your session…</p>
      </div>
    );
  return (
    <SessionPanel
      key={runtime.state.session.id}
      runtime={runtime}
      reference={reference}
      onReferenceUsed={onReferenceUsed}
      onChanged={onChanged}
      onNew={
        !draft
          ? () => {
              void runtime.close();
              setRuntime(new AgentRuntime(endpoint, runtime.config, freshSession(runtime.config)));
            }
          : undefined
      }
    />
  );
}

function SessionPanel({
  runtime,
  reference,
  onReferenceUsed,
  onChanged,
  onNew,
}: {
  runtime: AgentRuntime;
  reference?: AgentReference;
  onReferenceUsed?: () => void;
  onChanged?: () => void;
  onNew?: () => void;
}) {
  const state = useSyncExternalStore(runtime.subscribe, runtime.snapshot);
  const [prompt, setPrompt] = useState("");
  const [settings, setSettings] = useState(!runtime.config.siteKey);
  const [personalKey, setPersonalKey] = useState("");
  const [model, setModel] = useState(state.session.model);
  const [error, setError] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const nearBottom = useRef(true);
  const wasRunning = useRef(false);
  useEffect(() => {
    if (nearBottom.current && scroller.current)
      scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [state.session.items.length, state.activity]);
  useEffect(() => {
    if (reference) composer.current?.focus();
  }, [reference]);
  useEffect(() => {
    if (wasRunning.current && !state.running) onChanged?.();
    wasRunning.current = state.running;
    if (!state.running) return;
    const prevent = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [state.running, onChanged]);
  async function send() {
    if (!prompt.trim()) return;
    setError("");
    try {
      if (!state.running) await runtime.configure(model.trim(), personalKey.trim());
      const text = reference
        ? `${prompt}\n\nQuoted review context (${reference.revision}), ${reference.path}, ${reference.side} lines ${reference.start}-${reference.end}:\n\n${reference.text}`
        : prompt;
      setPrompt("");
      onReferenceUsed?.();
      setSettings(false);
      await runtime.send(text);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <section className="agent-panel" aria-label="Content agent">
      <header className="agent-header">
        <div>
          <Bot size={17} />
          <strong>Content agent</strong>
          <span className="agent-status">{state.running ? "Working" : "Ready"}</span>
        </div>
        <div>
          {onNew && (
            <button aria-label="New agent draft" disabled={state.running} onClick={onNew}>
              <Plus size={16} />
            </button>
          )}
          <button
            aria-label="Agent settings"
            aria-expanded={settings}
            onClick={() => setSettings(!settings)}
          >
            <Settings2 size={16} />
          </button>
        </div>
      </header>
      <div className="agent-draft">
        <GitBranch size={13} />
        <span>{state.session.name ?? "A new draft for this session"}</span>
        <small>{state.tools ? `${state.tools} MCP tools` : "Powered by libfx"}</small>
      </div>
      {settings && (
        <form
          className="agent-settings"
          onSubmit={(e) => {
            e.preventDefault();
            setSettings(false);
          }}
        >
          <label>
            Model
            <input
              aria-label="Gateway model"
              value={model}
              disabled={state.running}
              maxLength={200}
              placeholder="provider/model"
              onChange={(e) => setModel(e.target.value)}
            />
          </label>
          <label>
            Personal AI Gateway key
            <input
              type="password"
              autoComplete="off"
              aria-label="Personal AI Gateway key"
              value={personalKey}
              disabled={state.running}
              maxLength={4096}
              placeholder={
                runtime.config.siteKey ? "Leave empty to use the site key" : "Enter your key"
              }
              onChange={(e) => setPersonalKey(e.target.value)}
            />
          </label>
          <p>
            {runtime.config.siteKey
              ? "The site key is available. A personal key overrides it."
              : "Your key is required to run the agent."}{" "}
            Personal keys stay in memory for this page and are cleared when you leave or reload.
          </p>
          <button type="submit">Done</button>
        </form>
      )}
      <div
        className="agent-transcript"
        ref={scroller}
        onScroll={() => {
          const el = scroller.current!;
          nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
        }}
        aria-label="Conversation"
        tabIndex={0}
      >
        {!state.session.items.length && (
          <div className="agent-welcome">
            <div className="agent-orbit">
              <Bot size={25} />
            </div>
            <h2>Make something worth publishing.</h2>
            <p>
              Describe a change. Your agent works in an isolated draft, then brings it back for
              review.
            </p>
            <div className="agent-starters">
              {[
                "Explore the content model and suggest improvements",
                "Review the French translations for consistency",
              ].map((text) => (
                <button
                  key={text}
                  onClick={() => {
                    setPrompt(text);
                    composer.current?.focus();
                  }}
                >
                  {text}
                  <ArrowUp size={14} />
                </button>
              ))}
            </div>
          </div>
        )}
        {state.session.items.map((item) => (
          <ThreadItemView key={item.id} item={item} />
        ))}
      </div>
      {(error || state.error) && (
        <div className="agent-error" role="alert">
          <CircleAlert size={15} />
          <span>{error || state.error}</span>
        </div>
      )}
      <form
        className="agent-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        {reference && (
          <div className="agent-reference">
            <span>
              {reference.path.split("/").pop()}:{reference.start}–{reference.end}
            </span>
            <button type="button" aria-label="Remove selected context" onClick={onReferenceUsed}>
              <X size={12} />
            </button>
          </div>
        )}
        <textarea
          ref={composer}
          aria-label="Message the content agent"
          placeholder={
            state.running ? "Add guidance while it works…" : "What would you like to change?"
          }
          value={prompt}
          maxLength={16000}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <footer>
          <span role="status">
            {state.activity?.phase === "tool"
              ? state.activity.name
              : state.activity?.phase === "waiting"
                ? "Waiting for model…"
                : state.activity?.phase === "streaming"
                  ? "Writing…"
                  : state.activity?.phase === "starting"
                    ? "Connecting…"
                    : state.activity?.phase === "retrying"
                      ? "Reconnecting…"
                      : model.split("/").pop()}
          </span>
          <div>
            {state.running && (
              <button type="button" aria-label="Stop agent" onClick={() => runtime.stop()}>
                <Square size={14} />
              </button>
            )}
            <button
              type="submit"
              className="agent-send"
              aria-label={state.running ? "Send guidance" : "Send message"}
              disabled={
                !prompt.trim() || !model.trim() || (!runtime.config.siteKey && !personalKey.trim())
              }
            >
              <ArrowUp size={17} />
            </button>
          </div>
        </footer>
      </form>
      <p className="agent-footnote">
        Draft edits only · You review and publish · Session saved in this browser
      </p>
    </section>
  );
}

function ThreadItemView({ item }: { item: ThreadItem }) {
  if (item.kind === "user")
    return (
      <div className="agent-user">
        <p>{item.text}</p>
        {item.steer && <small>Added while working</small>}
      </div>
    );
  if (item.kind === "assistant")
    return (
      <div className="agent-answer">
        <ReactMarkdown>{item.text}</ReactMarkdown>
      </div>
    );
  if (item.kind === "reasoning")
    return (
      <details className="agent-thinking">
        <summary>
          <ChevronRight size={12} />
          {item.done ? "Thought" : "Thinking…"}
        </summary>
        <p>{item.text}</p>
      </details>
    );
  if (item.kind === "tool")
    return (
      <details className="agent-tool">
        <summary>
          <ChevronRight size={12} />
          <code>{item.name}</code>
          <span>
            {item.status === "running" ? (
              <Loader2 size={12} className="spin" />
            ) : item.isError ? (
              "Failed"
            ) : (
              "Done"
            )}
          </span>
        </summary>
        <pre>{JSON.stringify(item.input, null, 2)}</pre>
        <pre>{item.output ?? "Waiting for output…"}</pre>
      </details>
    );
  if (item.kind === "turn")
    return (
      <p className="agent-turn">
        {item.stopReason === "cancelled" ? "Stopped" : "Completed"} in{" "}
        {(item.durationMs / 1000).toFixed(1)}s
        {item.inputTokens !== undefined &&
          ` · ${item.inputTokens.toLocaleString()} in / ${(item.outputTokens ?? 0).toLocaleString()} out`}
      </p>
    );
  return <p className="agent-notice">{item.text}</p>;
}
