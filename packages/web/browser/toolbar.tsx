import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Dialog } from "@base-ui/react/dialog";
import { Popover } from "@base-ui/react/popover";
import {
  Check,
  ChevronLeft,
  Copy,
  GitBranch,
  Loader2,
  MousePointer2,
  Plus,
  Share2,
  X,
  ArrowUpRight,
  Bot,
  FileCheck,
  LogOut,
  Shield,
  Image,
  Save,
  Ellipsis,
} from "lucide-react";
import { Editor } from "./editor-loader";
import { retryKey } from "./editor-model";
import { RelativeTime } from "./relative-time";
import { Wordmark } from "./wordmark";
import { Button } from "./ui/button";
import { installContentIndicator } from "./content-indicator";

const AgentPanel = lazy(() => import("./agent/panel").then((m) => ({ default: m.AgentPanel })));

type State = {
  endpoint: string;
  mcpUrl: string;
  oauth: boolean;
  css: string;
  mode: string;
  snapshot: string;
  canEdit: boolean;
  draft?: string;
  actor: { name: string; role: string } | null;
  completed: { updatedAt: number; id: string; review: string; data: { name: string } }[];
  drafts: {
    updatedAt: number;
    id: string;
    data: { ref: string; name: string; created?: string };
  }[];
};
type Result = {
  ok: boolean;
  error?: string;
  message?: string;
  url?: string;
  token?: string;
  endpoint?: string;
  source?: string;
  pageUrl?: string;
  map?: string;
  revision?: number;
  path?: string;
  field?: string;
  fallback?: boolean;
};
type Command = { type: string; [key: string]: unknown };
function App({ state: s, host, portal }: { state: State; host: HTMLElement; portal: HTMLElement }) {
  const [pending, setPending] = useState(false),
    lock = useRef(false);
  const [message, setMessage] = useState(""),
    [error, setError] = useState("");
  const [selecting, setSelecting] = useState(false),
    [menuOpen, setMenuOpen] = useState(false);
  const [section, setSection] = useState<"agent" | "home" | "share" | "drafts">("agent");
  const [agentStarted, setAgentStarted] = useState(false);
  const [panel, setPanel] = useState<"editor" | "agent" | "review" | null>(null);
  const [doc, setDoc] = useState<Result | null>(null),
    [source, setSource] = useState(""),
    [override, setOverride] = useState(false),
    [discard, setDiscard] = useState(false);
  const saveAttempt = useRef<{ payload: string; key: string } | null>(null);
  const dirty = panel === "editor" && !!doc && (source !== doc.source || override);
  const [moving, setMoving] = useState(false),
    [minutes, setMinutes] = useState("60"),
    [share, setShare] = useState("");
  const [review, setReview] = useState("");
  const [copied, setCopied] = useState("");
  async function call(command: Command) {
    if (lock.current) return { ok: false } as Result;
    lock.current = true;
    setPending(true);
    setError("");
    setMessage("");
    const result = await new Promise<Result>((resolve) =>
      host.dispatchEvent(
        new CustomEvent("wildwood:command", { detail: { command, done: resolve } }),
      ),
    );
    lock.current = false;
    setPending(false);
    if (!result.ok) setError(result.error || "The request could not be completed.");
    else setMessage(result.message || "");
    return result;
  }
  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
    } catch {
      setError("Copy failed. Select and copy the value manually.");
    }
  }
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(""), 5000);
    return () => clearTimeout(timer);
  }, [message]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(""), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  useEffect(() => {
    // Editing is persistent intent; picking is suspended while a surface is open.
    if (!selecting || !s.canEdit || panel || menuOpen) return;
    const removeIndicator = installContentIndicator();
    const target = (event: MouseEvent) =>
      event.target instanceof Element && !event.composedPath().includes(host)
        ? event.target.closest("[data-ww-contentmap]")
        : null;
    const click = async (event: MouseEvent) => {
      const el = target(event);
      if (!el) return;
      event.preventDefault();
      event.stopPropagation();
      const pageUrl = window.location.href;
      const result = await call({ type: "document", map: el.getAttribute("data-ww-contentmap") });
      if (result.ok) {
        saveAttempt.current = null;
        setDiscard(false);
        setDoc({ ...result, pageUrl });
        setSource(result.source || "");
        setOverride(false);
        setPanel("editor");
      } else {
        setSection("home");
        setMenuOpen(true);
      }
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelecting(false);
    };
    document.addEventListener("click", click, true);
    document.addEventListener("keydown", key);
    return () => {
      removeIndicator();
      document.removeEventListener("click", click, true);
      document.removeEventListener("keydown", key);
    };
  }, [selecting, s.canEdit, panel, menuOpen]);
  useEffect(() => {
    if (!s.canEdit) setSelecting(false);
  }, [s.canEdit]);
  const editor = s.actor && s.actor.role !== "reader";
  const mode =
    s.mode === "published" ? "Published" : s.mode === "draft" ? "Draft" : "Shared preview";
  useEffect(() => {
    if (!dirty) return;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);
  async function save() {
    if (!doc || pending || !dirty) return;
    const payload = {
      type: "save",
      pageUrl: doc.pageUrl,
      map: doc.map,
      source,
      revision: doc.revision,
      override,
    };
    saveAttempt.current = retryKey(saveAttempt.current, payload);
    const result = await call({ ...payload, command: saveAttempt.current.key });
    if (result.ok) {
      setPanel(null);
      setDoc(null);
      setDiscard(false);
      saveAttempt.current = null;
      setMessage("Draft saved");
    }
  }
  const close = () => {
    if (pending) return;
    if (dirty) {
      setDiscard(true);
      return;
    }
    setPanel(null);
    setError("");
  };
  const copyButton = (value: string, label: string) => (
    <Button
      variant="outline"
      size="icon"
      aria-label={`Copy ${label}`}
      onClick={() => copy(value, label)}
    >
      {copied === label ? <Check /> : <Copy />}
    </Button>
  );
  return (
    <>
      <div className="dock-wrap">
        {message && !menuOpen && !panel && (
          <div className="save-toast" role="status">
            <Check size={14} />
            {message}
          </div>
        )}
        {selecting && s.canEdit && (
          <Button
            className="edit-intent"
            variant="outline"
            aria-label="Turn off edit mode"
            aria-pressed={true}
            onClick={() => setSelecting(false)}
          >
            <MousePointer2 /> Editing <X />
          </Button>
        )}
        <Popover.Root
          open={menuOpen}
          onOpenChange={(open) => {
            setMenuOpen(open);
            if (open) {
              setSection("agent");
              setAgentStarted(true);
            }
          }}
        >
          <Popover.Trigger
            render={<Button className="launcher" variant="outline" size="icon" />}
            aria-label={`Open Wildwood — ${mode}`}
            title={selecting ? "Select content to edit. Escape cancels." : `Wildwood · ${mode}`}
          >
            <Wordmark />
            {s.mode === "draft" && <span className="launcher-dot" />}
          </Popover.Trigger>
          <Popover.Portal container={portal} keepMounted>
            <Popover.Positioner side="top" align="end" sideOffset={12} className="floating">
              <Popover.Popup className="agent-workspace" aria-busy={pending}>
                <div className="panel-heading">
                  {section !== "home" && section !== "agent" && (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Back to options"
                      onClick={() => setSection("home")}
                    >
                      <ChevronLeft />
                    </Button>
                  )}
                  <Popover.Title>
                    {section === "share"
                      ? "Share preview"
                      : section === "drafts"
                        ? "Your drafts"
                        : section === "home"
                          ? "Options"
                          : "Wildwood"}
                  </Popover.Title>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={section === "agent" ? "Open options" : "Back to agent"}
                    aria-expanded={section !== "agent"}
                    onClick={() => setSection(section === "agent" ? "home" : "agent")}
                  >
                    {section === "agent" ? <Ellipsis /> : <Bot />}
                  </Button>
                  <Popover.Close
                    render={<Button variant="ghost" size="icon" aria-label="Close Wildwood" />}
                  >
                    <X />
                  </Popover.Close>
                </div>
                <div className="toolbar-agent" hidden={section !== "agent"}>
                  {agentStarted &&
                    (editor ? (
                      <Suspense fallback={<div className="agent-empty">Opening agent…</div>}>
                        <AgentPanel endpoint={s.endpoint} draft={s.draft} />
                      </Suspense>
                    ) : (
                      <div className="agent-empty">
                        <Bot size={28} />
                        <h2>Your content, with a collaborator.</h2>
                        <p>
                          {s.actor
                            ? "Ask your site owner for editor access to work with the agent."
                            : "Sign in to work with your content agent."}
                        </p>
                        {!s.actor && (
                          <a
                            className="text-link"
                            href={`${s.endpoint}/sign-in?next=${encodeURIComponent(location.pathname + location.search)}`}
                          >
                            Sign in <ArrowUpRight size={14} />
                          </a>
                        )}
                      </div>
                    ))}
                </div>
                <div className="surface workspace-options" hidden={section === "agent"}>
                  {section === "home" && (
                    <>
                      <div className="workspace-context">
                        <span className={`dot ${s.mode === "draft" ? "draft" : ""}`} />
                        <strong>{mode}</strong>
                        <span>{s.actor?.name || "Guest"}</span>
                      </div>
                      <div className="workspace-actions">
                        {s.canEdit && (
                          <>
                            <Button
                              className="workspace-action"
                              variant="ghost"
                              disabled={pending}
                              onClick={() => {
                                setSelecting(!selecting);
                                setMenuOpen(false);
                                setError("");
                                setMessage("");
                              }}
                            >
                              <MousePointer2 />
                              {selecting ? "Turn off edit mode" : "Edit content"}
                            </Button>
                            <Button
                              className="workspace-action"
                              variant="ghost"
                              onClick={() => {
                                setShare("");
                                setError("");
                                setSection("share");
                              }}
                            >
                              <Share2 />
                              Share preview
                            </Button>
                            <Button
                              className="workspace-action"
                              variant="ghost"
                              disabled={pending}
                              onClick={async () => {
                                const r = await call({ type: "review" });
                                if (r.ok) {
                                  setReview(r.url!);
                                  setPanel("review");
                                  setMenuOpen(false);
                                }
                              }}
                            >
                              <FileCheck />
                              Review changes
                            </Button>
                          </>
                        )}
                        {editor && (
                          <a
                            className="workspace-action"
                            href={`${s.endpoint}/agent${s.draft ? `?draft=${encodeURIComponent(s.draft)}` : ""}`}
                          >
                            <ArrowUpRight /> Open full workspace
                          </a>
                        )}
                        <Button
                          className="workspace-action"
                          variant="ghost"
                          onClick={() => {
                            setPanel("agent");
                            setMenuOpen(false);
                          }}
                        >
                          <Bot />
                          Connect agent
                        </Button>
                        {editor && (
                          <>
                            <div className="workspace-separator" />
                            {s.mode === "published" && s.drafts[0] && (
                              <Button
                                className="workspace-action draft-action recent-draft"
                                variant="ghost"
                                disabled={pending}
                                onClick={() => call({ type: "resume", id: s.drafts[0].id })}
                              >
                                <GitBranch />
                                <span className="draft-label">
                                  <span className="draft-eyebrow">Resume draft</span>
                                  <span className="draft-name">{s.drafts[0].data.name}</span>
                                </span>
                                <RelativeTime value={s.drafts[0].updatedAt} />
                              </Button>
                            )}
                            <Button
                              className="workspace-action"
                              variant="ghost"
                              disabled={pending}
                              onClick={() => call({ type: "draft" })}
                            >
                              <Plus />
                              Create draft
                            </Button>
                            <Button
                              className="workspace-action"
                              variant="ghost"
                              onClick={() => setSection("drafts")}
                            >
                              <GitBranch />
                              Your drafts
                            </Button>
                          </>
                        )}
                        {s.mode !== "published" && (
                          <Button
                            className="workspace-action"
                            variant="ghost"
                            disabled={pending}
                            onClick={() => call({ type: "exit" })}
                          >
                            <LogOut />
                            Back to published
                          </Button>
                        )}
                        <div className="workspace-separator" />
                        {s.actor && (
                          <a className="workspace-link" href={`${s.endpoint}/media-library`}>
                            <Image />
                            Media library
                          </a>
                        )}
                        <a
                          className="workspace-link"
                          href={`${s.endpoint}/${s.actor ? "access" : "sign-in"}`}
                        >
                          <Shield />
                          {s.actor ? "Manage access" : "Sign in"}
                        </a>
                      </div>
                      <p className="snapshot">
                        Snapshot <code>{s.snapshot.slice(0, 8)}</code>
                      </p>
                    </>
                  )}
                  {section === "drafts" && (
                    <div className="workspace-actions draft-list">
                      {s.drafts.length ? (
                        s.drafts.map((d) => (
                          <Button
                            key={d.id}
                            className="workspace-action draft-action"
                            variant="ghost"
                            disabled={pending}
                            onClick={async () => {
                              const r = await call({ type: "resume", id: d.id });
                              if (r.ok) setSection("home");
                            }}
                          >
                            <GitBranch />
                            <span className="draft-name">{d.data.name}</span>
                            <RelativeTime value={d.updatedAt} />
                          </Button>
                        ))
                      ) : (
                        <p className="hint">No active drafts.</p>
                      )}
                      {!!s.completed?.length && (
                        <>
                          <p className="hint">Completed · Read-only</p>
                          {s.completed.map((d) => (
                            <a
                              key={d.id}
                              className="workspace-link draft-action"
                              href={`${s.endpoint}/review?id=${encodeURIComponent(d.review)}`}
                            >
                              <FileCheck />
                              <span className="draft-name">{d.data.name}</span>
                              <RelativeTime value={d.updatedAt} />
                            </a>
                          ))}
                        </>
                      )}
                    </div>
                  )}
                  {section === "share" && (
                    <>
                      <Popover.Description className="description">
                        A private, read-only link to your draft.
                      </Popover.Description>
                      <label>
                        Preview follows
                        <select
                          value={String(moving)}
                          onChange={(e) => {
                            setMoving(e.target.value === "true");
                            setShare("");
                          }}
                        >
                          <option value="false">This exact snapshot</option>
                          <option value="true">Latest draft changes</option>
                        </select>
                      </label>
                      <label>
                        Expires in
                        <select
                          value={minutes}
                          onChange={(e) => {
                            setMinutes(e.target.value);
                            setShare("");
                          }}
                        >
                          <option value="60">1 hour</option>
                          <option value="1440">1 day</option>
                          <option value="10080">7 days</option>
                        </select>
                      </label>
                      {share ? (
                        <>
                          <label>
                            Preview link
                            <div className="copy-row">
                              <input readOnly value={share} />
                              {copyButton(share, "preview link")}
                            </div>
                          </label>
                          <a className="text-link" href={share} target="_blank" rel="noreferrer">
                            Open preview <ArrowUpRight size={14} />
                          </a>
                        </>
                      ) : (
                        <Button
                          className="full"
                          disabled={pending}
                          onClick={async () => {
                            const r = await call({
                              type: "share",
                              moving,
                              minutes: Number(minutes),
                            });
                            if (r.ok) setShare(r.url!);
                          }}
                        >
                          {pending ? <Loader2 className="spin" /> : <Share2 />}Create link
                        </Button>
                      )}
                    </>
                  )}
                  {(error || message || pending) && (
                    <p className={error ? "error" : "hint"} role={error ? "alert" : "status"}>
                      {pending ? "Working…" : error || message}
                    </p>
                  )}
                </div>
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
      </div>
      <Dialog.Root
        open={!!panel}
        onOpenChange={(open) => {
          if (!open) close();
        }}
      >
        <Dialog.Portal container={portal}>
          <Dialog.Backdrop className="backdrop" />
          <Dialog.Popup className={`surface dialog ${panel === "editor" ? "editor" : ""}`}>
            <div className="panel-heading">
              <Dialog.Title>
                {panel === "editor"
                  ? "Edit source"
                  : panel === "agent"
                    ? "Connect agent"
                    : "Ready for review"}
              </Dialog.Title>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Close dialog"
                disabled={pending}
                onClick={close}
              >
                <X />
              </Button>
            </div>
            <Dialog.Description className="description">
              {panel === "editor"
                ? "Shape your content here. Save when it’s ready to preview on the page."
                : panel === "agent"
                  ? "Connect securely with your account."
                  : "Review this snapshot before publishing it."}
            </Dialog.Description>
            {panel === "editor" && doc && (
              <>
                <div className="file-path">
                  <GitBranch size={14} />
                  <span>{doc.path}</span>
                  {doc.field && <span className="field">{doc.field}</span>}
                </div>
                {doc.map && JSON.parse(doc.map).snapshot !== s.snapshot && (
                  <p className="error" role="alert">
                    This draft changed while the editor was open. Saving checks your original
                    revision and will never overwrite newer work.
                  </p>
                )}
                <Editor
                  source={source}
                  onChange={(value) => {
                    setSource(value);
                    setDiscard(false);
                  }}
                  onSave={save}
                  disabled={pending}
                  markdown={/\.mdx?$/i.test(doc.path ?? "")}
                  endpoint={s.endpoint}
                  snapshot={s.snapshot}
                />
                {doc.fallback && (
                  <label className="choice">
                    <input
                      type="checkbox"
                      checked={override}
                      onChange={(e) => setOverride(e.target.checked)}
                    />
                    Create an override for this variant
                  </label>
                )}
                {discard ? (
                  <div className="discard-bar" role="alert">
                    <span>Your changes haven’t been saved.</span>
                    <Button variant="ghost" onClick={() => setDiscard(false)}>
                      Keep editing
                    </Button>
                    <Button
                      variant="destructive"
                      onClick={() => {
                        setPanel(null);
                        setDoc(null);
                        setDiscard(false);
                        setError("");
                      }}
                    >
                      Discard changes
                    </Button>
                  </div>
                ) : (
                  <div className="footer editor-footer">
                    <span className={dirty ? "unsaved" : ""}>
                      <span className="status-dot" />
                      {dirty ? "Unsaved changes" : "Saved in your draft"}
                    </span>
                    <Button variant="ghost" onClick={close} disabled={pending}>
                      Close
                    </Button>
                    <Button onClick={save} disabled={pending || !dirty}>
                      {pending ? <Loader2 className="spin" /> : <Save />}{" "}
                      {pending ? "Saving…" : "Save draft"}
                      <kbd>⌘ S</kbd>
                    </Button>
                  </div>
                )}
              </>
            )}
            {panel === "agent" && (
              <>
                <p className="hint">
                  Add this MCP server to your agent. Sign in when prompted and choose its
                  permissions.
                </p>
                <label>
                  MCP server URL
                  <div className="copy-row">
                    <input readOnly value={s.mcpUrl} />
                    {copyButton(s.mcpUrl, "MCP server URL")}
                  </div>
                </label>
                <p className="hint">
                  {s.oauth
                    ? "Your agent handles sign-in and token refresh. No manual credential needed."
                    : "OAuth is not configured on this site. Configure an identity provider to connect an agent."}
                </p>
                <a className="text-link" href={`${s.endpoint}/access`}>
                  Manage connected agents <ArrowUpRight size={14} />
                </a>
                <a className="text-link" href={`${s.endpoint}/connect`}>
                  Setup and connection health <ArrowUpRight size={14} />
                </a>
              </>
            )}
            {panel === "review" && (
              <a className="text-link" href={review} target="_blank" rel="noreferrer">
                Open review <ArrowUpRight size={16} />
              </a>
            )}
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
class WildwoodToolbar extends HTMLElement {
  static observedAttributes = ["state"];
  private root?: Root;
  private mount?: HTMLElement;
  private portal?: HTMLElement;
  private sheet?: HTMLLinkElement;
  connectedCallback() {
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    this.sheet = document.createElement("link");
    this.sheet.rel = "stylesheet";
    this.mount = document.createElement("div");
    this.portal = document.createElement("div");
    this.shadowRoot!.replaceChildren(this.sheet, this.mount, this.portal);
    this.root = createRoot(this.mount);
    this.render();
  }
  disconnectedCallback() {
    const root = this.root;
    queueMicrotask(() => root?.unmount());
    this.root = undefined;
  }
  attributeChangedCallback() {
    this.render();
  }
  render() {
    if (!this.root) return;
    let state: State;
    try {
      state = JSON.parse(this.getAttribute("state") || "{}");
    } catch {
      return;
    }
    if (!state.endpoint) return;
    this.sheet!.href = state.css;
    this.root.render(<App state={state} host={this} portal={this.portal!} />);
  }
}
if (!customElements.get("wildwood-toolbar"))
  customElements.define("wildwood-toolbar", WildwoodToolbar);
