import { Tabs, TabsList, TabsTrigger, TabsContent } from "./ui/tabs";
import { Progress } from "./ui/progress";
import { SelectField } from "./ui/select-field";
import { Dialog, DialogContent, DialogClose, DialogTitle, DialogDescription } from "./ui/dialog";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Label } from "./ui/label";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "./ui/collapsible";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { AgentReference } from "./agent/panel";
import { Diff, type FileDiff } from "./diff";
import { requestJson } from "./request";
import { retryKey } from "./editor-model";
import {
  Bot,
  Leaf,
  GitBranch,
  Check,
  FileText,
  MessageSquare,
  Clock,
  ChevronDown,
  Columns2,
  AlignLeft,
  RefreshCw,
  ArrowUpRight,
  Shield,
  Send,
  UserPlus,
  X,
  Copy,
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  WrapText,
  CheckCheck,
} from "lucide-react";
import { DraftUpdate } from "./draft-update";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "./ui/dropdown-menu";
import type { createReviews, Change } from "../src/reviews";
type Review = Awaited<ReturnType<ReturnType<typeof createReviews>["get"]>>;
const context = JSON.parse(document.querySelector("#context")!.textContent!);
const when = (n: number) =>
  new Date(n).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
const request = (path: string, body?: unknown, signal?: AbortSignal) =>
  requestJson(context.endpoint + path, body, signal);
const AgentPanel = lazy(() => import("./agent/panel").then((m) => ({ default: m.AgentPanel })));
function App() {
  const [agentOpen, setAgentOpen] = useState(() => window.matchMedia("(min-width: 900px)").matches);
  const [decisionOpen, setDecisionOpen] = useState(false);
  const [agentReference, setAgentReference] = useState<AgentReference>();
  const [review, setReview] = useState<Review | null>(null),
    [revision, setRevision] = useState(""),
    [file, setFile] = useState(""),
    [fileResult, setLoaded] = useState<{ revision: string; value: FileDiff } | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [loadingFile, setLoadingFile] = useState(false),
    [refreshing, setRefreshing] = useState(false),
    [wrap, setWrap] = useState(true),
    [viewed, setViewed] = useState<Set<string>>(new Set()),
    [onlyUnviewed, setOnlyUnviewed] = useState(false);
  const refreshRequest = useRef<AbortController | null>(null);
  const commandLock = useRef(false);
  const decisionAttempt = useRef<{ payload: string; key: string } | null>(null);
  const [tab, setTab] = useState<"changes" | "activity">("changes"),
    [split, setSplit] = useState(false),
    [search, setSearch] = useState(""),
    [comment, setComment] = useState(""),
    [invite, setInvite] = useState(false),
    [scope, setScope] = useState("comment"),
    [link, setLink] = useState(""),
    [copied, setCopied] = useState(false),
    [confirmPublish, setConfirmPublish] = useState(false);
  const [handoff, setHandoff] = useState(false),
    [credential, setCredential] = useState<{ token: string; endpoint: string } | null>(null);
  const viewedKey = (change: Change) =>
    JSON.stringify([change.path, change.before, change.after, change.beforeMode, change.afterMode]);
  useEffect(() => {
    if (!review) return;
    const key = `wildwood:viewed:${review.actor.id}:${review.id}`;
    try {
      const saved = JSON.parse(localStorage.getItem(key) ?? "[]");
      if (Array.isArray(saved)) setViewed(new Set(saved.filter((v) => typeof v === "string")));
    } catch {
      /* Private browsing can disable storage. */
    }
  }, [review?.id, review?.actor.id]);
  useEffect(() => {
    if (!review) return;
    try {
      localStorage.setItem(
        `wildwood:viewed:${review.actor.id}:${review.id}`,
        JSON.stringify([...viewed]),
      );
    } catch {
      /* Viewed state remains usable in memory. */
    }
  }, [viewed]);
  useEffect(() => {
    const navigate = (event: KeyboardEvent) => {
      const element = event.target as HTMLElement;
      if (
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        element.closest("input,textarea,select,button,[contenteditable],[role=dialog]")
      )
        return;
      const changes = review?.revision.changes ?? [];
      const index = changes.findIndex((c) => c.path === file);
      if (event.key === "n" && index < changes.length - 1) {
        setFile(changes[index + 1].path);
        event.preventDefault();
      }
      if (event.key === "p" && index > 0) {
        setFile(changes[index - 1].path);
        event.preventDefault();
      }
      if (event.key === "u") {
        setSplit((v) => !v);
        event.preventDefault();
      }
      if (event.key === "v" && index >= 0) {
        const key = viewedKey(changes[index]);
        setViewed((old) => {
          const next = new Set(old);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        });
        event.preventDefault();
      }
      if (event.key === "c") {
        setDecisionOpen(true);
        event.preventDefault();
      }
    };
    window.addEventListener("keydown", navigate);
    return () => window.removeEventListener("keydown", navigate);
  }, [review, file]);
  async function refresh(rid = revision) {
    refreshRequest.current?.abort();
    const controller = new AbortController();
    refreshRequest.current = controller;
    setRefreshing(true);
    try {
      const r = await request(
        `/review/data?id=${encodeURIComponent(context.id)}${rid ? "&revision=" + encodeURIComponent(rid) : ""}`,
        undefined,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setReview(r);
      setRevision(r.revision.id);
      setFile((f) =>
        r.revision.changes.some((c: Change) => c.path === f)
          ? f
          : r.revision.changes[0]?.path || "",
      );
      setError("");
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      if (!controller.signal.aborted) setRefreshing(false);
    }
  }
  useEffect(() => {
    if (!context.invite) refresh().catch((e) => setError(e.message));
    return () => refreshRequest.current?.abort();
  }, []);
  useEffect(() => {
    if (!review || !file) {
      setLoaded(null);
      setLoadingFile(false);
      return;
    }
    const controller = new AbortController();
    setLoaded(null);
    setLoadingFile(true);
    setError("");
    request(
      `/review/file?id=${encodeURIComponent(review.id)}&revision=${encodeURIComponent(revision)}&path=${encodeURIComponent(file)}`,
      undefined,
      controller.signal,
    )
      .then((value) => {
        if (!controller.signal.aborted) setLoaded({ revision, value });
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingFile(false);
      });
    return () => {
      controller.abort();
    };
  }, [file, revision, review?.id]);
  async function command(body: Record<string, unknown>) {
    if (commandLock.current || refreshing) return null;
    commandLock.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await request("/command", { id: review?.id, revision, ...body });
      await refresh();
      return result;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      commandLock.current = false;
      setBusy(false);
    }
  }
  const loaded =
    fileResult?.revision === revision && fileResult.value.path === file ? fileResult.value : null;
  if (context.invite && !review)
    return (
      <div className="gate">
        <Leaf />
        <h1>You've been invited to review</h1>
        <p>
          Claim access to the source changes and discussion with your signed-in account. This
          invitation can be claimed once.
        </p>
        <Button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await request("/command", { type: "review-claim", token: context.invite });
              context.id = r.id;
              delete context.invite;
              history.replaceState(null, "", `${context.endpoint}/review?id=${r.id}`);
              await refresh();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          Accept invitation
        </Button>
        {error && <p role="alert">{error}</p>}
      </div>
    );
  if (!review)
    return (
      <div className="gate">
        <Leaf />
        <h1>{error ? "Review unavailable" : "Opening review…"}</h1>
        <p>{error || "Loading the immutable changeset."}</p>
        <a href="/">Back to site</a>
      </div>
    );
  const rev = review.revision,
    req = review.requirements;
  const visibleFiles = rev.changes.filter(
    (c) =>
      c.path.toLowerCase().includes(search.toLowerCase()) &&
      (!onlyUnviewed || !viewed.has(viewedKey(c))),
  );
  const viewedCount = rev.changes.filter((c) => viewed.has(viewedKey(c))).length;
  const fileIndex = visibleFiles.findIndex((c) => c.path === file);
  const current = !req.newerRevision;
  const published = review.status === "published";
  const blocked = req.targetAdvanced || req.changesRequested || !req.approved || !current;
  const status = published
    ? "Published"
    : review.status === "landing"
      ? "Publication pending"
      : !current
        ? "Earlier revision"
        : req.targetAdvanced
          ? "Base has changed"
          : req.changesRequested
            ? "Changes requested"
            : req.approved
              ? "Approved"
              : "Awaiting review";
  const pageLink = (path: string, index: number, side = "after") =>
    `${context.endpoint}/review/preview?id=${review.id}&revision=${revision}&path=${encodeURIComponent(path)}&page=${index}&side=${side}`;
  async function decision(type: string) {
    const body = {
      type: "review-decision",
      decision: type,
      body: comment,
      ...(tab === "changes" && file ? { path: file } : {}),
    };
    decisionAttempt.current = retryKey(decisionAttempt.current, {
      id: context.id,
      revision,
      ...body,
    });
    const r = await command({ ...body, command: decisionAttempt.current.key });
    if (r) {
      setComment("");
      setDecisionOpen(false);
      decisionAttempt.current = null;
    }
  }
  return (
    <div
      className={
        agentOpen && review.capabilities.updateDraft
          ? "review-workspace agent-open"
          : "review-workspace"
      }
    >
      <Tabs
        className="review-surface"
        value={tab}
        onValueChange={(value) => setTab(value as "changes" | "activity")}
      >
        <header className="review-header">
          <div className="review-identity">
            <a className="wordmark" href="/" aria-label="Back to site">
              <Leaf />
            </a>
            <span className="review-label">Review</span>
            <h1 title={review.name}>{review.name}</h1>
            <span className="review-file-count">
              {rev.changes.length} {rev.changes.length === 1 ? "file" : "files"}
            </span>
          </div>
          <div className="header-right">
            {review.capabilities.updateDraft && (
              <Button
                variant={agentOpen ? "secondary" : "outline"}
                aria-pressed={agentOpen}
                onClick={() => setAgentOpen(!agentOpen)}
              >
                <Bot /> {agentOpen ? "Hide agent" : "Show agent"}
              </Button>
            )}
            <span className="authority">
              <Shield size={13} />{" "}
              {review.authority.kind === "native" ? "Native review" : review.authority.label}
            </span>
            <span className="avatar">{review.actor.name.slice(0, 1)}</span>
          </div>
        </header>
        <nav className="review-tabs">
          <TabsList variant="line" aria-label="Review sections">
            <TabsTrigger value="changes">
              <FileText size={15} />
              Changes<span>{rev.changes.length}</span>
            </TabsTrigger>
            <TabsTrigger value="activity">
              <MessageSquare size={15} />
              Discussion<span>{review.activity.length}</span>
            </TabsTrigger>
          </TabsList>
          <div className="revision-controls">
            <span className="review-status">{status}</span>
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="ghost" />}>
                <Clock />
                Revision {review.revisions.findIndex((r) => r.id === revision) + 1}
                <ChevronDown />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64">
                {[...review.revisions]
                  .sort((a, b) => b.created - a.created)
                  .map((r, i) => (
                    <DropdownMenuItem
                      key={r.id}
                      disabled={busy || refreshing}
                      onClick={() => refresh(r.id).catch((e) => setError(e.message))}
                    >
                      Revision {review.revisions.length - i}
                      <span className="muted">{r.snapshot.slice(0, 8)}</span>
                      {r.id === revision && <Check />}
                    </DropdownMenuItem>
                  ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Refresh review"
              disabled={busy || refreshing}
              onClick={() => refresh().catch((e) => setError(e.message))}
            >
              <RefreshCw className={refreshing ? "spin" : ""} />
            </Button>
            <Button onClick={() => setDecisionOpen(true)}>
              {published ? "Review details" : "Submit review"}
              <ChevronDown />
            </Button>
          </div>
        </nav>
        {error && (
          <div className="global-error" role="alert">
            <AlertCircle size={16} />
            {error}
            <Button
              variant="ghost"
              size="icon"
              aria-label="Dismiss error"
              onClick={() => setError("")}
            >
              <X />
            </Button>
          </div>
        )}
        <div className="review-layout">
          <aside className="file-sidebar">
            <div className="sidebar-label">
              FILES CHANGED <span>{rev.changes.length}</span>
            </div>
            <Input
              className="search"
              aria-label="Filter files"
              placeholder="Find a file…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {!!rev.changes.length && (
              <div className="review-progress">
                <div>
                  <span>
                    {viewedCount} of {rev.changes.length} viewed
                  </span>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Show only unviewed files"
                    aria-pressed={onlyUnviewed}
                    onClick={() => setOnlyUnviewed(!onlyUnviewed)}
                  >
                    <CheckCheck />
                  </Button>
                </div>
                <Progress max={rev.changes.length} value={viewedCount} aria-label="Files viewed" />
              </div>
            )}
            <div className="file-list">
              {visibleFiles.map((c) => (
                <Button
                  variant="ghost"
                  key={c.path}
                  className={file === c.path ? "selected" : ""}
                  aria-current={file === c.path ? "true" : undefined}
                  onClick={() => {
                    setFile(c.path);
                    setTab("changes");
                  }}
                >
                  <span className={`file-state ${!c.before ? "added" : !c.after ? "deleted" : ""}`}>
                    {!c.before ? "A" : !c.after ? "D" : "M"}
                  </span>
                  <span title={c.path}>
                    {c.path.split("/").pop()}
                    <small>{c.path.split("/").slice(0, -1).join("/") || "/"}</small>
                  </span>
                  {viewed.has(viewedKey(c)) && (
                    <Check size={12} className="viewed-check" aria-label="Viewed" />
                  )}
                </Button>
              ))}
              {!visibleFiles.length && !!rev.changes.length && (
                <p className="filter-empty">
                  {onlyUnviewed && viewedCount === rev.changes.length
                    ? "All files viewed."
                    : "No files match your filter."}
                </p>
              )}
            </div>
            <div className="snapshot-info">
              <span>REVIEWED SNAPSHOT</span>
              <code>{rev.snapshot.slice(0, 12)}</code>
              <small>Source files across all variants</small>
            </div>
          </aside>
          <main className="review-main">
            {req.newerRevision && (
              <div className="context-note">
                You’re viewing an earlier revision. Decisions here do not approve the latest
                changes.{" "}
                <Button variant="ghost" onClick={() => refresh(review.revisions.at(-1)!.id)}>
                  View latest
                </Button>
              </div>
            )}
            {req.targetAdvanced && current && !published && review.capabilities.updateDraft && (
              <div className="context-note">
                <p>
                  Published content changed after this draft started. Git can combine compatible
                  edits and help you resolve conflicts.
                </p>
                <DraftUpdate
                  endpoint={context.endpoint}
                  draft={review.draft}
                  onUpdated={(id) => refresh(id)}
                />
              </div>
            )}
            {req.unsubmittedChanges && current && !published && (
              <div className="context-note">
                The draft has newer, unsubmitted changes. This review remains pinned to the snapshot
                shown here.
              </div>
            )}
            <TabsContent key={tab} value={tab}>
              {tab === "activity" ? (
                <div className="discussion">
                  <h2>Review activity</h2>
                  <p className="muted">
                    Decisions and comments stay attached to the revision that was reviewed.
                  </p>
                  {review.activity.length ? (
                    review.activity.map((e) => (
                      <article key={e.id} className="activity">
                        <span className="avatar">{e.name.slice(0, 1)}</span>
                        <div>
                          <p>
                            <strong>{e.name}</strong>{" "}
                            {e.type === "approve"
                              ? "approved"
                              : e.type === "request_changes"
                                ? "requested changes"
                                : "commented"}{" "}
                            <small>· {when(e.created)}</small>
                          </p>
                          <span className="activity-revision">
                            Revision {review.revisions.findIndex((r) => r.id === e.revision) + 1}
                            {e.path ? ` · ${e.path}` : ""}
                          </span>
                          {e.body && <p className="comment-body">{e.body}</p>}
                        </div>
                      </article>
                    ))
                  ) : (
                    <div className="empty-diff">
                      <MessageSquare />
                      <h3>Start the conversation</h3>
                      <p>Leave feedback or record your decision.</p>
                    </div>
                  )}
                </div>
              ) : (
                <>
                  {file ? (
                    <div className="diff-card">
                      {!!loaded?.pages?.length && (
                        <Collapsible className="file-pages">
                          <CollapsibleTrigger
                            render={<Button variant="ghost" className="disclosure-trigger" />}
                          >
                            Page previews
                          </CollapsibleTrigger>
                          <CollapsibleContent>
                            {loaded.pages.map((p, index) => (
                              <div key={JSON.stringify(p)}>
                                <span title={p.url}>
                                  {new URL(p.url).pathname +
                                    new URL(p.url).search +
                                    new URL(p.url).hash}
                                  <small>
                                    {Object.values(p.variant).join(" · ")} · schema {p.version}
                                  </small>
                                </span>
                                <a
                                  href={pageLink(file, index, "before")}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  Before <ArrowUpRight size={12} />
                                </a>
                                <a href={pageLink(file, index)} target="_blank" rel="noreferrer">
                                  After <ArrowUpRight size={12} />
                                </a>
                              </div>
                            ))}
                          </CollapsibleContent>
                        </Collapsible>
                      )}

                      <div className="diff-toolbar">
                        <span>
                          <FileText size={14} />
                          <strong>{file}</strong>
                        </span>
                        <div className="diff-actions">
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label="Previous file"
                            disabled={fileIndex <= 0}
                            onClick={() => setFile(visibleFiles[fileIndex - 1].path)}
                          >
                            <ChevronLeft />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label="Next file"
                            disabled={fileIndex < 0 || fileIndex >= visibleFiles.length - 1}
                            onClick={() => setFile(visibleFiles[fileIndex + 1].path)}
                          >
                            <ChevronRight />
                          </Button>
                          <Button
                            variant={
                              !!loaded && viewed.has(viewedKey(loaded)) ? "secondary" : "outline"
                            }
                            aria-pressed={!!loaded && viewed.has(viewedKey(loaded))}
                            disabled={!loaded}
                            onClick={() =>
                              setViewed((previous) => {
                                const next = new Set(previous);
                                const key = viewedKey(loaded!);
                                if (next.has(key)) next.delete(key);
                                else next.add(key);
                                return next;
                              })
                            }
                          >
                            <Check size={14} />
                            Viewed
                          </Button>
                          <Button
                            variant={wrap ? "secondary" : "ghost"}
                            size="icon"
                            aria-label="Wrap long lines"
                            aria-pressed={wrap}
                            onClick={() => setWrap(!wrap)}
                          >
                            <WrapText />
                          </Button>
                          <div className="view-switch" aria-label="Diff layout">
                            <Button
                              variant={!split ? "secondary" : "ghost"}
                              aria-pressed={!split}
                              aria-label="Unified diff"
                              onClick={() => setSplit(false)}
                            >
                              <AlignLeft />
                            </Button>
                            <Button
                              variant={split ? "secondary" : "ghost"}
                              aria-pressed={split}
                              aria-label="Side-by-side diff"
                              onClick={() => setSplit(true)}
                            >
                              <Columns2 />
                            </Button>
                          </div>
                        </div>
                      </div>
                      {loadingFile ? (
                        <div className="diff-loading" role="status">
                          <span />
                          <span />
                          <span />
                          <span />
                          <p>Loading file…</p>
                        </div>
                      ) : loaded ? (
                        loaded.beforeContent.media || loaded.afterContent.media ? (
                          <div className="media-comparison">
                            {(["before", "after"] as const).map((side) => {
                              const content =
                                loaded[side === "before" ? "beforeContent" : "afterContent"];
                              const url =
                                context.endpoint +
                                "/review/media?" +
                                new URLSearchParams({ id: review.id, revision, path: file, side });
                              return (
                                <figure key={side}>
                                  <figcaption>
                                    {side === "before" ? "Before" : "After"} ·{" "}
                                    {content.size.toLocaleString()} bytes
                                  </figcaption>
                                  {!loaded[side] ? (
                                    <p>No file</p>
                                  ) : (
                                    <>
                                      <div className="media-canvas">
                                        {content.media?.kind === "image" ? (
                                          <img
                                            src={url}
                                            alt={`${side === "before" ? "Before" : "After"}: ${file}`}
                                          />
                                        ) : content.media?.kind === "video" ? (
                                          <video controls preload="metadata" src={url} />
                                        ) : content.media?.kind === "audio" ? (
                                          <audio controls preload="metadata" src={url} />
                                        ) : (
                                          <p>Preview unavailable</p>
                                        )}
                                      </div>
                                      <a href={url} download>
                                        Download {side} version
                                      </a>
                                    </>
                                  )}
                                </figure>
                              );
                            })}
                          </div>
                        ) : (
                          <Diff
                            key={`${revision}:${file}`}
                            value={loaded}
                            split={split}
                            wrap={wrap}
                            onAskAgent={
                              review.capabilities.updateDraft
                                ? (selection) => {
                                    setAgentReference({
                                      id: crypto.randomUUID(),
                                      path: file,
                                      revision,
                                      ...selection,
                                    });
                                    setAgentOpen(true);
                                  }
                                : undefined
                            }
                            onComment={
                              review.capabilities.comment
                                ? (selection) => {
                                    setComment(
                                      `Revision ${revision} · ${selection.side} lines ${selection.start}–${selection.end}:\n> ${selection.text.slice(0, 6000).replaceAll("\n", "\n> ")}\n\n`,
                                    );
                                    setDecisionOpen(true);
                                  }
                                : undefined
                            }
                          />
                        )
                      ) : null}
                    </div>
                  ) : (
                    <div className="empty-diff">
                      <Check />
                      <h2>Nothing to compare</h2>
                      <p>This revision matches its base snapshot.</p>
                    </div>
                  )}
                </>
              )}
            </TabsContent>
          </main>
        </div>
        <Dialog open={decisionOpen} onOpenChange={setDecisionOpen}>
          <DialogContent
            showCloseButton={false}
            className="review-dialog decision-dialog"
            initialFocus={published ? undefined : () => document.getElementById("comment")}
          >
            <div className="panel-heading">
              <DialogTitle>{published ? "Review details" : "Submit review"}</DialogTitle>
              <DialogClose
                render={<Button variant="ghost" size="icon" aria-label="Close review options" />}
              >
                <X />
              </DialogClose>
            </div>
            <DialogDescription>
              Decisions apply to the selected revision. Only an approved current revision can be
              published.
            </DialogDescription>
            <div className="decision-content">
              <div className="decision-card">
                <div className="sidebar-label">REVIEW STATUS</div>
                <h2>{status}</h2>
                <ul className="requirements">
                  <li className={req.approved && !req.changesRequested ? "met" : ""}>
                    <Check size={14} />
                    {req.changesRequested
                      ? "Changes need attention"
                      : req.approved
                        ? "Revision approved"
                        : "Approval required"}
                  </li>
                  <li className={!req.targetAdvanced ? "met" : ""}>
                    <GitBranch size={14} />
                    {published
                      ? "Snapshot landed"
                      : req.targetAdvanced
                        ? "Published content has advanced"
                        : "Target matches review base"}
                  </li>
                  <li className="met">
                    <Shield size={14} />
                    Wildwood controls publication
                  </li>
                </ul>
                {!published && (
                  <>
                    <Label className="comment-label" htmlFor="comment">
                      {file && tab === "changes" ? "Feedback on this file" : "Review feedback"}
                    </Label>
                    <Textarea
                      id="comment"
                      placeholder="What should the author know?"
                      value={comment}
                      onChange={(e) => setComment(e.target.value)}
                      disabled={!review.capabilities.comment || busy}
                    />
                    <Button
                      className="wide"
                      variant="outline"
                      disabled={busy || !comment.trim() || !review.capabilities.comment}
                      onClick={() => decision("comment")}
                    >
                      <Send />
                      Add comment
                    </Button>
                    {review.capabilities.approve && current && (
                      <div className="decision-buttons">
                        <Button
                          disabled={busy}
                          variant="outline"
                          onClick={() => decision("request_changes")}
                        >
                          Request changes
                        </Button>
                        <Button
                          disabled={busy || req.targetAdvanced}
                          onClick={() => decision("approve")}
                        >
                          <Check />
                          Approve
                        </Button>
                      </div>
                    )}
                    {review.capabilities.publish && (
                      <Button
                        className="wide publish"
                        disabled={busy || (review.status !== "landing" && blocked)}
                        onClick={() => {
                          setDecisionOpen(false);
                          setConfirmPublish(true);
                        }}
                      >
                        {review.status === "landing"
                          ? "Reconcile publication"
                          : "Publish approved revision"}
                        <ArrowUpRight />
                      </Button>
                    )}
                  </>
                )}
                {review.capabilities.publish && !published && (
                  <Button
                    className="wide handoff-button"
                    variant="outline"
                    disabled={blocked || busy || review.status !== "open"}
                    onClick={() => {
                      setDecisionOpen(false);
                      setCredential(null);
                      setHandoff(true);
                    }}
                  >
                    Delegate publication
                  </Button>
                )}
                {published && (
                  <p className="muted">
                    The reviewed snapshot is now published. Deployment status is managed by the host
                    application.
                  </p>
                )}
              </div>
              <div className="review-details">
                <h3>Review details</h3>
                <div className="preview-links">
                  <a
                    href={`${context.endpoint}/review/preview?id=${review.id}&revision=${revision}&side=before`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Before preview <ArrowUpRight size={12} />
                  </a>
                  <a
                    href={`${context.endpoint}/review/preview?id=${review.id}&revision=${revision}&side=after`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    After preview <ArrowUpRight size={12} />
                  </a>
                </div>
                <dl>
                  <dt>Provider</dt>
                  <dd>{review.authority.label}</dd>
                  <dt>Schema</dt>
                  <dd>{rev.version}</dd>
                  <dt>Preview context</dt>
                  <dd>
                    {Object.entries(rev.variant)
                      .map(([k, v]) => `${k}: ${v}`)
                      .join(", ") || "Default"}
                  </dd>
                  <dt>Base</dt>
                  <dd>
                    <code>{rev.base.slice(0, 10)}</code>
                  </dd>
                </dl>
                {review.capabilities.invite && (
                  <Button
                    variant="outline"
                    className="wide"
                    onClick={() => {
                      setDecisionOpen(false);
                      setInvite(true);
                      setLink("");
                      setCopied(false);
                    }}
                  >
                    <UserPlus />
                    Invite reviewer
                  </Button>
                )}
                {review.handoffs?.map((g) => (
                  <div key={g.grant} className="review-grant">
                    <span>
                      Publication grant<small>Expires {when(g.expires)}</small>
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Revoke publication grant"
                      disabled={busy}
                      onClick={() => command({ type: "review-handoff-revoke", grant: g.grant })}
                    >
                      <X />
                    </Button>
                  </div>
                ))}
                {review.grants?.map((g) => (
                  <div className="review-grant" key={g.id}>
                    <span>
                      {g.name || "Unclaimed invitation"}
                      <small>
                        {g.scope} · expires {when(g.expires)}
                      </small>
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Revoke ${g.name || "invitation"}`}
                      disabled={busy}
                      onClick={() => command({ type: "review-revoke", grant: g.id })}
                    >
                      <X />
                    </Button>
                  </div>
                ))}
              </div>
            </div>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
          </DialogContent>
        </Dialog>
        <Dialog
          open={handoff}
          onOpenChange={(open) => {
            setHandoff(open);
            if (!open) setCredential(null);
          }}
        >
          <DialogContent showCloseButton={false} className="review-dialog">
            <div className="panel-heading">
              <DialogTitle>Delegate publication</DialogTitle>
              <DialogClose
                render={<Button variant="ghost" size="icon" aria-label="Close handoff" />}
              >
                <X />
              </DialogClose>
            </div>
            <DialogDescription>
              Give an agent permission to publish this exact approved revision. It cannot edit
              content or approve another revision. New operations expire after 10 minutes.
            </DialogDescription>
            {credential ? (
              <>
                <Label>
                  MCP endpoint
                  <Input readOnly value={credential.endpoint} />
                </Label>
                <Label>
                  Bearer credential
                  <Input readOnly value={credential.token} />
                </Label>
                <p>Copy the credential before closing. Revoke it from Review details.</p>
                <Button
                  className="wide"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(credential.token);
                      setCopied(true);
                    } catch {
                      setError("Copy the credential manually.");
                    }
                  }}
                >
                  {copied ? "Copied" : "Copy credential"}
                </Button>
              </>
            ) : (
              <Button
                className="wide"
                disabled={busy}
                onClick={async () => {
                  const r = await command({ type: "review-handoff" });
                  if (r) {
                    setCredential(r);
                    setCopied(false);
                  }
                }}
              >
                Issue publication grant
              </Button>
            )}
            {error && <p role="alert">{error}</p>}
          </DialogContent>
        </Dialog>
        <Dialog
          open={invite || confirmPublish}
          onOpenChange={(open) => {
            if (!open && !busy) {
              setInvite(false);
              setConfirmPublish(false);
            }
          }}
        >
          <DialogContent showCloseButton={false} className="review-dialog">
            <div className="panel-heading">
              <DialogTitle>{invite ? "Invite a reviewer" : "Publish this revision?"}</DialogTitle>
              <DialogClose
                render={
                  <Button variant="ghost" size="icon" aria-label="Close dialog" disabled={busy} />
                }
              >
                <X />
              </DialogClose>
            </div>
            <DialogDescription>
              {invite
                ? "A one-person invitation to this review. They sign in to claim access. Publication stays with an owner."
                : "This publishes the exact approved snapshot. Concurrent changes to main will block publication."}
            </DialogDescription>
            {invite ? (
              <>
                <Label>
                  Access
                  <SelectField
                    label="Reviewer permissions"
                    value={scope}
                    onValueChange={(value) => setScope(value)}
                    disabled={!!link}
                    options={[
                      { value: "comment", label: "View source and comment" },
                      { value: "approve", label: "View source, comment, and approve" },
                    ]}
                  />
                </Label>
                <p className="muted">
                  Expires after 24 hours. Publication still requires an owner.
                </p>
                {link ? (
                  <>
                    <Input aria-label="Reviewer invitation" readOnly value={link} />
                    <Button
                      className="wide"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(link);
                          setCopied(true);
                        } catch {
                          setError("Copy the invitation manually.");
                        }
                      }}
                    >
                      {copied ? <Check /> : <Copy />}
                      {copied ? "Copied" : "Copy invitation"}
                    </Button>
                  </>
                ) : (
                  <Button
                    className="wide"
                    disabled={busy}
                    onClick={async () => {
                      const result = await command({
                        type: "review-invite",
                        scope,
                        minutes: 1440,
                      });
                      if (result) setLink(result.url);
                    }}
                  >
                    Create invitation
                  </Button>
                )}
              </>
            ) : (
              <>
                <code className="confirmation-sha">{rev.snapshot}</code>
                <Button
                  className="wide"
                  disabled={busy}
                  onClick={async () => {
                    if (await command({ type: "publish" })) setConfirmPublish(false);
                  }}
                >
                  {busy ? "Publishing…" : "Publish snapshot"}
                </Button>
              </>
            )}
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
          </DialogContent>
        </Dialog>
      </Tabs>
      {review.capabilities.updateDraft && (
        <aside className="review-agent-dock" hidden={!agentOpen} aria-label="Content agent">
          <Suspense fallback={<div className="agent-empty">Opening agent…</div>}>
            <AgentPanel
              endpoint={context.endpoint}
              draft={review.draft}
              reference={agentReference}
              onReferenceUsed={() => setAgentReference(undefined)}
              onChanged={() => {
                refresh().catch((e) => setError(e.message));
              }}
            />
          </Suspense>
        </aside>
      )}
    </div>
  );
}
createRoot(document.querySelector("#review-root")!).render(<App />);
