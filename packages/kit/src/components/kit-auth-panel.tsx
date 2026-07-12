"use client";

import { Loader2, Shuffle } from "lucide-react";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Permission = "read" | "write";

export type KitAuthConfig = {
  /** Show auth/developer entries in the Kit menu. Defaults to auto. */
  enabled?: boolean;
  authBase?: string;
  callbackURL?: string;
  userEmail?: string | null;
  githubOAuthEnabled?: boolean;
  /** Optimistically passed even when partially empty — library decides prod enforcement. */
  githubApp?: {
    appSlug?: string;
    name?: string;
    origin?: string;
    manifestRedirectPath?: string;
    oauthCallbackPath?: string;
    contents?: Permission;
    pullRequests?: Permission;
  };
  /**
   * When true, the library enforces required auth fields and throws in prod.
   * Defaults to `process.env.NODE_ENV === "production"` inside the library —
   * the host does not need to set this; it just always passes whatever it has.
   */
  enforceInProduction?: boolean;
};

type Props = {
  auth: KitAuthConfig;
  /** When `"dev-setup"`, only the GitHub App manifest UI (local testing). Default: session sign-in/out. */
  mode?: "session" | "dev-setup";
};

function trimSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

function randomAppName() {
  return `Tr33 Play Dev ${Math.random().toString(36).slice(2, 7)}`;
}

function normalizeAuthBase(authBase: string | undefined): string {
  const base = trimSlashes(authBase || "/api/auth");
  return base.startsWith("/") ? base : `/${base}`;
}

function manifestState(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2);
}

export function KitAuthPanel({ auth, mode = "session" }: Props) {
  const authBase = normalizeAuthBase(auth.authBase);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [name, setName] = React.useState(
    auth.githubApp?.name || "Tr33 Play Dev",
  );
  const [origin, setOrigin] = React.useState(
    auth.githubApp?.origin || "",
  );
  const [contents, setContents] = React.useState<Permission>(
    auth.githubApp?.contents || "write",
  );
  const [pullRequests, setPullRequests] = React.useState<Permission>(
    auth.githubApp?.pullRequests || "write",
  );

  const manifestRedirectPath =
    auth.githubApp?.manifestRedirectPath || "/github-app-manifest";
  const oauthCallbackPath =
    auth.githubApp?.oauthCallbackPath || `${authBase}/callback/github`;
  const callbackURL = auth.callbackURL || "/";
  const installUrl = auth.githubApp?.appSlug
    ? `https://github.com/apps/${auth.githubApp.appSlug}/installations/new`
    : null;

  React.useEffect(() => {
    if (auth.githubApp?.origin || origin) {
      return;
    }
    setOrigin(window.location.origin);
  }, [auth.githubApp?.origin, origin]);

  const manifest = React.useMemo(
    () => ({
      name,
      url: origin,
      redirect_url: `${origin}${manifestRedirectPath}`,
      callback_urls: [`${origin}${oauthCallbackPath}`],
      public: false,
      default_permissions: {
        contents,
        pull_requests: pullRequests,
        metadata: "read",
      },
      default_events: [],
    }),
    [
      contents,
      manifestRedirectPath,
      name,
      oauthCallbackPath,
      origin,
      pullRequests,
    ],
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
      const result = (await response.json().catch(() => null)) as {
        url?: string;
        redirect?: boolean;
        message?: string;
      } | null;
      if (!response.ok) {
        throw new Error(result?.message || response.statusText);
      }
      if (result?.url) {
        window.location.href = result.url;
      }
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
      const response = await fetch(`${authBase}/sign-out`, {
        method: "POST",
        credentials: "include",
      });
      if (!response.ok) {
        throw new Error(await response.text());
      }
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [authBase]);

  const createGitHubApp = React.useCallback(() => {
    const action = new URL("https://github.com/settings/apps/new");
    action.searchParams.set("state", manifestState());

    const popup = window.open("about:blank", "_blank");
    if (!popup) {
      setError("Your browser blocked the GitHub App setup popup.");
      return;
    }

    popup.document.title = "Opening GitHub App setup...";
    const message = popup.document.createElement("p");
    message.textContent = "Opening GitHub App setup...";
    popup.document.body.append(message);

    const form = popup.document.createElement("form");
    form.action = action.toString();
    form.method = "post";

    const input = popup.document.createElement("input");
    input.type = "hidden";
    input.name = "manifest";
    input.value = JSON.stringify(manifest);
    form.append(input);

    const submit = popup.document.createElement("button");
    submit.type = "submit";
    submit.textContent = "Continue to GitHub";
    form.append(submit);

    popup.document.body.append(form);
    form.submit();
  }, [manifest]);

  const sessionSection = (
    <div className="rounded-md border border-border bg-background/60 p-2">
      <p className="font-medium text-popover-foreground">Session</p>
      <p className="mt-1 break-all text-muted-foreground">
        {auth.userEmail ? `Signed in as ${auth.userEmail}` : "Not signed in"}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {auth.githubOAuthEnabled ? (
          <Button
            className="h-8 text-xs"
            disabled={busy}
            onClick={signInWithGitHub}
            type="button"
            variant="secondary"
          >
            {busy ? <Loader2 className="size-3 animate-spin" /> : null}
            Continue with GitHub
          </Button>
        ) : (
          <p className="text-muted-foreground">
            Set GitHub OAuth env vars to enable sign-in.
          </p>
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
    </div>
  );

  const githubAppManifestSection = (
    <div className="rounded-md border border-border bg-background/60 p-2">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-medium text-popover-foreground">
            GitHub App manifest
          </p>
          <p className="mt-1 text-muted-foreground">
            Create a disposable app, then exchange the manifest code.
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
            onChange={(event) =>
              setOrigin(trimSlashes(event.currentTarget.value))
            }
            value={origin}
          />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <PermissionSelect
            label="Contents"
            onChange={setContents}
            value={contents}
          />
          <PermissionSelect
            label="PRs"
            onChange={setPullRequests}
            value={pullRequests}
          />
        </div>
      </div>

      <details className="mt-3">
        <summary className="cursor-pointer text-muted-foreground">
          Manifest JSON
        </summary>
        <pre className="mt-2 max-h-40 overflow-auto rounded-md border border-border bg-background p-2 text-[10px] text-muted-foreground">
          {JSON.stringify(manifest, null, 2)}
        </pre>
      </details>

      <Button
        className="mt-3 h-8 w-full text-xs"
        onClick={createGitHubApp}
        type="button"
      >
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
        {installUrl
          ? "Install the app to grant repository access, then restart or refresh after env changes."
          : "After exchanging the manifest, restart so GITHUB_APP_SLUG can enable app installation."}
      </p>
    </div>
  );

  return (
    <div className="w-[min(92vw,24rem)] space-y-3 p-2 text-xs">
      {mode === "dev-setup" ? (
        <>
          <div>
            <p className="text-sm font-semibold text-popover-foreground">
              GitHub App (local dev)
            </p>
            <p className="mt-1 text-muted-foreground">
              Create a disposable GitHub App for local testing. Production
              deployments should use pre-configured app credentials.
            </p>
          </div>
          {githubAppManifestSection}
        </>
      ) : (
        <>
          <div>
            <p className="text-sm font-semibold text-popover-foreground">
              Auth
            </p>
            <p className="mt-1 text-muted-foreground">
              GitHub sign-in for local Tr33 development.
            </p>
          </div>
          {sessionSection}
        </>
      )}

      {error ? (
        <p
          className={cn(
            "max-h-24 overflow-auto rounded-md border border-destructive/30 bg-destructive/10 p-2 text-destructive",
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
