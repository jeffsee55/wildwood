"use client";

import { Loader2, Shuffle } from "lucide-react";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Permission = "read" | "write";

export type KitAuthConfig = {
  enabled?: boolean;
  authBase?: string;
  callbackURL?: string;
  userEmail?: string | null;
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

export function KitAuthPanel({ auth, mode = "session" }: Props) {
  const authBase = normalizeAuthBase(auth.authBase);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [name, setName] = React.useState(auth.githubApp?.name || "Wildwood Play Dev");
  const [origin, setOrigin] = React.useState(auth.githubApp?.origin || "");
  const [contents, setContents] = React.useState<Permission>(auth.githubApp?.contents || "write");
  const [pullRequests, setPullRequests] = React.useState<Permission>(auth.githubApp?.pullRequests || "write");

  const manifestRedirectPath = auth.githubApp?.manifestRedirectPath || "/api/wildwood/github/app-manifest/callback";
  const oauthCallbackPath = auth.githubApp?.oauthCallbackPath || `${authBase}/callback/github`;
  const callbackURL = auth.callbackURL || "/";
  const installUrl = auth.githubApp?.appSlug
    ? `https://github.com/apps/${auth.githubApp.appSlug}/installations/new`
    : null;

  React.useEffect(() => {
    if (auth.githubApp?.origin || origin) return;
    setOrigin(window.location.origin);
  }, [auth.githubApp?.origin, origin]);

  const manifestPreview = React.useMemo(
    () => ({
      name,
      url: origin || "(auto: window.location.origin)",
      redirect_url: `${origin || "https://example.com"}${manifestRedirectPath}`,
      callback_urls: [`${origin || "https://example.com"}${oauthCallbackPath}`],
      hook_attributes: auth.githubApp?.webhookUrl
        ? { url: auth.githubApp.webhookUrl, active: true }
        : { url: `${origin || "https://example.com"}/api/wildwood/github/webhook`, active: true },
      public: false,
      default_permissions: { contents, pull_requests: pullRequests, metadata: "read" },
      default_events: ["pull_request", "push"],
    }),
    [contents, manifestRedirectPath, name, oauthCallbackPath, origin, pullRequests, auth.githubApp?.webhookUrl],
  );

  const signInWithGitHub = React.useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${authBase}/sign-in/social`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "github",
          callbackURL,
          scopes: ["repo", "read:user", "user:email"],
        }),
      });
      const result = (await response.json().catch(() => null)) as { url?: string; redirect?: boolean; message?: string } | null;
      if (!response.ok) throw new Error(result?.message || response.statusText);
      if (result?.url) window.location.href = result.url;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [authBase, callbackURL]);

  const signOut = React.useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${authBase}/sign-out`, { method: "POST", credentials: "include" });
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
      // Open in same tab preserves state cookie best (redirect goes back to our origin).
      form.target = "_self";

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
      // Navigation will leave page — no need to clean up.
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setCreating(false);
    }
  }, [auth.githubApp?.webhookUrl, contents, manifestRedirectPath, name, oauthCallbackPath, origin, pullRequests]);

  const sessionSection = (
    <div className="rounded-md border border-border bg-background/60 p-2">
      <p className="font-medium text-popover-foreground">Session</p>
      <p className="mt-1 break-all text-muted-foreground">
        {auth.userEmail ? `Signed in as ${auth.userEmail}` : "Not signed in"}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {auth.githubOAuthEnabled ? (
          <Button className="h-8 text-xs" disabled={busy} onClick={signInWithGitHub} type="button" variant="secondary">
            {busy ? <Loader2 className="size-3 animate-spin" /> : null}
            Continue with GitHub
          </Button>
        ) : (
          <p className="text-muted-foreground">Set GitHub OAuth env vars to enable sign-in.</p>
        )}
        {auth.userEmail ? (
          <Button className="h-8 text-xs" disabled={busy} onClick={signOut} type="button" variant="secondary">
            Sign out
          </Button>
        ) : null}
      </div>
    </div>
  );

  const githubAppManifestSection = (
    <div className="rounded-md border border-border bg-background/60 p-2">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-medium text-popover-foreground">GitHub App manifest</p>
          <p className="mt-1 text-muted-foreground">Create disposable app, then exchange manifest code (now with webhook).</p>
        </div>
        <Button className="h-7 px-2 text-xs" onClick={() => setName(randomAppName())} type="button" variant="secondary">
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
            placeholder={typeof window !== "undefined" ? window.location.origin : "https://your-app.vercel.app"}
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
          Webhook → <code className="font-mono">/api/wildwood/github/webhook</code> (placeholder, 501 until wired)
        </p>
      </div>

      <details className="mt-3">
        <summary className="cursor-pointer text-muted-foreground">Manifest JSON (preview)</summary>
        <pre className="mt-2 max-h-40 overflow-auto rounded-md border border-border bg-background p-2 text-[10px] text-muted-foreground">
          {JSON.stringify(manifestPreview, null, 2)}
        </pre>
      </details>

      <Button className="mt-3 h-8 w-full text-xs" disabled={creating} onClick={createGitHubApp} type="button">
        {creating ? <Loader2 className="mr-1 size-3 animate-spin" /> : null}
        Create GitHub App
      </Button>
      {installUrl ? (
        <a
          className="mt-2 inline-flex h-8 w-full items-center justify-center rounded-md bg-secondary px-2 text-xs font-medium text-secondary-foreground hover:bg-secondary/80"
          href={installUrl}
          rel="noreferrer"
          target="_blank"
        >
          Install GitHub App on a repo
        </a>
      ) : null}
      <p className="mt-2 text-[11px] text-muted-foreground">
        After redirect you&apos;ll see Vercel CLI snippets and .env.local. Code is single-use, expires in 1h.
      </p>
    </div>
  );

  return (
    <div className="w-[min(92vw,24rem)] space-y-3 p-2 text-xs">
      {mode === "dev-setup" ? (
        <>
          <div>
            <p className="text-sm font-semibold text-popover-foreground">GitHub App (local dev)</p>
            <p className="mt-1 text-muted-foreground">Create disposable GitHub App for local testing. Production uses pre-configured credentials from Vercel env.</p>
          </div>
          {githubAppManifestSection}
        </>
      ) : (
        <>
          <div>
            <p className="text-sm font-semibold text-popover-foreground">Auth</p>
            <p className="mt-1 text-muted-foreground">GitHub sign-in for local Wildwood development.</p>
          </div>
          {sessionSection}
        </>
      )}

      {error ? (
        <p className={cn("max-h-32 overflow-auto rounded-md border border-destructive/30 bg-destructive/10 p-2 text-destructive")} role="alert">
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
