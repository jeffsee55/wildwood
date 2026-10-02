import { memo, useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Dialog } from "@base-ui/react/dialog";
import { structuredPatch, diffWordsWithSpace } from "diff";
import {
  Leaf,
  ArrowLeft,
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
} from "lucide-react";
import { DraftUpdate } from "./draft-update";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "./ui/dropdown-menu";
import type { Revision, Change } from "../src/reviews";
type Review = {
  draft: string;
  id: string;
  authority: { kind: "native" | "external"; label: string; target: string };
  handoffs: { grant: string; revision: string; expires: number }[];
  grants: {
    id: string;
    scope: string;
    subject: string | null;
    name: string | null;
    expires: number;
  }[];
  name: string;
  title: string;
  ref: string;
  status: string;
  revisions: Revision[];
  revision: Revision;
  published?: string;
  actor: { id: string; name: string; role: string };
  activity: {
    id: string;
    name: string;
    actor: string;
    revision: string;
    type: string;
    body: string;
    path?: string;
    created: number;
  }[];
  requirements: {
    approved: boolean;
    changesRequested: boolean;
    targetAdvanced: boolean;
    newerRevision: boolean;
    unsubmittedChanges: boolean;
  };
  capabilities: {
    updateDraft: boolean;
    comment: boolean;
    approve: boolean;
    publish: boolean;
    invite: boolean;
  };
};
type FileDiff = Change & {
  beforeContent: { source: string | null; size: number; binary: boolean; tooLarge?: boolean };
  afterContent: { source: string | null; size: number; binary: boolean; tooLarge?: boolean };
};
const context = JSON.parse(document.querySelector("#context")!.textContent!);
const when = (n: number) =>
  new Date(n).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
async function request(path: string, body?: unknown) {
  const r = await fetch(context.endpoint + path, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json();
  if (!r.ok || data.ok === false) throw new Error(data.error || "Request failed");
  return data;
}
function App() {
  const [review, setReview] = useState<Review | null>(null),
    [revision, setRevision] = useState(""),
    [file, setFile] = useState(""),
    [loaded, setLoaded] = useState<FileDiff | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [loadingFile, setLoadingFile] = useState(false);
  const [tab, setTab] = useState<"changes" | "activity">("changes"),
    [split, setSplit] = useState(true),
    [search, setSearch] = useState(""),
    [comment, setComment] = useState(""),
    [invite, setInvite] = useState(false),
    [scope, setScope] = useState("comment"),
    [link, setLink] = useState(""),
    [copied, setCopied] = useState(false),
    [confirmPublish, setConfirmPublish] = useState(false);
  const [handoff, setHandoff] = useState(false),
    [credential, setCredential] = useState<{ token: string; endpoint: string } | null>(null);
  async function refresh(rid = revision) {
    const r = await request(
      `/review/data?id=${encodeURIComponent(context.id)}${rid ? "&revision=" + encodeURIComponent(rid) : ""}`,
    );
    setReview(r);
    setRevision(r.revision.id);
    setFile((f) =>
      r.revision.changes.some((c: Change) => c.path === f) ? f : r.revision.changes[0]?.path || "",
    );
  }
  useEffect(() => {
    if (!context.invite) refresh().catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    if (!review || !file) {
      setLoaded(null);
      return;
    }
    let active = true;
    setLoaded(null);
    setLoadingFile(true);
    request(
      `/review/file?id=${encodeURIComponent(review.id)}&revision=${encodeURIComponent(revision)}&path=${encodeURIComponent(file)}`,
    )
      .then((value) => {
        if (active) setLoaded(value);
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoadingFile(false);
      });
    return () => {
      active = false;
    };
  }, [file, revision, review?.id]);
  async function command(body: Record<string, unknown>) {
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
      setBusy(false);
    }
  }
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
  const sourcePages = [
    ...new Map(
      rev.changes.flatMap((c) =>
        (c.pages ?? []).map(
          (page, index) => [JSON.stringify(page), { ...page, path: c.path, index }] as const,
        ),
      ),
    ).values(),
  ];
  async function decision(type: string) {
    const r = await command({
      type: "review-decision",
      decision: type,
      body: comment,
      ...(tab === "changes" && file ? { path: file } : {}),
    });
    if (r) setComment("");
  }
  return (
    <>
      <header className="review-header">
        <a className="wordmark" href="/">
          <Leaf />
          wildwood<span>/</span>
          <span>review</span>
        </a>
        <div className="header-right">
          <span className="authority">
            <Shield size={13} />{" "}
            {review.authority.kind === "native" ? "Native review" : review.authority.label}
          </span>
          <span className="avatar">{review.actor.name.slice(0, 1)}</span>
        </div>
      </header>
      <section className="review-heading">
        <a className="back" href="/">
          <ArrowLeft size={13} />
          Back to site
        </a>
        <div className="title-row">
          <div>
            <div className="eyebrow">
              CONTENT REVIEW <span>#{review.id.slice(0, 6)}</span>
            </div>
            <h1>
              {review.revision.changes.length
                ? `Review ${review.revision.changes.length} changed ${review.revision.changes.length === 1 ? "file" : "files"}`
                : "No content changes"}
            </h1>
          </div>
          <span className={`status-pill ${published || req.approved ? "approved" : ""}`}>
            <span />
            {status}
          </span>
        </div>
        <div className="review-meta">
          <span>{review.name}</span>
          <span>proposes changes to</span>
          <code>
            <GitBranch size={12} />
            main
          </code>
          <span>·</span>
          <span>{when(rev.created)}</span>
        </div>
        {!!sourcePages.length && (
          <div className="source-pages-summary">
            <span>Edited on</span>
            {sourcePages.slice(0, 6).map((p) => (
              <a
                key={JSON.stringify(p)}
                href={pageLink(p.path, p.index)}
                target="_blank"
                rel="noreferrer"
              >
                {new URL(p.url).pathname}
                <ArrowUpRight size={12} />
              </a>
            ))}
            {sourcePages.length > 6 && <span>+{sourcePages.length - 6} more</span>}
          </div>
        )}
      </section>
      <nav className="review-tabs">
        <div>
          <button className={tab === "changes" ? "active" : ""} onClick={() => setTab("changes")}>
            <FileText size={15} />
            Changes<span>{rev.changes.length}</span>
          </button>
          <button className={tab === "activity" ? "active" : ""} onClick={() => setTab("activity")}>
            <MessageSquare size={15} />
            Discussion<span>{review.activity.length}</span>
          </button>
        </div>
        <div className="revision-controls">
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
            onClick={() => refresh().catch((e) => setError(e.message))}
          >
            <RefreshCw />
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
          <input
            className="search"
            aria-label="Filter files"
            placeholder="Find a file…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="file-list">
            {rev.changes
              .filter((c) => c.path.toLowerCase().includes(search.toLowerCase()))
              .map((c) => (
                <button
                  key={c.path}
                  className={file === c.path ? "selected" : ""}
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
                </button>
              ))}
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
              You’re viewing an earlier revision. Decisions here do not approve the latest changes.{" "}
              <button onClick={() => refresh(review.revisions.at(-1)!.id)}>View latest</button>
            </div>
          )}
          {req.targetAdvanced && current && !published && review.capabilities.updateDraft && (
            <div className="context-note">
              <p>
                Published content changed after this draft started. Git can combine compatible edits
                and help you resolve conflicts.
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
                    <div className="file-pages">
                      <span>EDITED ON</span>
                      {loaded.pages.map((p, index) => (
                        <div key={JSON.stringify(p)}>
                          <span title={p.url}>
                            {new URL(p.url).pathname + new URL(p.url).search + new URL(p.url).hash}
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
                    </div>
                  )}

                  <div className="diff-toolbar">
                    <span>
                      <FileText size={14} />
                      <strong>{file}</strong>
                    </span>
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
                  {loadingFile ? (
                    <div className="empty-diff">Loading file…</div>
                  ) : loaded ? (
                    <Diff value={loaded} split={split} />
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
        </main>
        <aside className="decision-sidebar">
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
                <label className="comment-label" htmlFor="comment">
                  {file && tab === "changes" ? "Feedback on this file" : "Review feedback"}
                </label>
                <textarea
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
                    onClick={() => setConfirmPublish(true)}
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
        </aside>
      </div>
      <Dialog.Root
        open={handoff}
        onOpenChange={(open) => {
          setHandoff(open);
          if (!open) setCredential(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Backdrop className="review-backdrop" />
          <Dialog.Popup className="review-dialog">
            <div className="panel-heading">
              <Dialog.Title>Delegate publication</Dialog.Title>
              <Dialog.Close
                render={<Button variant="ghost" size="icon" aria-label="Close handoff" />}
              >
                <X />
              </Dialog.Close>
            </div>
            <Dialog.Description>
              Give an agent permission to publish this exact approved revision. It cannot edit
              content or approve another revision. New operations expire after 10 minutes.
            </Dialog.Description>
            {credential ? (
              <>
                <label>
                  MCP endpoint
                  <input readOnly value={credential.endpoint} />
                </label>
                <label>
                  Bearer credential
                  <input readOnly value={credential.token} />
                </label>
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
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
      <Dialog.Root
        open={invite || confirmPublish}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setInvite(false);
            setConfirmPublish(false);
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Backdrop className="review-backdrop" />
          <Dialog.Popup className="review-dialog">
            <div className="panel-heading">
              <Dialog.Title>{invite ? "Invite a reviewer" : "Publish this revision?"}</Dialog.Title>
              <Dialog.Close
                render={
                  <Button variant="ghost" size="icon" aria-label="Close dialog" disabled={busy} />
                }
              >
                <X />
              </Dialog.Close>
            </div>
            <Dialog.Description>
              {invite
                ? "A one-person invitation to this review. They sign in to claim access. Publication stays with an owner."
                : "This publishes the exact approved snapshot. Concurrent changes to main will block publication."}
            </Dialog.Description>
            {invite ? (
              <>
                <label>
                  Access
                  <select
                    value={scope}
                    onChange={(e) => setScope(e.target.value)}
                    disabled={!!link}
                  >
                    <option value="comment">View source and comment</option>
                    <option value="approve">View source, comment, and approve</option>
                  </select>
                </label>
                <p className="muted">
                  Expires after 24 hours. Publication still requires an owner.
                </p>
                {link ? (
                  <>
                    <input aria-label="Reviewer invitation" readOnly value={link} />
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
                      const result = await command({ type: "review-invite", scope, minutes: 1440 });
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
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
const Diff = memo(function Diff({ value, split }: { value: FileDiff; split: boolean }) {
  const a = value.beforeContent,
    b = value.afterContent;
  if (a.binary || b.binary || a.tooLarge || b.tooLarge)
    return (
      <div className="empty-diff">
        <FileText />
        <h3>
          {a.binary || b.binary ? "Binary file changed" : "File exceeds the inline diff limit"}
        </h3>
        <p>
          {a.size.toLocaleString()} → {b.size.toLocaleString()} bytes
        </p>
        <p>Both immutable blob identifiers remain in the review.</p>
      </div>
    );
  const patch = structuredPatch(
    value.path,
    value.path,
    a.source || "",
    b.source || "",
    "Before",
    "After",
    { context: 4, timeout: 150, maxEditLength: 10000 },
  );
  if (!patch)
    return <div className="empty-diff">This diff is too large to compute interactively.</div>;
  const word = (text: string, other: string, added: boolean) =>
    text.length < 1200 && other.length < 1200
      ? (diffWordsWithSpace(other, text, { timeout: 10 })
          ?.filter((p) => !p.removed)
          .map((p, i) => (
            <span key={i} className={p.added ? (added ? "word-added" : "word-removed") : ""}>
              {p.value}
            </span>
          )) ?? text)
      : text;
  return (
    <>
      <div className="diff-meta">
        <span>
          {value.beforeMode !== value.afterMode
            ? `Mode ${value.beforeMode || "—"} → ${value.afterMode || "—"}`
            : "Source diff"}
        </span>
        <span>
          {a.size.toLocaleString()} → {b.size.toLocaleString()} bytes
        </span>
      </div>
      {split && (
        <div className="split-labels">
          <span>Before</span>
          <span>After</span>
        </div>
      )}
      <div className="diff-scroll">
        <table className={`diff-table ${split ? "split" : ""}`}>
          <colgroup>
            <col className="number-column" />
            {split ? (
              <>
                <col />
                <col className="number-column" />
                <col />
              </>
            ) : (
              <>
                <col className="number-column" />
                <col />
              </>
            )}
          </colgroup>
          <tbody>
            {patch.hunks.flatMap((h, hi) => {
              let left = h.oldStart,
                right = h.newStart;
              const rows: ReactNode[] = [
                <tr className="hunk" key={`h${hi}`}>
                  <td colSpan={split ? 4 : 3}>
                    @@ −{h.oldStart},{h.oldLines} +{h.newStart},{h.newLines} @@
                  </td>
                </tr>,
              ];
              for (let i = 0; i < h.lines.length; i++) {
                const line = h.lines[i],
                  kind = line[0],
                  text = line.slice(1);
                if (kind === "\\") continue;
                if (split && (kind === "-" || kind === "+")) {
                  const removed: string[] = [],
                    added: string[] = [];
                  while (i < h.lines.length && h.lines[i][0] === "-")
                    removed.push(h.lines[i++].slice(1));
                  while (i < h.lines.length && h.lines[i][0] === "+")
                    added.push(h.lines[i++].slice(1));
                  i--;
                  for (let n = 0; n < Math.max(removed.length, added.length); n++) {
                    rows.push(
                      <tr key={`${hi}-${i}-${n}`}>
                        <td className={removed[n] !== undefined ? "minus gutter" : "gutter"}>
                          {removed[n] !== undefined ? left++ : ""}
                        </td>
                        <td className={removed[n] !== undefined ? "minus code" : "code empty"}>
                          {removed[n] !== undefined ? word(removed[n], added[n] ?? "", false) : ""}
                        </td>
                        <td className={added[n] !== undefined ? "plus gutter" : "gutter"}>
                          {added[n] !== undefined ? right++ : ""}
                        </td>
                        <td className={added[n] !== undefined ? "plus code" : "code empty"}>
                          {added[n] !== undefined ? word(added[n], removed[n] ?? "", true) : ""}
                        </td>
                      </tr>,
                    );
                  }
                  continue;
                }
                rows.push(
                  split ? (
                    <tr key={`${hi}-${i}`}>
                      <td className="gutter">{left++}</td>
                      <td className="code">{text}</td>
                      <td className="gutter">{right++}</td>
                      <td className="code">{text}</td>
                    </tr>
                  ) : (
                    <tr
                      key={`${hi}-${i}`}
                      className={kind === "+" ? "plus" : kind === "-" ? "minus" : ""}
                    >
                      <td className="gutter">{kind !== "+" ? left++ : ""}</td>
                      <td className="gutter">{kind !== "-" ? right++ : ""}</td>
                      <td className="code">
                        <span className="line-sign">{kind}</span>
                        {text}
                      </td>
                    </tr>
                  ),
                );
              }
              return rows;
            })}
          </tbody>
        </table>
        {!patch.hunks.length && (
          <div className="empty-diff">
            File contents are unchanged.
            {value.beforeMode !== value.afterMode ? " File mode changed." : ""}
          </div>
        )}
      </div>
    </>
  );
});
createRoot(document.querySelector("#review-root")!).render(<App />);
