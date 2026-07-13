"use client";

import * as React from "react";

type Props = {
  /** Override displayed origin, otherwise window.location.origin */
  origin?: string;
  defaultName?: string;
  /** Defaults to bundled callback */
  redirectPath?: string;
  oauthCallbackPath?: string;
  /** Opt-in only — when omitted app is created with no webhook and no long-lived URL. */
  webhookUrl?: string;
};

export function WildwoodGitHubAppSetup({
  origin: originProp,
  defaultName = "Wildwood Dev",
  redirectPath = "/api/wildwood/github/app-manifest/callback",
  oauthCallbackPath = "/api/auth/callback/github",
  webhookUrl,
}: Props) {
  const [origin, setOrigin] = React.useState(originProp ?? "");
  const [name, setName] = React.useState(defaultName);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [manifestJson, setManifestJson] = React.useState("");

  React.useEffect(() => {
    if (originProp) {
      setOrigin(originProp);
      return;
    }
    setOrigin(window.location.origin);
  }, [originProp]);

  React.useEffect(() => {
    const o = origin || "https://example.com";
    setManifestJson(
      JSON.stringify(
        {
          name,
          url: o,
          redirect_url: `${o}${redirectPath}`,
          callback_urls: [`${o}${oauthCallbackPath}`],
          ...(webhookUrl ? { hook_attributes: { url: webhookUrl, active: true } } : {}),
          public: false,
          default_permissions: { contents: "write", pull_requests: "write", metadata: "read" },
          default_events: webhookUrl ? ["pull_request", "push"] : [],
        },
        null,
        2,
      ),
    );
  }, [name, origin, redirectPath, oauthCallbackPath, webhookUrl]);

  const onCreate = React.useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/wildwood/github/app-manifest/start", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          origin: origin || undefined,
          redirectPath,
          oauthCallbackPath,
          webhookUrl,
        }),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => res.statusText);
        throw new Error(t.slice(0, 800));
      }
      const data = (await res.json()) as { action: string; manifest: unknown; state: string };
      const form = document.createElement("form");
      form.method = "POST";
      form.action = data.action;
      form.target = "_blank";
      form.rel = "noopener";
      const m = document.createElement("input");
      m.type = "hidden";
      m.name = "manifest";
      m.value = JSON.stringify(data.manifest);
      form.appendChild(m);
      const s = document.createElement("input");
      s.type = "hidden";
      s.name = "state";
      s.value = data.state;
      form.appendChild(s);
      document.body.appendChild(form);
      form.submit();
      setBusy(false);
      return;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }, [name, origin, redirectPath, oauthCallbackPath, webhookUrl]);

  return (
    <section className="rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
      <h2 className="text-base font-semibold">GitHub App setup</h2>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
        Creates a GitHub App via Manifest flow. Redirects to the bundled callback <code>/api/wildwood/github/app-manifest/callback</code> which
        exchanges the code and shows Vercel CLI + <code>.env.local</code> snippets. No webhook by default — app creation works from any
        deployment including protected previews.
      </p>

      <div className="mt-4 grid gap-3">
        <label className="grid gap-1 text-sm">
          <span className="text-zinc-600 dark:text-zinc-400">App name</span>
          <input className="h-9 rounded border px-2" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="grid gap-1 text-sm">
          <span className="text-zinc-600 dark:text-zinc-400">Origin (homepage + webhook base)</span>
          <input className="h-9 rounded border px-2 font-mono text-xs" value={origin} onChange={(e) => setOrigin(e.target.value)} placeholder="https://your-app.vercel.app" />
        </label>
      </div>

      <details className="mt-4">
        <summary className="cursor-pointer text-sm text-zinc-600">Preview manifest JSON</summary>
        <pre className="mt-2 max-h-64 overflow-auto rounded border bg-zinc-50 p-3 text-xs dark:bg-zinc-900">{manifestJson}</pre>
      </details>

      <div className="mt-4 flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={onCreate}
          className="rounded bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60 dark:bg-white dark:text-zinc-900"
        >
          {busy ? "Starting…" : "Create GitHub App"}
        </button>
        <a className="rounded border px-3 py-2 text-sm" href="/api/wildwood/github/app-manifest">
          Inspect GET /app-manifest
        </a>
      </div>

      {error ? (
        <p className="mt-3 rounded border border-red-200 bg-red-50 p-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200">{error}</p>
      ) : null}
    </section>
  );
}
