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
import {
  WILDWOOD_ACTIVE_REF_STORAGE_KEY,
  WILDWOOD_EXTENSION_TO_HOST_REF_CHANNEL,
  WILDWOOD_EXTENSION_WORKSPACE_CHANGED_CHANNEL,
  WILDWOOD_KIT_BRANCH_CHANGED_MESSAGE,
  WILDWOOD_KIT_CLOSE_MESSAGE,
  WILDWOOD_KIT_HOST_REF_CHANNEL,
  WILDWOOD_KIT_WORKSPACE_CHANGED_MESSAGE,
  generateBranchName,
} from "wildwood-shared";
import { useShadowContainer } from "@/lib/shadow-root";
import { cn } from "@/lib/utils";

const persistActiveRefToStorage = (ref: string): void => {
  try {
    localStorage.setItem(WILDWOOD_ACTIVE_REF_STORAGE_KEY, ref);
  } catch {
    /* private mode / blocked storage */
  }
};

const kitLog = (...args: unknown[]) => {
  console.info("[wildwood:kit]", ...args);
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
  vscodeCommit?: string;
  configRef?: string;
  activeRef?: string | null;
  /** Always pass — library shows/throws based on NODE_ENV. */
  auth?: KitAuthConfig;
};

function isProd(): boolean {
  try {
    return typeof process !== "undefined" && process.env.NODE_ENV === "production";
  } catch {
    return false;
  }
}

function authEnabled(auth: KitAuthConfig | undefined): boolean {
  if (!auth) return false;
  if (auth.enabled != null) return auth.enabled;

  const isUnconfigured = githubAppIsUnconfigured(auth);
  // Always allow the setup entrypoint to show — render-time never throws.
  // The actual GitHub App install flow gates itself with guards.
  if (isUnconfigured) return true;

  // After unification, a single GitHub App powers both git writes and OAuth sign-in.
  // So if a slug/name exists we should show the Auth affordance. Plural OAuth
  // providers (Google, etc) are optional and also count.
  const oauthProviders = auth.oauth?.providers ?? [];
  const hasOAuthProvider = oauthProviders.some((p) => p.enabled !== false) || !!auth.githubOAuthEnabled;

  const hasAny =
    !!auth.githubApp?.appSlug?.trim() ||
    !!auth.githubApp?.name?.trim() ||
    !!auth.userEmail ||
    hasOAuthProvider ||
    !!auth.githubApp?.configured;

  return hasAny;
}

/**
 * Prod warning — not a hard error. Callers that need to enforce at *API* level
 * should do it in `/api/wildwood/github/*` handlers, not in a UI render path.
 * The Kit must never crash a production page.
 */
function warnIfMissingGithubAppInProd(auth: KitAuthConfig | undefined): void {
  if (!isProd()) return;
  if (!githubAppIsUnconfigured(auth)) return;
  // One-time per render cycle — dedupe via console.warn grouping is enough.
  if (typeof window !== "undefined" && auth?.githubApp?.name) return;
  console.warn(
    "[wildwood] Kit: GitHub App is not configured. Single credential set powers both sign-in (App doubles as OAuth via its own client_id/secret) and git writes. To enable, create the App from the toolbar → save the 5 env vars (GITHUB_APP_ID, GITHUB_PRIVATE_KEY, GITHUB_CLIENT_ID/SECRET, GITHUB_APP_SLUG) → install on the repo → redeploy. Docs: /docs/kit#github-app. Additional OAuth providers remain configurable via `oauth.providers`.",
  );
}

function githubAppIsUnconfigured(auth: KitAuthConfig | undefined): boolean {
  if (!auth?.githubApp) return true;
  if (auth.githubApp.configured === false) return true;
  if (auth.githubApp.configured === true) return false;
  // Infer: no appSlug means not configured — missing env.
  return !auth.githubApp.appSlug?.trim();
}

function setupHintLabel(auth: KitAuthConfig | undefined): string {
  const name = auth?.githubApp?.name?.trim();
  if (!name) return "Disabled — set up GitHub App (single cred set: sign-in + writes)";
  return `Disabled — set up ${name} (one App for sign-in + writes)`;
}

function shouldShowDevSetup(_auth: KitAuthConfig | undefined): boolean {
  // Always offer setup — non-throwing model. The Kit must never gate off its own setup UI.
  return true;
}

// ── Single-source-of-truth helpers for UI copy ────────────────────────
function githubSignInViaApp(auth: KitAuthConfig | undefined): boolean {
  // Happy path: GitHub App's own client_id/secret is the OAuth credential. No second OAuth app.
  if (!auth?.githubApp) return false;
  if (auth.githubApp.providesOAuth === false) return false;
  // If App exists (configured or at least slug) we treat sign-in as via App by default.
  return !!(auth.githubApp.configured || auth.githubApp.appSlug?.trim());
}

// ── Pending GitHub App creation (cross-tab) ─────────────────────────────
// Callback page sets non-HttpOnly __wildwood_github_app_pending + localStorage + BroadcastChannel.
// Opener tab listens so `needs-setup` can morph into `needs-install` without refresh.

const GH_PENDING_COOKIE = "__wildwood_github_app_pending";
const GH_PENDING_STORAGE = "__wildwood_gh_app_pending";
const GH_PENDING_BROADCAST = "wildwood:gh-app-created";

type PendingAppPayload = {
  slug?: string;
  installUrl?: string;
  htmlUrl?: string;
  appId?: number | string | null;
  repo?: string;
  at?: number;
};

function readPendingFromCookie(): PendingAppPayload | null {
  if (typeof document === "undefined") return null;
  try {
    const m = document.cookie.match(new RegExp(`(?:^|;\\s*)${GH_PENDING_COOKIE}=([^;]*)`));
    if (!m) return null;
    const raw = decodeURIComponent(m[1] ?? "");
    if (!raw) return null;
    const j = JSON.parse(raw) as PendingAppPayload;
    if (!j?.installUrl && !j?.slug) return null;
    return j;
  } catch {
    return null;
  }
}

function readPendingFromStorage(): PendingAppPayload | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(GH_PENDING_STORAGE);
    if (!raw) return null;
    const j = JSON.parse(raw) as PendingAppPayload;
    if (!j?.installUrl && !j?.slug) return null;
    return j;
  } catch {
    return null;
  }
}

function readPendingMerged(): PendingAppPayload | null {
  const fromCookie = readPendingFromCookie();
  const fromStorage = readPendingFromStorage();
  if (!fromCookie) return fromStorage;
  if (!fromStorage) return fromCookie;
  const a = fromCookie.at ?? 0;
  const b = fromStorage.at ?? 0;
  return b > a ? fromStorage : fromCookie;
}

function usePendingGitHubApp(): PendingAppPayload | null {
  const [pending, setPending] = React.useState<PendingAppPayload | null>(null);

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    // initial read
    setPending(readPendingMerged());

    let bc: BroadcastChannel | null = null;
    try {
      if (typeof BroadcastChannel !== "undefined") {
        bc = new BroadcastChannel(GH_PENDING_BROADCAST);
        bc.onmessage = (ev: MessageEvent<PendingAppPayload>) => {
          const d = ev.data;
          if (!d || (typeof d !== "object")) return;
          if (!d.installUrl && !d.slug) return;
          try {
            window.localStorage.setItem(GH_PENDING_STORAGE, JSON.stringify(d));
          } catch {}
          setPending(d);
        };
      }
    } catch {}

    const onStorage = (e: StorageEvent) => {
      if (e.key !== GH_PENDING_STORAGE) return;
      setPending(readPendingMerged());
    };
    window.addEventListener("storage", onStorage);

    // Cookie polling fallback (BC may be partitioned)
    const iv = window.setInterval(() => {
      const m = readPendingMerged();
      setPending((prev) => {
        if (!m && !prev) return prev;
        if (!m || !prev) return m;
        if ((m.at ?? 0) !== (prev.at ?? 0) || m.installUrl !== prev.installUrl) return m;
        return prev;
      });
    }, 2000);

    return () => {
      window.removeEventListener("storage", onStorage);
      window.clearInterval(iv);
      try { bc?.close(); } catch {}
    };
  }, []);

  return pending;
}

type EditorOpenState =
  | { kind: "idle" }
  | { kind: "checking" }
  | {
      kind: "needs-setup";
      repo: string;
      message: string;
    }
  | {
      kind: "needs-install";
      repo: string;
      installUrl?: string;
      hint: string;
    }
  | { kind: "error"; message: string }
  | { kind: "ready" };

type EditorBootstrapResponse = {
  status: "ready" | "not_configured" | "not_installed" | "error";
  repo?: string;
  message?: string;
  installUrl?: string;
  hint?: string;
  entryCount?: number;
  vscodeCommit?: string;
};

type EditorGuardResponse = EditorBootstrapResponse;

function editorIframeSrc(
  origin: string,
  base: string,
  commit: string,
): string {
  return `${origin}${base}/vscode/editor/${commit}`;
}

function apiOrigin(): string {
  if (typeof window === "undefined") {
    return "";
  }
  return window.location.origin;
}

function apiUrl(base: string, path: string): string {
  const origin = apiOrigin();
  // Accept either "git/editor-guards" or "/git/editor-guards" — normalize to single leading slash then prefix base.
  const trimmed = path.trim().replace(/^\/+/, "");
  // base is already normalized "/api/…" with no trailing slash; trimmed may start with "git/" or "github/…"
  return `${origin}${base}/${trimmed}`;
}

export function KitFabMenu({
  apiBase = "/api",
  vscodeCommit,
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
    }, 800);
  }, [router]);
  const portalContainer = useShadowContainer();
  const [editorOpen, setEditorOpen] = React.useState(false);
  const [openState, setOpenState] = React.useState<EditorOpenState>({
    kind: "idle",
  });
  const [editorGuard, setEditorGuard] = React.useState<EditorOpenState | null>(
    null,
  );
  const [editorIframeLoaded, setEditorIframeLoaded] = React.useState(false);
  const editorOpenRunRef = React.useRef(0);
  const iframeSrcRef = React.useRef<string | null>(null);
  const iframeRef = React.useRef<HTMLIFrameElement>(null);
  const base = normalizeApiBase(apiBase);
  const displayRef = activeRef ?? configRef;
  const gitOrigin = apiOrigin();
  const pendingGhApp = usePendingGitHubApp();
  const [installVerifying, setInstallVerifying] = React.useState(false);
  const [installVerifyMsg, setInstallVerifyMsg] = React.useState<string | null>(null);

  // Auto-promote needs-setup → needs-install when callback tab broadcasts.
  // User created App in new tab while this tab's editor overlay was open at needs-setup.
  React.useEffect(() => {
    if (!pendingGhApp?.installUrl) return;
    if (openState.kind !== "needs-setup") return;
    const repo = pendingGhApp.repo?.trim() || openState.repo;
    setOpenState({
      kind: "needs-install",
      repo,
      installUrl: pendingGhApp.installUrl,
      hint: `App \`${pendingGhApp.slug ?? "created"}\` detected from callback tab. Install on ${repo}, then redeploy so Build env picks up GITHUB_APP_*.`,
    });
    // Once promoted, the Verify button will also work even when server still says not_configured.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingGhApp?.installUrl, pendingGhApp?.repo, pendingGhApp?.slug, openState.kind]);

  // Also auto-downgrade Verify generic error copy once pending arrives.
  React.useEffect(() => {
    if (!pendingGhApp?.installUrl) return;
    if (!installVerifyMsg) return;
    if (/Could not verify/i.test(installVerifyMsg) && pendingGhApp.slug) {
      setInstallVerifyMsg(`Detected ${pendingGhApp.slug} from callback — finish install on GitHub, then Verify.`);
    }
  }, [pendingGhApp?.installUrl, pendingGhApp?.slug, installVerifyMsg]);

  React.useEffect(() => {
    persistActiveRefToStorage(displayRef);
  }, [displayRef]);

  // Soft warning (no throw) when GH App is missing — useful even when toolbar is collapsed.
  React.useEffect(() => {
    warnIfMissingGithubAppInProd(auth);
  }, [auth]);

  const switchBranchCookie = React.useCallback(
    async (ref: string) => {
      const current = activeRef ?? configRef;
      if (ref === current) return;
      const res = await fetch(apiUrl(base, "/git/switch-branch"), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ref }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(
          body.trim() || `Could not switch to branch "${ref}" (${res.status})`,
        );
      }
    },
    [base, activeRef, configRef],
  );

  const createDraftBranchRef = React.useCallback(async (): Promise<string> => {
    const name = generateBranchName();
    const res = await fetch(apiUrl(base, "/git/create-branch"), {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, baseRef: configRef }),
    });
    if (!res.ok) {
      throw new Error(
        `Could not create draft branch: ${res.status} ${await res.text()}`,
      );
    }
    setBranches((prev) =>
      prev.includes(name) ? prev : [...prev, name].sort(),
    );
    return name;
  }, [base, configRef]);

  const runEditorOpenSequenceRef = React.useRef<
    (refForOpen: string) => Promise<void>
  >(async () => {});
  runEditorOpenSequenceRef.current = async (refForOpen: string) => {
    const runId = ++editorOpenRunRef.current;
    setOpenState({ kind: "checking" });
    setEditorGuard(null);
    setEditorIframeLoaded(false);
    try {
      let activeRef = refForOpen;
      let guardsRes: Response;

      if (refForOpen === configRef) {
        const [draftRef, guardsResponse] = await Promise.all([
          createDraftBranchRef(),
          fetch(apiUrl(base, "/git/editor-guards"), {
            credentials: "include",
          }),
        ]);
        if (runId !== editorOpenRunRef.current) return;
        activeRef = draftRef;
        persistActiveRefToStorage(activeRef);
        notifyExtensionActiveRef(activeRef);
        scheduleRefresh();
        guardsRes = guardsResponse;
      } else {
        guardsRes = await fetch(apiUrl(base, "/git/editor-guards"), {
          credentials: "include",
        });
        if (runId !== editorOpenRunRef.current) return;
      }

      const guards = (await guardsRes.json()) as EditorGuardResponse;
      if (!guardsRes.ok || guards.status === "error") {
        setOpenState({
          kind: "error",
          message:
            guards.message?.trim() ||
            `Failed to prepare the editor (${guardsRes.status})`,
        });
        return;
      }
      if (guards.status === "not_configured") {
        // If we just created the App in another tab, server may still say not_configured
        // until env propagated / redeploy, but we know slug/installUrl — promote to install step.
        const pending = readPendingMerged();
        const pendingInstall = pending?.installUrl?.trim();
        const pendingRepo = pending?.repo?.trim() || guards.repo || refForOpen;
        if (pendingInstall) {
          setOpenState({
            kind: "needs-install",
            repo: pendingRepo,
            installUrl: pendingInstall,
            hint:
              `App created as \`${pending.slug ?? "your-app"}\`. ` +
              `Finish by saving env vars (callback tab → Vercel CLI / .env.local) and then install on ${pendingRepo}. ` +
              `Until the deploy picks up GITHUB_APP_* the editor will still report not_configured — install anyway, then redeploy.`,
          });
          return;
        }
        setOpenState({
          kind: "needs-setup",
          repo: guards.repo ?? refForOpen,
          message:
            guards.message?.trim() ||
            "GitHub App credentials are not configured on this deployment.",
        });
        return;
      }
      if (guards.status === "not_installed") {
        const pending = readPendingMerged();
        const mergedInstallUrl = guards.installUrl || pending?.installUrl || undefined;
        setOpenState({
          kind: "needs-install",
          repo: guards.repo ?? refForOpen,
          installUrl: mergedInstallUrl,
          hint:
            guards.hint?.trim() ||
            (pending?.slug ? `Install \`${pending.slug}\` on ${guards.repo ?? refForOpen}. Choose "Only select repositories" and pick ${guards.repo ?? "your repo"}.` : "Install the GitHub App on this repository to edit files."),
        });
        return;
      }

      const commit = guards.vscodeCommit ?? vscodeCommit;
      if (!commit) {
        setOpenState({
          kind: "error",
          message: "VS Code web commit is not configured on this deployment.",
        });
        return;
      }
      if (!gitOrigin) {
        setOpenState({
          kind: "error",
          message: "Editor cannot load outside the browser.",
        });
        return;
      }

      iframeSrcRef.current = editorIframeSrc(gitOrigin, base, commit);
      setOpenState({ kind: "ready" });

      void (async () => {
        const res = await fetch(apiUrl(base, "/git/editor-bootstrap"), {
          credentials: "include",
        });
        if (runId !== editorOpenRunRef.current) return;
        const data = (await res.json()) as EditorBootstrapResponse;
        if (!res.ok || data.status === "error") {
          setEditorGuard({
            kind: "error",
            message:
              data.message?.trim() ||
              `Failed to verify the indexed repository (${res.status})`,
          });
        }
      })();
    } catch (error) {
      if (runId !== editorOpenRunRef.current) return;
      setOpenState({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "Failed to prepare the editor workspace",
      });
    }
  };

  const retryEditorOpen = React.useCallback(() => {
    if (!editorOpen) return;
    void runEditorOpenSequenceRef.current(displayRef);
  }, [displayRef, editorOpen]);

  React.useEffect(() => {
    if (!editorOpen) {
      editorOpenRunRef.current += 1;
      iframeSrcRef.current = null;
      setEditorGuard(null);
      setOpenState({ kind: "idle" });
      setEditorIframeLoaded(false);
      return;
    }
    void runEditorOpenSequenceRef.current(displayRef);
    // Only re-run when the overlay opens/closes — not when displayRef changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ref captured at open
  }, [editorOpen]);

  const hostRefChannelRef = React.useRef<BroadcastChannel | null>(null);
  React.useEffect(() => {
    if (typeof BroadcastChannel === "undefined") {
      return undefined;
    }
    hostRefChannelRef.current = new BroadcastChannel(WILDWOOD_KIT_HOST_REF_CHANNEL);
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
    const bc = new BroadcastChannel(WILDWOOD_EXTENSION_TO_HOST_REF_CHANNEL);
    bc.onmessage = (ev: MessageEvent<{ ref?: string }>) => {
      const ref = typeof ev.data?.ref === "string" ? ev.data.ref.trim() : "";
      if (ref.length === 0) return;
      kitLog("BroadcastChannel extension→host", ref);
      scheduleRefresh();
    };
    return () => bc.close();
  }, [scheduleRefresh]);

  /** Save / commit / discard in the editor → refresh RSC so server reads updated DB. */
  React.useEffect(() => {
    if (typeof BroadcastChannel === "undefined") {
      return undefined;
    }
    const bc = new BroadcastChannel(WILDWOOD_EXTENSION_WORKSPACE_CHANGED_CHANNEL);
    bc.onmessage = () => {
      kitLog("BroadcastChannel extension→host (workspace)");
      scheduleRefresh();
    };
    return () => bc.close();
  }, [scheduleRefresh]);

  const notifyExtensionActiveRef = React.useCallback((ref: string) => {
    persistActiveRefToStorage(ref);
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

  const loadBranches = React.useCallback(async () => {
    if (!gitOrigin) return;
    setBranchesLoading(true);
    setBranchesError(null);
    try {
      const res = await fetch(apiUrl(base, "/git/branches"), {
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
        await switchBranchCookie(ref);
        notifyExtensionActiveRef(ref);
        scheduleRefresh();
      } catch (e) {
        setGitError(e instanceof Error ? e.message : String(e));
      } finally {
        gitBusyRef.current = false;
        setBranchBusy(false);
      }
    },
    [displayRef, notifyExtensionActiveRef, scheduleRefresh, switchBranchCookie],
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
      notifyExtensionActiveRef(trimmed);
      scheduleRefresh();
    } catch (e) {
      setGitError(e instanceof Error ? e.message : String(e));
    } finally {
      gitBusyRef.current = false;
      setBranchBusy(false);
    }
  }, [base, configRef, displayRef, notifyExtensionActiveRef, scheduleRefresh, switchBranchCookie]);

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

  const editorBlockingState: EditorOpenState | null =
    openState.kind === "checking" ||
    openState.kind === "needs-setup" ||
    openState.kind === "needs-install" ||
    openState.kind === "error"
      ? openState
      : editorGuard;

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

  const openEditor = React.useCallback(() => {
    notifyExtensionActiveRef(displayRef);
    setEditorOpen(true);
  }, [displayRef, notifyExtensionActiveRef]);

  React.useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === WILDWOOD_KIT_WORKSPACE_CHANGED_MESSAGE) {
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
      if (event.data?.type === WILDWOOD_KIT_BRANCH_CHANGED_MESSAGE) {
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
          kitLog("branch-changed from editor", ref);
        }
        scheduleRefresh();
        return;
      }
      if (event.origin !== window.location.origin) {
        return;
      }
      if (event.data?.type !== WILDWOOD_KIT_CLOSE_MESSAGE) {
        return;
      }
      const iframeWin = iframeRef.current?.contentWindow;
      if (
        !iframeWin ||
        !messageOriginatedInVsCodeIframe(iframeWin, event.source)
      ) {
        return;
      }
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
        setEditorOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editorOpen]);

  const shell =
    portalContainer ? (
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
              {(() => {
                const isUnconfigured = githubAppIsUnconfigured(auth);
                return (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={openEditor}
                      disabled={isUnconfigured}
                      title={isUnconfigured ? setupHintLabel(auth) : undefined}
                      className={isUnconfigured ? "opacity-60" : undefined}
                    >
                      {offDefaultRef ? `Edit on ${displayRef}` : "Edit"}
                      {isUnconfigured ? (
                        <span className="ml-auto text-[10px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400">
                          setup needed
                        </span>
                      ) : null}
                    </DropdownMenuItem>
                    {offDefaultRef ? (
                      <DropdownMenuItem
                        onClick={async () => {
                          try {
                            await fetch(
                              `${window.location.origin}${base}/wildwood/preview`,
                              {
                                method: "POST",
                                credentials: "include",
                              },
                            );
                            scheduleRefresh();
                          } catch {
                            /* ignore */
                          }
                        }}
                      >
                        Exit preview (live / cached)
                      </DropdownMenuItem>
                    ) : null}
                    {isUnconfigured ? (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuSub>
                          <DropdownMenuSubTrigger className="text-xs font-semibold text-amber-600 dark:text-amber-400">
                            {setupHintLabel(auth)}
                          </DropdownMenuSubTrigger>
                          <DropdownMenuSubContent
                            side="left"
                            align="end"
                            sideOffset={8}
                            className="w-auto max-w-[min(100vw-2rem,26rem)] p-0"
                            container={portalContainer ?? undefined}
                          >
                            <KitAuthPanel auth={auth ?? {}} mode="dev-setup" />
                          </DropdownMenuSubContent>
                        </DropdownMenuSub>
                      </>
                    ) : null}
                  </>
                );
              })()}
              {authEnabled(auth) ? (
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
                      <KitAuthPanel auth={auth} mode="session" />
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                  {shouldShowDevSetup(auth) ? (
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger className="text-xs">
                        Developer
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent
                        side="left"
                        align="end"
                        sideOffset={8}
                        className="w-auto max-w-[min(100vw-2rem,26rem)] p-0"
                        container={portalContainer ?? undefined}
                      >
                        <KitAuthPanel auth={auth} mode="dev-setup" />
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  ) : null}
                </>
              ) : !githubAppIsUnconfigured(auth) ? null : (
                // Already handled unconfigured case above; this branch is when auth is falsy but we
                // already forced the setup item. Still offer Auth if session exists? Hide.
                <>{/* setup item already rendered above */}</>
              )}
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
              onClick={() => setEditorOpen(false)}
            >
              <X className="size-4" aria-hidden />
            </Button>
            {editorOpen && openState.kind === "ready" && iframeSrcRef.current ? (
              <iframe
                ref={iframeRef}
                title="VS Code"
                loading="eager"
                fetchPriority="high"
                className={cn(
                  "h-full min-h-0 w-full flex-1 border-0 transition-opacity duration-300",
                  editorIframeLoaded ? "opacity-100" : "opacity-0",
                )}
                onLoad={() => setEditorIframeLoaded(true)}
                src={iframeSrcRef.current}
              />
            ) : null}
            {editorOpen && editorBlockingState ? (
              <div
                className={cn(
                  "absolute inset-0 flex items-center justify-center bg-background text-foreground",
                  editorBlockingState.kind === "needs-install" ||
                    editorBlockingState.kind === "needs-setup" ||
                    editorBlockingState.kind === "error"
                    ? "pointer-events-auto"
                    : "pointer-events-none",
                )}
              >
                <div className="flex w-[min(90vw,28rem)] flex-col items-center gap-4 rounded-xl border border-border bg-card/80 p-6 text-center shadow-lg backdrop-blur">
                  {editorBlockingState.kind === "needs-setup" ? (
                    <>
                      <div className="space-y-2">
                        <p className="text-sm font-medium">GitHub App — one credential set for sign-in + writes</p>
                        <p className="text-xs text-muted-foreground">{editorBlockingState.message}</p>
                        {pendingGhApp?.installUrl ? (
                          <p className="text-xs text-muted-foreground">
                            We detected <code className="font-mono">{pendingGhApp.slug ?? "your app"}</code> created in another tab. This single App powers both <b>sign-in</b> (via its own <code>client_id</code>/<code>secret</code> — no second OAuth app) and <b>git writes</b>. Save the 5 env vars from the callback tab&apos;s Step 1, then hit Install. Even while the server still says <code>not_configured</code> (env hasn&apos;t propagated yet), you can proceed to install.
                          </p>
                        ) : (
                          <p className="text-xs text-muted-foreground">
                            One-click setup: we create a GitHub App via manifest. Its own <code className="font-mono">client_id</code>/<code>secret</code> doubles as the OAuth app — no separate OAuth creds needed. After GitHub review you&apos;ll land on a 2-step page: <b>Step 1</b> saves env (single cred set), <b>Step 2</b> installs on <code className="font-mono">{editorBlockingState.repo}</code> (choose <b>Only select repositories</b>). Vercel: paste then redeploy; local: <code className="font-mono">.env.local</code>. Additional providers (Google, etc) remain configurable via <code className="font-mono">oauth.providers</code>.
                          </p>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center justify-center gap-2">
                        {pendingGhApp?.installUrl ? (
                          <>
                            <Button
                              type="button"
                              size="sm"
                              onClick={() => {
                                setOpenState({
                                  kind: "needs-install",
                                  repo: pendingGhApp.repo?.trim() || editorBlockingState.repo,
                                  installUrl: pendingGhApp.installUrl,
                                  hint: `App \`${pendingGhApp.slug ?? "created"}\` (single cred set — sign-in + writes) detected from callback. Install on ${pendingGhApp.repo ?? editorBlockingState.repo} — pick Only select repositories → ${pendingGhApp.repo ?? editorBlockingState.repo} — then Verify. If server still says not_configured, redeploy after saving env.`,
                                });
                              }}
                            >
                              Continue to Install →
                            </Button>
                            <Button type="button" size="sm" variant="secondary" onClick={() => setEditorOpen(false)}>
                              Close
                            </Button>
                          </>
                        ) : (
                          <>
                            <Button
                              type="button"
                              size="sm"
                              onClick={async () => {
                                try {
                                  const origin = window.location.origin;
                                  const res = await fetch("/api/wildwood/github/app-manifest/start", {
                                    method: "POST",
                                    credentials: "include",
                                    headers: { "Content-Type": "application/json" },
                                    body: JSON.stringify({
                                      name: auth?.githubApp?.name || "Wildwood Dev",
                                      origin,
                                      redirectPath: "/api/wildwood/github/app-manifest/callback",
                                    }),
                                  });
                                  if (!res.ok) throw new Error(await res.text());
                                  const data = (await res.json()) as { action: string; manifest: unknown; state: string };
                                  const form = document.createElement("form");
                                  form.method = "POST";
                                  form.action = data.action;
                                  form.target = "_blank";
                                  (form as HTMLFormElement & { rel?: string }).rel = "noopener";
                                  const mf = document.createElement("input");
                                  mf.type = "hidden";
                                  mf.name = "manifest";
                                  mf.value = JSON.stringify(data.manifest);
                                  form.appendChild(mf);
                                  const st = document.createElement("input");
                                  st.type = "hidden";
                                  st.name = "state";
                                  st.value = data.state;
                                  form.appendChild(st);
                                  document.body.appendChild(form);
                                  form.submit();
                                } catch (e) {
                                  setGitError(e instanceof Error ? e.message : String(e));
                                }
                              }}
                            >
                              Set up GitHub App
                            </Button>
                            <Button type="button" size="sm" variant="secondary" onClick={() => setEditorOpen(false)}>
                              Close
                            </Button>
                          </>
                        )}
                      </div>
                      <p className="text-[11px] text-muted-foreground">
                        After creation you&apos;ll see <code>Vercel CLI</code> + <code>.env.local</code> for the <b>single</b> 5-var set (<code>GITHUB_APP_ID</code>, <code>GITHUB_PRIVATE_KEY</code>, <code>GITHUB_CLIENT_ID</code>, <code>GITHUB_CLIENT_SECRET</code>, <code>GITHUB_APP_SLUG</code>). That one set powers both OAuth sign-in and git operations. Step 1 saves env, Step 2 installs on repo → Verify checks <code>{editorBlockingState.repo}</code>.
                      </p>
                    </>
                  ) : editorBlockingState.kind === "needs-install" ? (
                    <>
                      <div className="space-y-2">
                        <p className="text-sm font-medium">Install the GitHub App on {editorBlockingState.repo}</p>
                        <p className="text-xs text-muted-foreground">{editorBlockingState.hint}</p>
                        <p className="text-xs text-muted-foreground">
                          On GitHub&apos;s install screen, choose{" "}
                          <strong>Only select repositories</strong> and pick{" "}
                          <span className="font-mono">{editorBlockingState.repo}</span> from the searchable repo list. This is the single App — its own <code className="font-mono">client_id</code>/<code>secret</code> already covers sign-in, so no second GitHub OAuth app is needed. Additional providers (Google, etc) are still configurable via <code className="font-mono">oauth.providers</code>.
                        </p>
                        {pendingGhApp?.slug ? (
                          <p className="text-[11px] text-muted-foreground">
                            Detected <code className="font-mono">{pendingGhApp.slug}</code> from callback. If you haven&apos;t saved the env yet (Step 1), go back to the callback tab first — then return here and Verify.
                          </p>
                        ) : null}
                      </div>
                      <div className="flex flex-wrap items-center justify-center gap-2">
                        {editorBlockingState.installUrl ? (
                          <Button
                            type="button"
                            size="sm"
                            onClick={() => {
                              window.open(
                                editorBlockingState.installUrl,
                                "_blank",
                                "noopener,noreferrer",
                              );
                            }}
                          >
                            Install on GitHub
                          </Button>
                        ) : null}
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          disabled={installVerifying}
                          onClick={async () => {
                            setInstallVerifying(true);
                            setInstallVerifyMsg(null);
                            try {
                              const candidates = [
                                `github/installation`,
                                `git/editor-guards`,
                              ];
                              let lastMsg = "";
                              for (const p of candidates) {
                                try {
                                  const r = await fetch(apiUrl(base, p), {
                                    credentials: "include",
                                    headers: { Accept: "application/json" },
                                  });
                                  const j = (await r.json().catch(async () => ({ _text: await r.text().catch(() => "") }))) as {
                                    status?: string;
                                    installationId?: number;
                                    repo?: string;
                                    message?: string;
                                    error?: string;
                                    _text?: string;
                                    installUrl?: string;
                                  };
                                  if (!r.ok) { lastMsg = String(j.message || j.error || j._text || `${r.status}`); continue; }
                                  const st = j.status || (j.installationId ? "installed" : j.installUrl ? "not_installed" : "unknown");
                                  if (st === "installed" || st === "ready") {
                                    setInstallVerifyMsg(`✓ Installed${j.repo ? ` on ${j.repo}` : ""} — single App powers sign-in + writes. Opening editor…`);
                                    setTimeout(() => void retryEditorOpen(), 300);
                                    return;
                                  }
                                  if (st === "not_installed") {
                                    setInstallVerifyMsg(`App not yet installed on ${j.repo ?? editorBlockingState.repo}. On GitHub: pick "Only select repositories" → search for ${j.repo ?? editorBlockingState.repo} → tick it → Install, then Verify.`);
                                    return;
                                  }
                                  if (st === "not_configured") {
                                    setInstallVerifyMsg("Server still reports not_configured — save the 5 vars from callback Step 1 (GITHUB_APP_ID, GITHUB_PRIVATE_KEY, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, GITHUB_APP_SLUG — single cred set, App doubles as OAuth) on the deployment and redeploy. You can finish the GitHub install now; verification will succeed after redeploy.");
                                    return;
                                  }
                                } catch (e) { lastMsg = e instanceof Error ? e.message : String(e); }
                              }
                              setInstallVerifyMsg(lastMsg ? `Could not verify: ${lastMsg}. If you completed GitHub's Only select repositories → ${editorBlockingState.repo} flow, click “I've installed it” to retry.` : "Could not verify — try again.");
                            } finally {
                              setInstallVerifying(false);
                            }
                          }}
                        >
                          {installVerifying ? <Loader2 className="mr-1 size-3 animate-spin" /> : null}
                          Verify
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          onClick={() => void retryEditorOpen()}
                        >
                          I&apos;ve installed it
                        </Button>
                      </div>
                      {installVerifyMsg ? (
                        <p className="max-w-sm text-[11px] text-muted-foreground">{installVerifyMsg}</p>
                      ) : null}
                      {!editorBlockingState.installUrl ? (
                        <p className="text-xs text-muted-foreground">
                          {pendingGhApp?.installUrl ? (
                            <a href={pendingGhApp.installUrl} target="_blank" rel="noreferrer" className="underline">
                              Use detected install link →
                            </a>
                          ) : (
                            <>Set <code className="font-mono">GITHUB_APP_SLUG</code> on the deployment so we can link to your app&apos;s install page. Single set: this App&apos;s own client_id/secret is the OAuth cred — no second app needed.</>
                          )}
                        </p>
                      ) : null}
                    </>
                  ) : editorBlockingState.kind === "error" ? (
                    <>
                      <div className="space-y-2">
                        <p className="text-sm font-medium">
                          Could not open editor
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {editorBlockingState.message}
                        </p>
                      </div>
                      <div className="flex gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          onClick={() => {
                            setEditorGuard(null);
                            void retryEditorOpen();
                          }}
                        >
                          Retry
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          onClick={() => setEditorOpen(false)}
                        >
                          Close
                        </Button>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="flex size-12 items-center justify-center rounded-full border border-border bg-muted">
                        <Loader2
                          className="size-5 animate-spin text-muted-foreground"
                          aria-hidden
                        />
                      </div>
                      <div className="space-y-1">
                        <p className="text-sm font-medium">Loading editor</p>
                        <p className="text-xs text-muted-foreground">
                          Preparing{" "}
                          <span className="font-mono">{displayRef}</span> from
                          the indexed repository…
                        </p>
                      </div>
                    </>
                  )}
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
