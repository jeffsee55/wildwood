"use client";

import { Check, GitBranch, Loader2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";
import { createPortal } from "react-dom";

import { Button } from "@/components/ui/button";
import { KitAuthPanel, type KitAuthConfig } from "@/components/kit-auth-panel";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { generateBranchName } from "@/lib/generate-branch-name";
import { useShadowContainer } from "@/lib/shadow-root";
import { cn } from "@/lib/utils";

/** Must match `tr33.closeEmbeddedEditor` in packages/extension (postMessage to top). */
const TR33_KIT_CLOSE_MESSAGE = "tr33-kit-close-editor";
/** Must match `notifyKitParentBranchChanged` in packages/extension. */
const TR33_KIT_BRANCH_CHANGED_MESSAGE = "tr33-kit-branch-changed";
/** Must match `notifyKitParentWorkspaceChanged` in packages/extension. */
const TR33_KIT_WORKSPACE_CHANGED_MESSAGE = "tr33-kit-workspace-changed";
/** Session-scoped ref when opening the editor off the default config ref (tab survives navigations). */
const TR33_KIT_SESSION_EDITOR_REF_KEY = "tr33.kit.sessionEditorRef";
/** Must match `TR33_SYNC_HOST_ACTIVE_REF_HEADER` in `tr33` (`preview-cookies`). */
const TR33_SYNC_HOST_ACTIVE_REF_HEADER = "x-tr33-sync-host-active-ref";
/**
 * Same-origin BroadcastChannel name — must match `subscribeHostRef` in `tr33-vscode` (`host-bridge.ts`).
 */
const TR33_KIT_HOST_REF_CHANNEL = "tr33-kit-host-ref";
/**
 * Extension host → Kit (branch / ref sync). Must match `TR33_EXTENSION_TO_HOST_REF_CHANNEL` in `host-bridge.ts`.
 */
const TR33_EXTENSION_TO_HOST_REF_CHANNEL = "tr33-extension-to-host";
/** Must match `TR33_EXTENSION_WORKSPACE_CHANGED_CHANNEL` in `host-bridge.ts`. */
const TR33_EXTENSION_WORKSPACE_CHANGED_CHANNEL =
  "tr33-extension-workspace-changed";

const kitLog = (...args: unknown[]) => {
  console.info("[tr33:kit]", ...args);
};

function messageOriginatedInVsCodeIframe(
  iframeRoot: Window,
  source: MessageEventSource | null,
): boolean {
  if (source == null || source === window) {
    return false;
  }
  if (typeof MessagePort !== "undefined" && source instanceof MessagePort) {
    return false;
  }
  if (typeof ServiceWorker !== "undefined" && source instanceof ServiceWorker) {
    return false;
  }
  let w = source as Window;
  for (let i = 0; i < 64 && w; i++) {
    if (w === iframeRoot) {
      return true;
    }
    if (w.parent === w) {
      break;
    }
    w = w.parent;
  }
  return false;
}

function normalizeApiBase(base: string): string {
  const b = (base.trim() || "/api").replace(/\/+$/, "");
  return b.startsWith("/") ? b : `/${b}`;
}

type KitFabMenuProps = {
  apiBase?: string;
  /** Default ref when cookie is absent */
  configRef?: string;
  /** Active ref from cookie (server) */
  activeRef?: string | null;
  auth?: KitAuthConfig;
};

export function KitFabMenu({
  apiBase = "/api",
  configRef = "main",
  activeRef = null,
  auth,
}: KitFabMenuProps) {
  const router = useRouter();
  /** Coalesce refresh + delay past Set-Cookie commit; immediate refresh can race the RSC request. */
  const refreshScheduleRef = React.useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  React.useEffect(() => {
    return () => {
      if (refreshScheduleRef.current) {
        clearTimeout(refreshScheduleRef.current);
      }
    };
  }, []);
  const scheduleRefresh = React.useCallback(() => {
    if (refreshScheduleRef.current) {
      clearTimeout(refreshScheduleRef.current);
    }
    refreshScheduleRef.current = setTimeout(() => {
      refreshScheduleRef.current = null;
      kitLog("router.refresh() via startTransition");
      React.startTransition(() => {
        router.refresh();
      });
    }, 100);
  }, [router]);
  const portalContainer = useShadowContainer();
  const [editorOpen, setEditorOpen] = React.useState(false);
  /** While the editor overlay is open, keep iframe `src` stable so ref sync from the extension does not remount VS Code (only update on open or Kit-driven branch switch). */
  const [embedRefLocked, setEmbedRefLocked] = React.useState<string | null>(
    null,
  );
  const editorOpenRef = React.useRef(editorOpen);
  editorOpenRef.current = editorOpen;
  /** Defer iframe mount so the toolbar and page paint first. */
  const [iframeReady, setIframeReady] = React.useState(false);
  const [editorIframeLoaded, setEditorIframeLoaded] = React.useState(false);
  React.useEffect(() => {
    const id = requestIdleCallback(() => setIframeReady(true), {
      timeout: 2000,
    });
    return () => cancelIdleCallback(id);
  }, []);
  /** Cookie + server props can lag behind a successful switch; keep UI + editor URL in sync immediately. */
  const [optimisticRef, setOptimisticRef] = React.useState<string | null>(null);
  const iframeRef = React.useRef<HTMLIFrameElement>(null);
  const base = normalizeApiBase(apiBase);
  const displayRef = optimisticRef ?? activeRef ?? configRef;

  React.useEffect(() => {
    if (optimisticRef == null) return;
    const serverRef = activeRef ?? configRef;
    if (serverRef === optimisticRef) {
      kitLog("clear optimisticRef (server caught up)", { serverRef });
      setOptimisticRef(null);
    }
  }, [activeRef, configRef, optimisticRef]);

  const hostRefChannelRef = React.useRef<BroadcastChannel | null>(null);
  React.useEffect(() => {
    if (typeof BroadcastChannel === "undefined") {
      return undefined;
    }
    hostRefChannelRef.current = new BroadcastChannel(TR33_KIT_HOST_REF_CHANNEL);
    return () => {
      hostRefChannelRef.current?.close();
      hostRefChannelRef.current = null;
    };
  }, []);

  /** Same-origin: extension host (worker) → page when `window` / postMessage are unavailable. */
  React.useEffect(() => {
    if (typeof BroadcastChannel === "undefined") {
      return undefined;
    }
    const bc = new BroadcastChannel(TR33_EXTENSION_TO_HOST_REF_CHANNEL);
    bc.onmessage = (ev: MessageEvent<{ ref?: string }>) => {
      const ref = typeof ev.data?.ref === "string" ? ev.data.ref.trim() : "";
      if (ref.length === 0) return;
      kitLog("BroadcastChannel extension→host", ref);
      setOptimisticRef(ref);
      scheduleRefresh();
    };
    return () => bc.close();
  }, [scheduleRefresh]);

  /** Save / commit / discard in the editor → refresh RSC so server reads updated DB. */
  React.useEffect(() => {
    if (typeof BroadcastChannel === "undefined") {
      return undefined;
    }
    const bc = new BroadcastChannel(TR33_EXTENSION_WORKSPACE_CHANGED_CHANNEL);
    bc.onmessage = () => {
      kitLog("BroadcastChannel extension→host (workspace)");
      scheduleRefresh();
    };
    return () => bc.close();
  }, [scheduleRefresh]);

  const notifyExtensionActiveRef = React.useCallback((ref: string) => {
    try {
      hostRefChannelRef.current?.postMessage({ ref });
    } catch {
      /* BroadcastChannel unavailable */
    }
  }, []);

  const [branches, setBranches] = React.useState<string[]>([]);
  const [branchesLoading, setBranchesLoading] = React.useState(false);
  const [branchesError, setBranchesError] = React.useState<string | null>(null);
  const [branchFilter, setBranchFilter] = React.useState("");
  /** When previewing (`offDefaultRef`), base ref for "New branch" — `displayRef` or `configRef`. */
  const [branchCreateBase, setBranchCreateBase] = React.useState(configRef);
  const branchCreateBaseRef = React.useRef(branchCreateBase);
  branchCreateBaseRef.current = branchCreateBase;
  const [branchBusy, setBranchBusy] = React.useState(false);
  const [gitError, setGitError] = React.useState<string | null>(null);
  const gitBusyRef = React.useRef(false);

  const gitOrigin = typeof window !== "undefined" ? window.location.origin : "";

  const loadBranches = React.useCallback(async () => {
    if (!gitOrigin) return;
    setBranchesLoading(true);
    setBranchesError(null);
    try {
      const res = await fetch(`${gitOrigin}${base}/git/branches`, {
        credentials: "include",
      });
      if (!res.ok) {
        setBranchesError(await res.text());
        return;
      }
      const data = (await res.json()) as { branches?: string[] };
      setBranches(data.branches ?? []);
    } catch (e) {
      setBranchesError(e instanceof Error ? e.message : String(e));
    } finally {
      setBranchesLoading(false);
    }
  }, [base, gitOrigin]);

  const branchList = React.useMemo(() => {
    const merged = branches.includes(displayRef)
      ? branches
      : [displayRef, ...branches];
    const unique = [...new Set(merged)].sort((a, b) => a.localeCompare(b));
    const q = branchFilter.trim().toLowerCase();
    if (!q) return unique;
    return unique.filter((b) => b.toLowerCase().includes(q));
  }, [branches, branchFilter, displayRef]);

  const switchToBranch = React.useCallback(
    async (ref: string) => {
      if (ref === displayRef) return;
      if (gitBusyRef.current) return;
      gitBusyRef.current = true;
      setBranchBusy(true);
      try {
        const res = await fetch(
          `${window.location.origin}${base}/git/worktrees/${encodeURIComponent(ref)}`,
          {
            credentials: "include",
            headers: { [TR33_SYNC_HOST_ACTIVE_REF_HEADER]: "1" },
          },
        );
        if (!res.ok) {
          setGitError(
            `Could not switch branch: ${res.status} ${await res.text()}`,
          );
          return;
        }
        setOptimisticRef(ref);
        notifyExtensionActiveRef(ref);
        if (editorOpenRef.current) {
          setEmbedRefLocked(ref);
        }
        scheduleRefresh();
      } catch (e) {
        setGitError(e instanceof Error ? e.message : String(e));
      } finally {
        gitBusyRef.current = false;
        setBranchBusy(false);
      }
    },
    [base, displayRef, notifyExtensionActiveRef, scheduleRefresh],
  );

  const createBranch = React.useCallback(async () => {
    const trimmed = generateBranchName();
    if (gitBusyRef.current) return;
    gitBusyRef.current = true;
    setBranchBusy(true);
    try {
      const baseRefForCreate =
        displayRef !== configRef ? branchCreateBaseRef.current : configRef;
      const res = await fetch(
        `${window.location.origin}${base}/git/create-branch`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: trimmed,
            /** Server: `git.createBranch({ base })` — copy commit + draft tree from this ref. */
            baseRef: baseRefForCreate,
          }),
        },
      );
      if (!res.ok) {
        setGitError(
          `Could not create branch: ${res.status} ${await res.text()}`,
        );
        return;
      }
      setBranches((prev) =>
        prev.includes(trimmed) ? prev : [...prev, trimmed].sort(),
      );
      setOptimisticRef(trimmed);
      notifyExtensionActiveRef(trimmed);
      if (editorOpenRef.current) {
        setEmbedRefLocked(trimmed);
      }
      scheduleRefresh();
    } catch (e) {
      setGitError(e instanceof Error ? e.message : String(e));
    } finally {
      gitBusyRef.current = false;
      setBranchBusy(false);
    }
  }, [base, configRef, displayRef, notifyExtensionActiveRef, scheduleRefresh]);

  React.useEffect(() => {
    if (!gitError) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setGitError(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [gitError]);

  const offDefaultRef = displayRef !== configRef;

  React.useEffect(() => {
    setBranchCreateBase(configRef);
  }, [configRef]);

  /** Keep select value aligned when preview ref changes (options are only `displayRef` | `configRef`). */
  React.useEffect(() => {
    if (displayRef === configRef) return;
    setBranchCreateBase((prev) =>
      prev === displayRef || prev === configRef ? prev : configRef,
    );
  }, [displayRef, configRef]);

  const editorSrc = React.useMemo(() => {
    if (typeof window === "undefined") {
      return "";
    }
    const u = new URL(`${window.location.origin}${base}/vscode/editor`);
    const refParam =
      editorOpen && embedRefLocked !== null ? embedRefLocked : displayRef;
    u.searchParams.set("ref", refParam);
    return u.toString();
  }, [base, displayRef, editorOpen, embedRefLocked]);

  React.useEffect(() => {
    if (editorOpen) {
      setEditorIframeLoaded(false);
    }
  }, [editorOpen, editorSrc]);

  const openEditor = React.useCallback(() => {
    if (typeof window !== "undefined") {
      try {
        if (offDefaultRef) {
          sessionStorage.setItem(TR33_KIT_SESSION_EDITOR_REF_KEY, displayRef);
        } else {
          sessionStorage.removeItem(TR33_KIT_SESSION_EDITOR_REF_KEY);
        }
      } catch {
        /* quota / private mode */
      }
    }
    notifyExtensionActiveRef(displayRef);
    setEmbedRefLocked(displayRef);
    setEditorIframeLoaded(false);
    setEditorOpen(true);
  }, [displayRef, notifyExtensionActiveRef, offDefaultRef]);

  React.useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === TR33_KIT_WORKSPACE_CHANGED_MESSAGE) {
        const iframeWin = iframeRef.current?.contentWindow;
        const fromEditor =
          event.origin === window.location.origin ||
          (iframeWin != null &&
            messageOriginatedInVsCodeIframe(iframeWin, event.source));
        if (!fromEditor) {
          return;
        }
        kitLog("postMessage workspace-changed → scheduleRefresh");
        scheduleRefresh();
        return;
      }
      if (event.data?.type === TR33_KIT_BRANCH_CHANGED_MESSAGE) {
        const iframeWin = iframeRef.current?.contentWindow;
        const fromEditor =
          event.origin === window.location.origin ||
          (iframeWin != null &&
            messageOriginatedInVsCodeIframe(iframeWin, event.source));
        kitLog("postMessage branch-changed", {
          origin: event.origin,
          fromEditor,
          ref: event.data?.ref,
        });
        if (!fromEditor) {
          kitLog("branch-changed ignored (origin / not from editor iframe)");
          return;
        }
        const ref =
          typeof event.data.ref === "string" ? event.data.ref.trim() : "";
        if (ref.length > 0) {
          kitLog("setOptimisticRef", ref);
          setOptimisticRef(ref);
        }
        scheduleRefresh();
        return;
      }
      if (event.origin !== window.location.origin) {
        return;
      }
      if (event.data?.type !== TR33_KIT_CLOSE_MESSAGE) {
        return;
      }
      const iframeWin = iframeRef.current?.contentWindow;
      if (
        !iframeWin ||
        !messageOriginatedInVsCodeIframe(iframeWin, event.source)
      ) {
        return;
      }
      setEmbedRefLocked(null);
      setEditorOpen(false);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [scheduleRefresh]);

  React.useEffect(() => {
    if (!editorOpen) {
      return undefined;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setEmbedRefLocked(null);
        setEditorOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editorOpen]);

  const shell =
    portalContainer && editorSrc ? (
      <>
        <div
          className="pointer-events-none absolute bottom-6 right-6 z-[2147483646]"
          data-kit-fab=""
        >
          <DropdownMenu>
            <DropdownMenuTrigger
              disabled={branchBusy}
              aria-busy={branchBusy}
              className={cn(
                "pointer-events-auto flex max-w-[min(100vw-3rem,20rem)] items-center gap-2 rounded-full border px-3 py-2 text-left text-xs shadow-md outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-90",
                offDefaultRef
                  ? "border-violet-500 bg-violet-600 text-violet-50"
                  : "border-zinc-700 bg-zinc-900 text-zinc-100 dark:border-zinc-600",
              )}
              aria-label="Git menu"
            >
              {branchBusy ? (
                <Loader2
                  className="size-4 shrink-0 animate-spin opacity-90"
                  aria-hidden
                />
              ) : (
                <GitBranch className="size-4 shrink-0 opacity-90" aria-hidden />
              )}
              <span className="min-w-0 flex-1 truncate font-medium tabular-nums">
                {displayRef}
              </span>
              <span
                className={cn(
                  "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                  offDefaultRef
                    ? "bg-violet-800/80 text-violet-100"
                    : "bg-zinc-800 text-zinc-300",
                )}
              >
                {offDefaultRef ? "Preview" : "Live"}
              </span>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              side="top"
              align="end"
              sideOffset={10}
              className="w-48"
              container={portalContainer ?? undefined}
            >
              <DropdownMenuSub
                onOpenChange={(open) => {
                  if (open) {
                    setBranchFilter("");
                    setBranchCreateBase(configRef);
                    void loadBranches();
                  }
                }}
              >
                <DropdownMenuSubTrigger className="text-xs">
                  Switch branch
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent
                  side="left"
                  align="end"
                  alignOffset={0}
                  sideOffset={8}
                  className="min-w-[min(100vw-2rem,18rem)] max-w-[min(100vw-2rem,22rem)] flex max-h-[min(50vh,26rem)] flex-col gap-0 p-0"
                  container={portalContainer ?? undefined}
                >
                  <DropdownMenuGroup className="flex flex-col gap-0 p-0">
                    <DropdownMenuLabel className="px-2 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Branch
                    </DropdownMenuLabel>
                    <div
                      className="max-h-[min(36vh,18rem)] min-h-0 min-w-0 overflow-y-auto overflow-x-hidden px-1"
                      data-kit-branch-scroll=""
                    >
                      {branchesLoading ? (
                        <div className="px-2 py-2 text-center text-xs text-muted-foreground">
                          Loading branches…
                        </div>
                      ) : branchesError ? (
                        <div className="px-2 py-2 text-center text-xs text-destructive">
                          {branchesError}
                        </div>
                      ) : branchList.length === 0 ? (
                        <div className="px-2 py-2 text-center text-xs text-muted-foreground">
                          No branches match.
                        </div>
                      ) : (
                        branchList.map((b) => (
                          <DropdownMenuItem
                            key={b}
                            disabled={branchBusy || b === displayRef}
                            className="gap-2 font-mono text-[11px]"
                            onClick={() => void switchToBranch(b)}
                          >
                            <span className="flex size-3.5 shrink-0 items-center justify-center">
                              {b === displayRef ? (
                                <Check className="size-3" aria-hidden />
                              ) : null}
                            </span>
                            <span className="min-w-0 flex-1 truncate">{b}</span>
                          </DropdownMenuItem>
                        ))
                      )}
                    </div>
                    <div
                      className="mt-1 border-t border-border/60 px-2 py-2.5"
                      onPointerDown={(e) => e.stopPropagation()}
                    >
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          disabled={branchBusy}
                          className={cn(
                            "min-w-0 flex-1 rounded-sm px-2 py-1.5 text-left text-xs text-popover-foreground outline-none",
                            "hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/40",
                            branchBusy && "pointer-events-none opacity-50",
                          )}
                          onClick={() => void createBranch()}
                        >
                          New branch
                        </button>
                        {offDefaultRef ? (
                          <select
                            className="h-7 max-w-[min(46%,10rem)] shrink-0 cursor-pointer truncate rounded-md border border-border bg-background px-1.5 text-[10px] font-mono text-popover-foreground shadow-sm outline-none ring-ring/40 focus:ring-2"
                            value={branchCreateBase}
                            title={branchCreateBase}
                            onChange={(e) => {
                              setBranchCreateBase(e.target.value);
                            }}
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={(e) => e.stopPropagation()}
                            onKeyDown={(e) => e.stopPropagation()}
                            aria-label="Base ref for new branch"
                          >
                            <option value={displayRef}>{displayRef}</option>
                            <option value={configRef}>{configRef}</option>
                          </select>
                        ) : null}
                      </div>
                    </div>
                    <div
                      className="border-t border-border/60 px-2 pb-2 pt-1.5"
                      onPointerDown={(e) => e.stopPropagation()}
                    >
                      <input
                        type="search"
                        autoComplete="off"
                        spellCheck={false}
                        placeholder="Filter branches…"
                        className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs outline-none ring-ring/40 placeholder:text-muted-foreground focus:ring-2"
                        value={branchFilter}
                        onChange={(e) => setBranchFilter(e.target.value)}
                        onKeyDown={(e) => e.stopPropagation()}
                        onClick={(e) => e.stopPropagation()}
                        aria-label="Filter branches"
                      />
                    </div>
                  </DropdownMenuGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={openEditor}>
                {offDefaultRef ? `Edit on ${displayRef}` : "Edit"}
              </DropdownMenuItem>
              {offDefaultRef ? (
                <DropdownMenuItem
                  onClick={async () => {
                    try {
                      await fetch(
                        `${window.location.origin}${base}/tr33/preview`,
                        {
                          method: "POST",
                          credentials: "include",
                        },
                      );
                      setOptimisticRef(null);
                      scheduleRefresh();
                    } catch {
                      /* ignore */
                    }
                  }}
                >
                  Exit preview (live / cached)
                </DropdownMenuItem>
              ) : null}
              {auth?.enabled ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger className="text-xs">
                      Auth
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent
                      side="left"
                      align="end"
                      sideOffset={8}
                      className="w-auto max-w-[min(100vw-2rem,26rem)] p-0"
                      container={portalContainer ?? undefined}
                    >
                      <KitAuthPanel auth={auth} />
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                </>
              ) : null}
              <DropdownMenuItem onClick={() => {}}>Share</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div
          className={cn(
            "pointer-events-auto fixed inset-0 flex flex-col bg-background text-foreground",
            editorOpen
              ? "z-[2147483647] opacity-100"
              : "pointer-events-none invisible opacity-0 -z-[1]",
          )}
          data-kit-vscode-overlay=""
          aria-hidden={!editorOpen}
        >
          <div className="relative flex min-h-0 flex-1 flex-col">
            <Button
              type="button"
              variant="secondary"
              className="absolute top-0 left-0 z-10 flex h-[35px] w-[35px] min-h-[35px] min-w-[35px] shrink-0 items-center justify-center rounded-none rounded-br-md border border-r border-b bg-background/95 p-0 shadow-sm backdrop-blur hover:bg-accent"
              aria-label="Close embedded editor"
              onClick={() => {
                setEmbedRefLocked(null);
                setEditorOpen(false);
              }}
            >
              <X className="size-4" aria-hidden />
            </Button>
            {editorOpen && iframeReady ? (
              <iframe
                ref={iframeRef}
                title="VS Code"
                loading="lazy"
                fetchPriority="low"
                className={cn(
                  "h-full min-h-0 w-full flex-1 border-0 transition-opacity duration-300",
                  editorIframeLoaded ? "opacity-100" : "opacity-0",
                )}
                onLoad={() => setEditorIframeLoaded(true)}
                src={editorSrc}
              />
            ) : null}
            {!editorIframeLoaded ? (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background text-foreground">
                <div className="flex w-[min(90vw,28rem)] flex-col items-center gap-4 rounded-xl border border-border bg-card/80 p-6 text-center shadow-lg backdrop-blur">
                  <div className="flex size-12 items-center justify-center rounded-full border border-border bg-muted">
                    <Loader2
                      className="size-5 animate-spin text-muted-foreground"
                      aria-hidden
                    />
                  </div>
                  <div className="space-y-1">
                    <p className="text-sm font-medium">Loading editor</p>
                    <p className="text-xs text-muted-foreground">
                      Fetching the VS Code workbench for{" "}
                      <span className="font-mono">{displayRef}</span>. This can
                      take a moment on a slow network.
                    </p>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </div>

        {gitError ? (
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="kit-git-error-title"
            aria-describedby="kit-git-error-desc"
            className="pointer-events-auto fixed inset-0 z-[2147483647] flex items-center justify-center bg-black/50 p-4"
            onClick={() => setGitError(null)}
          >
            <div
              className="max-h-[min(70vh,28rem)] w-full max-w-md overflow-y-auto rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-lg"
              onClick={(e) => e.stopPropagation()}
            >
              <h2
                id="kit-git-error-title"
                className="text-sm font-semibold text-foreground"
              >
                Something went wrong
              </h2>
              <p
                id="kit-git-error-desc"
                className="mt-2 whitespace-pre-wrap break-words text-xs text-muted-foreground"
              >
                {gitError}
              </p>
              <Button
                type="button"
                className="mt-4 w-full sm:w-auto"
                variant="secondary"
                onClick={() => setGitError(null)}
              >
                OK
              </Button>
            </div>
          </div>
        ) : null}
      </>
    ) : null;

  return (
    <>
      {portalContainer && shell ? createPortal(shell, portalContainer) : null}
    </>
  );
}
