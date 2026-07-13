"use client";

import { Loader2, Shuffle } from "lucide-react";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Permission = "read" | "write";

export type OAuthProviderId = "github" | "google" | "gitlab" | "discord" | (string & {});

export type OAuthProviderConfig = {
  id: OAuthProviderId;
  /**
   * Display label. Defaults to capitalized id.
   * e.g. "github" -> "GitHub"
   */
  name?: string;
  /**
   * Whether this provider is enabled.
   * If omitted, inferred as true when provider's env is present.
   */
  enabled?: boolean;
  /**
   * When true, this provider is powered by the GitHub App's own
   * client_id / client_secret (single credential set). No separate
   * OAuth App needed.
   */
  viaGitHubApp?: boolean;
};

export type KitAuthConfig = {
  enabled?: boolean;
  authBase?: string;
  callbackURL?: string;
  userEmail?: string | null;
  /**
   * New, pluggable OAuth providers. Happy path is single GitHub provider
   * powered by the GitHub App itself (viaGitHubApp=true). Additional
   * providers can be added without changing Kit UI.
   *
   * If omitted, Kit will infer from legacy `githubOAuthEnabled` + `githubApp.configured`.
   */
  oauth?: {
    providers?: OAuthProviderConfig[];
  };
  /**
   * @deprecated Use `oauth.providers`. Kept for back-compat — when true,
   * GitHub is offered as a sign-in provider. When a GitHub App is configured,
   * GitHub sign-in is automatically enabled via the App's own OAuth creds
   * (client_id/client_secret from the manifest conversion), so no separate
   * OAuth App env is needed.
   */
  githubOAuthEnabled?: boolean;
  githubApp?: {
    appSlug?: string;
    name?: string;
    origin?: string;
    manifestRedirectPath?: string;
    oauthCallbackPath?: string;
    contents?: Permission;
    pullRequests?: Permission;
    webhookUrl?: string;
    /**
     * When true, host has GITHUB_APP_ID/PRIVATE_KEY. When false/undefined,
     * UI will prominently offer "Set up GitHub App" flow.
     * If omitted, inferred from presence of appSlug — missing slug == not configured.
     */
    configured?: boolean;
    /**
     * When true, this App's client_id/client_secret can be used for
     * user sign-in. This is the default — GitHub Apps ARE OAuth apps.
     * Set to false only if you explicitly want to disable GitHub sign-in
     * even though the App exists.
     */
    providesOAuth?: boolean;
    /** Full "org/repo" of this site — used to scope install links so user doesn't hunt all repos. */
    repoFull?: string;
    org?: string;
    repo?: string;
    directRepoInstallUrl?: string;
  };
  /**
   * @deprecated The Kit is a UI affordance — it must never throw in production when
   * GitHub App env is missing. Keep for API-level gates only, if you really need it,
   * and handle it server-side. Client `authEnabled` will ignore it.
   */
  enforceInProduction?: boolean;
};

type Props = {
  auth: KitAuthConfig;
  mode?: "session" | "dev-setup";
};

function trimSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

function randomAppName() {
  return `Wildwood Play Dev ${Math.random().toString(36).slice(2, 7)}`;
}

function normalizeAuthBase(authBase: string | undefined): string {
  const base = trimSlashes(authBase || "/api/auth");
  return base.startsWith("/") ? base : `/${base}`;
}

function providerLabel(id: string, fallback?: string): string {
  if (fallback) return fallback;
  if (id === "github") return "GitHub";
  if (id === "google") return "Google";
  if (id === "gitlab") return "GitLab";
  if (id === "discord") return "Discord";
  return id.charAt(0).toUpperCase() + id.slice(1);
}

function resolveOAuthProviders(
  auth: KitAuthConfig,
): (OAuthProviderConfig & { enabledResolved: boolean })[] {
  const explicit = auth.oauth?.providers;

  // New config path — explicit list wins, but still resolves enabled default.
  if (explicit && explicit.length > 0) {
    const ghAppConfigured =
      auth.githubApp?.configured !== false &&
      (!!auth.githubApp?.appSlug || auth.githubApp?.configured === true);
    const providesOAuth = auth.githubApp?.providesOAuth !== false;
    return explicit.map((p) => {
      const id = p.id.trim().toLowerCase();
      const isGithub = id === "github";
      const enabledDefault = (() => {
        if (p.enabled != null) return p.enabled;
        if (isGithub) {
          // Single source of truth happy path: GitHub App itself provides OAuth.
          if (ghAppConfigured && providesOAuth) return true;
          // Legacy: standalone OAuth env var presence — server plugs it in as githubOAuthEnabled.
          if (auth.githubOAuthEnabled) return true;
          return false;
        }
        // Non-github providers: respect explicit enabled, otherwise require server to mark enabled.
        return p.enabled ?? false;
      })();
      return { ...p, id: id as OAuthProviderConfig["id"], enabledResolved: enabledDefault };
    });
  }

  // Back-compat: single github provider inferred from legacy flag + App config.
  const ghAppConfigured =
    auth.githubApp?.configured !== false &&
    (!!auth.githubApp?.appSlug || auth.githubApp?.configured === true);
  const providesOAuth = auth.githubApp?.providesOAuth !== false;
  const legacyGithubOAuthEnabled = auth.githubOAuthEnabled === true;
  // Happy path: if GitHub App exists and opts into providing OAuth (default), GitHub sign-in is enabled
  // even without a separate OAuth App. No second credential set needed.
  const githubEnabled = (ghAppConfigured && providesOAuth) || legacyGithubOAuthEnabled;

  return [
    {
      id: "github" as const,
      name: "GitHub",
      viaGitHubApp: ghAppConfigured && providesOAuth ? true : undefined,
      enabledResolved: githubEnabled,
      enabled: githubEnabled ? true : false,
    },
  ];
}

export function KitAuthPanel({ auth, mode = "session" }: Props) {
  const authBase = normalizeAuthBase(auth.authBase);
  const [busyProvider, setBusyProvider] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [name, setName] = React.useState(auth.githubApp?.name || "Wildwood Play Dev");
  const [origin, setOrigin] = React.useState(auth.githubApp?.origin || "");
  const [contents, setContents] = React.useState<Permission>(auth.githubApp?.contents || "write");
  const [pullRequests, setPullRequests] = React.useState<Permission>(
    auth.githubApp?.pullRequests || "write",
  );

  const manifestRedirectPath =
    auth.githubApp?.manifestRedirectPath || "/api/wildwood/github/app-manifest/callback";
  const oauthCallbackPath = auth.githubApp?.oauthCallbackPath || `${authBase}/callback/github`;
  const callbackURL = auth.callbackURL || "/";
  // Repo-scoped install URL — GitHub's App install page lets you pre-filter by state/repo hint.
  // When the server provides org/repo we link via ?state so the callback and install pages can
  // guide the user to "Only select repositories → {repo}". Falls back to generic picker.
  const gha = auth.githubApp;
  const authExtra = auth as unknown as { repoFull?: string; org?: string; repo?: string };
  const repoFull =
    gha?.repoFull?.trim() ||
    authExtra.repoFull?.trim() ||
    [gha?.org ?? authExtra.org, gha?.repo ?? authExtra.repo].filter(Boolean).join("/").trim() ||
    "";
  const installUrl = auth.githubApp?.appSlug
    ? repoFull
      ? `https://github.com/apps/${auth.githubApp.appSlug}/installations/new?state=${encodeURIComponent(repoFull)}`
      : `https://github.com/apps/${auth.githubApp.appSlug}/installations/new`
    : null;
  const directRepoInstallLink = (() => {
    if (!repoFull || !repoFull.includes("/")) return null;
    const [o, r] = repoFull.split("/") as [string, string];
    if (!o || !r) return null;
    // Deep link to repo's install/manage page — best UX when you already own the repo.
    return `https://github.com/${o}/${r}/settings/installs`;
  })();

  React.useEffect(() => {
    if (auth.githubApp?.origin || origin) return;
    setOrigin(window.location.origin);
  }, [auth.githubApp?.origin, origin]);

  const providers = React.useMemo(() => resolveOAuthProviders(auth), [auth]);

  const manifestPreview = React.useMemo(() => {
    const base = {
      name,
      url: origin || "(auto: window.location.origin)",
      redirect_url: `${origin || "https://example.com"}${manifestRedirectPath}`,
      callback_urls: [`${origin || "https://example.com"}${oauthCallbackPath}`],
      public: false,
      default_permissions: { contents, pull_requests: pullRequests, metadata: "read" },
      default_events: auth.githubApp?.webhookUrl
        ? (["pull_request", "push"] as const)
        : ([] as const),
    } as Record<string, unknown>;
    if (auth.githubApp?.webhookUrl) {
      base.hook_attributes = { url: auth.githubApp.webhookUrl, active: true };
    }
    return base;
  }, [
    contents,
    manifestRedirectPath,
    name,
    oauthCallbackPath,
    origin,
    pullRequests,
    auth.githubApp?.webhookUrl,
  ]);

  const signIn = React.useCallback(
    async (providerId: string) => {
      setBusyProvider(providerId);
      setBusy(true);
      setError(null);
      try {
        const response = await fetch(`${authBase}/sign-in/social`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: providerId,
            callbackURL,
            // For GitHub via GitHub App, repo scope isn't needed for sign-in — only read:user / user:email.
            // Keep repo for backward compat or when user truly needs repo write via PAT-less flow.
            scopes: providerId === "github" ? ["read:user", "user:email"] : undefined,
          }),
        });
        const result = (await response.json().catch(() => null)) as {
          url?: string;
          redirect?: boolean;
          message?: string;
        } | null;
        if (!response.ok) throw new Error(result?.message || response.statusText);
        if (result?.url) window.location.href = result.url;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
        setBusyProvider(null);
      }
    },
    [authBase, callbackURL],
  );

  const signOut = React.useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${authBase}/sign-out`, {
        method: "POST",
        credentials: "include",
      });
      if (!response.ok) throw new Error(await response.text());
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [authBase]);

  // ── New GitHub App creation flow — no popup DOM hack ──────────────
  // 1. POST /api/wildwood/github/app-manifest/start with desired manifest fields.
  //    Server sets __wildwood_github_app_state HttpOnly cookie and returns { action, manifest, state }.
  // 2. Build a POST form to GitHub with manifest=<json>&state=<state> and submit.
  // GitHub then shows review UI and redirects to redirect_url?code=...&state=...
  const createGitHubApp = React.useCallback(async () => {
    setCreating(true);
    setError(null);
    try {
      const startRes = await fetch("/api/wildwood/github/app-manifest/start", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          origin: origin || undefined,
          redirectPath: manifestRedirectPath,
          oauthCallbackPath,
          contents,
          pullRequests,
          webhookUrl: auth.githubApp?.webhookUrl,
        }),
      });
      if (!startRes.ok) {
        const t = await startRes.text().catch(() => startRes.statusText);
        throw new Error(`Failed to start manifest flow (${startRes.status}): ${t.slice(0, 500)}`);
      }
      const startData = (await startRes.json()) as {
        action: string;
        manifest: unknown;
        state: string;
      };

      // Submit to GitHub via a programmatic form POST — stable across browsers, no about:blank hack.
      const form = document.createElement("form");
      form.method = "POST";
      form.action = startData.action;
      // Open in new tab so the docs site stays open; state cookie is SameSite=Lax + scoped to origin so it's shared across tabs.
      form.target = "_blank";
      form.rel = "noopener";

      const mf = document.createElement("input");
      mf.type = "hidden";
      mf.name = "manifest";
      mf.value = JSON.stringify(startData.manifest);
      form.appendChild(mf);

      const st = document.createElement("input");
      st.type = "hidden";
      st.name = "state";
      st.value = startData.state;
      form.appendChild(st);

      document.body.appendChild(form);
      form.submit();
      // New-tab flow — keep this tab alive and reset busy state for re-try / copy.
      setCreating(false);
      return;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setCreating(false);
    }
  }, [
    auth.githubApp?.webhookUrl,
    contents,
    manifestRedirectPath,
    name,
    oauthCallbackPath,
    origin,
    pullRequests,
  ]);

  const sessionSection = (() => {
    const enabledProviders = providers.filter((p) => p.enabledResolved);
    const ghAppConfigured =
      auth.githubApp?.configured !== false &&
      (!!auth.githubApp?.appSlug || auth.githubApp?.configured === true);
    const providesOAuth = auth.githubApp?.providesOAuth !== false;
    const viaSingleApp = ghAppConfigured && providesOAuth;

    return (
      <div className="rounded-md border border-border bg-background/60 p-2">
        <p className="font-medium text-popover-foreground">Session</p>
        <p className="mt-1 break-all text-muted-foreground">
          {auth.userEmail ? `Signed in as ${auth.userEmail}` : "Not signed in"}
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {enabledProviders.length > 0 ? (
            enabledProviders.map((p) => (
              <Button
                key={p.id}
                className="h-8 text-xs"
                disabled={busy}
                onClick={() => void signIn(p.id)}
                type="button"
                variant="secondary"
              >
                {busy && busyProvider === p.id ? <Loader2 className="size-3 animate-spin" /> : null}
                Continue with {providerLabel(p.id, p.name)}
                {p.viaGitHubApp || (p.id === "github" && viaSingleApp) ? (
                  <span className="ml-1 rounded bg-muted px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
                    via App
                  </span>
                ) : null}
              </Button>
            ))
          ) : (
            <div className="space-y-1">
              {ghAppConfigured ? (
                <p className="text-muted-foreground">
                  GitHub sign-in will be available once your deploy picks up the App&apos;s{" "}
                  <code className="font-mono">GITHUB_CLIENT_ID</code>/
                  <code className="font-mono">GITHUB_CLIENT_SECRET</code> from the manifest
                  conversion. Redeploy after saving env.
                </p>
              ) : (
                <p className="text-muted-foreground">
                  Set up the GitHub App once — it provides both sign-in and write access. No
                  separate OAuth app needed. Or configure additional providers via{" "}
                  <code className="font-mono">auth.oauth.providers</code>.
                </p>
              )}
            </div>
          )}
          {auth.userEmail ? (
            <Button
              className="h-8 text-xs"
              disabled={busy}
              onClick={signOut}
              type="button"
              variant="secondary"
            >
              Sign out
            </Button>
          ) : null}
        </div>
        {viaSingleApp ? (
          <p className="mt-2 text-[11px] text-muted-foreground">
            Single credential set: your GitHub App&apos;s own{" "}
            <code className="font-mono">client_id</code>/
            <code className="font-mono">client_secret</code> doubles as the OAuth app. Add more
            providers later via <code className="font-mono">oauth.providers</code>.
          </p>
        ) : null}
      </div>
    );
  })();

  const githubAppManifestSection = (
    <div className="rounded-md border border-border bg-background/60 p-2">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-medium text-popover-foreground">GitHub App manifest</p>
          <p className="mt-1 text-muted-foreground">
            Create disposable app, then exchange manifest code (no webhook — works from preview).
          </p>
        </div>
        <Button
          className="h-7 px-2 text-xs"
          onClick={() => setName(randomAppName())}
          type="button"
          variant="secondary"
        >
          <Shuffle className="size-3" />
        </Button>
      </div>

      <div className="mt-3 grid gap-2">
        <label className="grid gap-1 text-muted-foreground">
          App name
          <input
            className="h-8 rounded-md border border-border bg-background px-2 text-popover-foreground outline-none ring-ring/40 focus:ring-2"
            onChange={(event) => setName(event.currentTarget.value)}
            value={name}
          />
        </label>
        <label className="grid gap-1 text-muted-foreground">
          Origin
          <input
            className="h-8 rounded-md border border-border bg-background px-2 font-mono text-[11px] text-popover-foreground outline-none ring-ring/40 focus:ring-2"
            onChange={(event) => setOrigin(trimSlashes(event.currentTarget.value))}
            placeholder={
              typeof window !== "undefined" ? window.location.origin : "https://your-app.vercel.app"
            }
            value={origin}
          />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <PermissionSelect label="Contents" onChange={setContents} value={contents} />
          <PermissionSelect label="PRs" onChange={setPullRequests} value={pullRequests} />
        </div>
        <p className="text-[11px] text-muted-foreground">
          Redirect → <code className="font-mono">{manifestRedirectPath}</code>
          <br />
          No webhook — creation works from any deploy, including protected previews.
        </p>
      </div>

      <details className="mt-3">
        <summary className="cursor-pointer text-muted-foreground">Manifest JSON (preview)</summary>
        <pre className="mt-2 max-h-40 overflow-auto rounded-md border border-border bg-background p-2 text-[10px] text-muted-foreground">
          {JSON.stringify(manifestPreview, null, 2)}
        </pre>
      </details>

      <Button
        className="mt-3 h-8 w-full text-xs"
        disabled={creating}
        onClick={createGitHubApp}
        type="button"
      >
        {creating ? <Loader2 className="mr-1 size-3 animate-spin" /> : null}
        Create GitHub App
      </Button>
      {installUrl ? (
        <>
          <div className="mt-2 grid gap-2">
            <a
              className="inline-flex h-8 w-full items-center justify-center rounded-md bg-secondary px-2 text-xs font-medium text-secondary-foreground hover:bg-secondary/80"
              href={installUrl}
              rel="noreferrer"
              target="_blank"
              title={
                repoFull
                  ? `Opens App install; choose Only select repositories → ${repoFull}`
                  : undefined
              }
            >
              Install GitHub App{repoFull ? ` on ${repoFull}` : " on a repo"}
            </a>
            {directRepoInstallLink ? (
              <a
                className="inline-flex h-7 w-full items-center justify-center rounded-md border border-border bg-background px-2 text-[11px] font-medium text-muted-foreground hover:bg-muted"
                href={directRepoInstallLink}
                rel="noreferrer"
                target="_blank"
              >
                Open {repoFull} → Settings → Installs
              </a>
            ) : null}
          </div>
          {repoFull ? (
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              On GitHub pick <b>Only select repositories</b> →{" "}
              <code className="font-mono">{repoFull.split("/")[1] ?? repoFull}</code>. No need to
              hunt — we link directly to <code className="font-mono">{repoFull}</code>.
            </p>
          ) : null}
        </>
      ) : null}
      <p className="mt-2 text-[11px] text-muted-foreground">
        After redirect you&apos;ll see Vercel CLI snippets and .env.local. Code is single-use,
        expires in 1h.
      </p>
    </div>
  );

  return (
    <div className="w-[min(92vw,24rem)] space-y-3 p-2 text-xs">
      {mode === "dev-setup" ? (
        <>
          <div>
            <p className="text-sm font-semibold text-popover-foreground">GitHub App (local dev)</p>
            <p className="mt-1 text-muted-foreground">
              Create disposable GitHub App for local testing. Production uses pre-configured
              credentials from Vercel env.
            </p>
          </div>
          {githubAppManifestSection}
        </>
      ) : (
        <>
          <div>
            <p className="text-sm font-semibold text-popover-foreground">Auth</p>
            <p className="mt-1 text-muted-foreground">
              GitHub sign-in for local Wildwood development.
            </p>
          </div>
          {sessionSection}
        </>
      )}

      {error ? (
        <p
          className={cn(
            "max-h-32 overflow-auto rounded-md border border-destructive/30 bg-destructive/10 p-2 text-destructive",
          )}
          role="alert"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}

function PermissionSelect({
  label,
  onChange,
  value,
}: {
  label: string;
  onChange: (permission: Permission) => void;
  value: Permission;
}) {
  return (
    <label className="grid gap-1 text-muted-foreground">
      {label}
      <select
        className="h-8 rounded-md border border-border bg-background px-2 text-popover-foreground outline-none ring-ring/40 focus:ring-2"
        onChange={(event) => onChange(event.currentTarget.value as Permission)}
        value={value}
      >
        <option value="read">read</option>
        <option value="write">write</option>
      </select>
    </label>
  );
}
