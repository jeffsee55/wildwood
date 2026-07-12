/**
 * `wildwood/nextjs/github-app-manifest`
 *
 * First-class GitHub App creation via Manifest flow.
 *
 * Real GitHub flow (https://docs.github.com/en/apps/creating-github-apps/using-the-github-app-manifest-flow):
 *   1. Host builds manifest JSON, POSTs as `manifest=<json>` to https://github.com/settings/apps/new
 *      (or /organizations/{org}/settings/apps/new) — GitHub shows review screen.
 *   2. User clicks Create → GitHub redirects to redirect_url?code=<tmp>&state=<state>
 *   3. Server exchanges code once via POST https://api.github.com/app-manifests/:code/conversions
 *      → returns { id, slug, client_id, client_secret, webhook_secret, pem, html_url }.
 *
 * This module:
 *   - builds manifest JSON with defaults (webhook included per product decision)
 *   - exchanges code via fetch (no `gh` CLI)
 *   - provides helpers to map conversion → env vars / shell snippets
 *   - provides a callback UI component for the redirect page
 *   - keeps legacy `createGitHubAppManifestConversionRoute` working but deprecated,
 *     delegating to the new fetch path.
 */

import fs from "node:fs/promises";
import path from "node:path";

// ── types ───────────────────────────────────────────────────────────────

export type GitHubPermissionLevel = "read" | "write" | "admin";

export type WildwoodGitHubAppManifestOptions = {
  name: string;
  /** Public homepage URL shown on the GitHub App page. Defaults to origin. */
  url?: string;
  /** Where GitHub redirects after user confirms creation: ?code=...&state=... */
  redirectUrl: string;
  /** OAuth callback URLs registered on the app. */
  callbackUrls?: string[];
  /** Webhook URL, if you want webhooks. Default: `${origin}/api/wildwood/github/webhook` */
  webhookUrl?: string;
  /** Provide true to auto-activate webhook. */
  webhookActive?: boolean;
  public?: boolean;
  defaultPermissions?: {
    contents?: GitHubPermissionLevel;
    pull_requests?: GitHubPermissionLevel;
    metadata?: Extract<GitHubPermissionLevel, "read">;
    administration?: GitHubPermissionLevel;
  };
  /** Manifest `default_events`. Defaults to minimal set needed for wildwood. */
  defaultEvents?: string[];
  /** Description shown on GitHub's App page. */
  description?: string;
};

export type WildwoodGitHubAppManifest = {
  name: string;
  url: string;
  description?: string;
  redirect_url: string;
  callback_urls?: string[];
  hook_attributes?: { url: string; active: boolean } | null;
  public: boolean;
  default_permissions: {
    contents: GitHubPermissionLevel;
    pull_requests: GitHubPermissionLevel;
    metadata: "read";
    administration?: GitHubPermissionLevel;
  };
  default_events: string[];
};

export type GitHubAppManifestConversion = {
  id: number;
  slug?: string;
  name?: string;
  html_url?: string;
  client_id: string;
  client_secret: string;
  webhook_secret?: string | null;
  pem: string;
};

export type WildwoodGitHubEnvMap = Record<string, string> & {
  GITHUB_APP_ID: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GITHUB_PRIVATE_KEY: string;
};

// ── manifest builder ────────────────────────────────────────────────────

export function buildWildwoodGitHubAppManifest(
  opts: WildwoodGitHubAppManifestOptions,
): WildwoodGitHubAppManifest {
  const origin = opts.redirectUrl ? new URL(opts.redirectUrl).origin : (opts.url ?? "");
  const url = opts.url ?? origin;
  if (!url) throw new Error("buildWildwoodGitHubAppManifest: need `url` or `redirectUrl` to infer origin");

  const trimmed = (s: string) => s.trim();
  const webhookUrl = opts.webhookUrl ?? (origin ? `${origin}/api/wildwood/github/webhook` : undefined);

  const manifest: WildwoodGitHubAppManifest = {
    name: trimmed(opts.name) || "Wildwood Dev",
    url: trimmed(url),
    redirect_url: trimmed(opts.redirectUrl),
    callback_urls: (opts.callbackUrls ?? []).map(trimmed).filter(Boolean),
    hook_attributes: webhookUrl
      ? { url: trimmed(webhookUrl), active: Boolean(opts.webhookActive ?? true) }
      : undefined,
    public: opts.public ?? false,
    default_permissions: {
      contents: opts.defaultPermissions?.contents ?? "write",
      pull_requests: opts.defaultPermissions?.pull_requests ?? "write",
      metadata: "read" as const,
      ...(opts.defaultPermissions?.administration
        ? { administration: opts.defaultPermissions.administration }
        : {}),
    },
    default_events: opts.defaultEvents ?? ["pull_request", "push"],
  };

  if (opts.description) manifest.description = opts.description;

  if (!manifest.callback_urls?.length) {
    // Guarantee at least OAuth callback if we can infer it.
    const oauth = origin ? `${origin}/api/auth/callback/github` : null;
    if (oauth) manifest.callback_urls = [oauth];
  }

  // GitHub requires webhook url when events are non-empty; keep attribute consistent.
  if (!manifest.default_events.length && manifest.hook_attributes) {
    // Keep hook_attributes only if you really want webhooks. Per product decision we do.
    // But if someone passes default_events=[] explicitly and no hook wanted, they'd pass webhookUrl=undefined.
  }

  return manifest;
}

// ── exchange ────────────────────────────────────────────────────────────

export async function exchangeGitHubAppManifestCode(
  code: string,
  opts?: { apiBase?: string; fetchImpl?: typeof fetch },
): Promise<GitHubAppManifestConversion> {
  const c = String(code ?? "").trim();
  if (!/^[a-f0-9]+$/i.test(c)) throw new Error("Invalid manifest code");
  const apiBase = (opts?.apiBase ?? "https://api.github.com").replace(/\/+$/, "");
  const f = opts?.fetchImpl ?? fetch;
  const res = await f(`${apiBase}/app-manifests/${encodeURIComponent(c)}/conversions`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `GitHub manifest exchange failed (${res.status}): ${body.slice(0, 800) || res.statusText}`,
    );
  }

  const data = (await res.json()) as GitHubAppManifestConversion;
  if (!data?.id || !data?.client_id || !data?.client_secret || !data?.pem) {
    throw new Error("GitHub returned incomplete manifest conversion");
  }
  return data;
}

// ── env mapping / snippets ──────────────────────────────────────────────

export function manifestConversionToEnv(
  conversion: GitHubAppManifestConversion,
  opts?: { includeOptional?: boolean },
): WildwoodGitHubEnvMap {
  const includeOptional = opts?.includeOptional ?? true;
  const env: Record<string, string> = {
    GITHUB_APP_ID: String(conversion.id),
    GITHUB_CLIENT_ID: conversion.client_id,
    GITHUB_CLIENT_SECRET: conversion.client_secret,
    GITHUB_PRIVATE_KEY: conversion.pem,
  };
  if (includeOptional) {
    if (conversion.slug) env.GITHUB_APP_SLUG = conversion.slug;
    if (conversion.webhook_secret) env.GITHUB_WEBHOOK_SECRET = conversion.webhook_secret;
  }
  return env as WildwoodGitHubEnvMap;
}

function shellSingleQuote(s: string): string {
  // POSIX single-quote escaping: ' -> '\''
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function formatEnvFileContent(values: Record<string, string>): string {
  // .env format — use JSON.stringify quoting which dotenv libs handle for multiline PEM.
  return Object.entries(values)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join("\n")
    .replace(/\n*$/, "\n");
}

export function vercelEnvAddSnippets(values: Record<string, string>): string[] {
  // Generates portable shell snippet using printf '%s' "$val" | vercel env add NAME production --sensitive
  // Caller must have `vercel link`ed.
  const lines: string[] = ["# Requires: vercel link (once), Vercel CLI installed & logged in"];
  for (const [k, v] of Object.entries(values)) {
    lines.push(`printf '%s' ${shellSingleQuote(v)} | vercel env add ${k} production --sensitive`);
  }
  lines.push("");
  lines.push("# Or to add to preview+development too, re-run with: --upsert && select envs interactively");
  return lines;
}

export function shellExportSnippets(values: Record<string, string>): string[] {
  return Object.entries(values).map(([k, v]) => `export ${k}=${shellSingleQuote(v)}`);
}

// ── legacy .env.local writers (dev-only) ──────────────────────────────────

function envQuote(value: string): string {
  return JSON.stringify(value);
}

function updateEnvContent(current: string, values: Record<string, string>): string {
  const lines = current.split(/\r?\n/);
  const seen = new Set<string>();
  const next = lines.map((line) => {
    const key = Object.keys(values).find((candidate) => line.startsWith(`${candidate}=`));
    if (!key) return line;
    seen.add(key);
    return `${key}=${envQuote(values[key] ?? "")}`;
  });

  const missing = Object.entries(values)
    .filter(([key]) => !seen.has(key))
    .map(([key, value]) => `${key}=${envQuote(value)}`);

  if (missing.length > 0) {
    if (next.length > 0 && next[next.length - 1] !== "") next.push("");
    next.push("# GitHub App manifest flow");
    next.push(...missing);
  }

  return `${next.join("\n").replace(/\n*$/, "")}\n`;
}

async function writeManifestEnv(options: {
  conversion: GitHubAppManifestConversion;
  envPath: string;
}): Promise<string[]> {
  const values = manifestConversionToEnv(options.conversion) as Record<string, string>;

  let current = "";
  try {
    current = await fs.readFile(options.envPath, "utf8");
  } catch (err) {
    if (!(err instanceof Error) || !("code" in err) || (err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  await fs.mkdir(path.dirname(options.envPath), { recursive: true });
  await fs.writeFile(options.envPath, updateEnvContent(current, values));
  return Object.keys(values);
}

function htmlResponse(body: string, init?: ResponseInit) {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>Wildwood — GitHub App</title></head><body style="font-family: system-ui, sans-serif; max-width: 52rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.6;">${body}</body></html>`,
    {
      ...init,
      headers: { "content-type": "text/html; charset=utf-8", ...init?.headers },
    },
  );
}

// ── deprecated compat route (now fetch-based, no gh CLI) ─────────────────

export function githubAppManifestConversionCommand(code: string): string {
  // Kept for docs / display only.
  return `gh api --method POST /app-manifests/${code}/conversions`;
}

/**
 * @deprecated Prefer bundled routes:
 *   - GET  /api/wildwood/github/app-manifest          → manifest JSON
 *   - POST /api/wildwood/github/app-manifest/start    → sets state cookie, returns manifest + action URL
 *   - GET  /api/wildwood/github/app-manifest/callback → verifies state, exchanges code, renders env UI
 *   - POST /api/wildwood/github/app-manifest/conversions { code } → JSON exchange (authorized)
 *
 * This function is kept working for `apps/play/api/github-app-manifest/conversions`.
 * It no longer shells out to `gh` — it uses fetch and writes .env.local in dev only.
 */
export function createGitHubAppManifestConversionRoute(options?: { envPath?: string }) {
  return async function POST(request: Request) {
    if (process.env.NODE_ENV === "production") {
      return htmlResponse("<h1>Not available in production</h1><p>Use the bundled /api/wildwood/github/app-manifest flow.</p>", {
        status: 403,
      });
    }

    let code = "";
    const ct = request.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      try {
        const j = (await request.clone().json()) as { code?: string };
        code = String(j.code ?? "").trim();
      } catch {
        // fallthrough to form
      }
    }
    if (!code) {
      try {
        const form = await request.formData();
        code = String(form.get("code") ?? "").trim();
      } catch {
        // ignore
      }
    }

    if (!/^[a-f0-9]+$/i.test(code)) {
      return htmlResponse("<h1>Missing or invalid manifest code</h1>", { status: 400 });
    }

    try {
      const conversion = await exchangeGitHubAppManifestCode(code);
      const envPath = path.resolve(options?.envPath ?? ".env.local");
      const keys = await writeManifestEnv({ conversion, envPath });
      const appLink = conversion.html_url ? `<p><a href="${conversion.html_url}">Open GitHub App settings</a></p>` : "";
      return htmlResponse(`
        <h1>GitHub App credentials written</h1>
        <p>Updated <code>${envPath}</code>.</p>
        <p>Wrote: ${keys.map((k) => `<code>${k}</code>`).join(", ")}</p>
        <p>Restart your dev server so the new environment variables are loaded.</p>
        ${appLink}
        <details style="margin-top:1rem"><summary>vercel env add snippets</summary><pre style="white-space:pre-wrap;overflow:auto;border:1px solid #ddd;padding:.75rem;background:#fafafa;">${vercelEnvAddSnippets(
          manifestConversionToEnv(conversion) as Record<string, string>,
        )
          .join("\n")
          .replace(/</g, "&lt;")}</pre></details>
      `);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return htmlResponse(`<h1>Could not exchange manifest code</h1><pre style="white-space: pre-wrap">${escapeHtml(message)}</pre>`, {
        status: 500,
      });
    }
  };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── callback component ──────────────────────────────────────────────────

export function GitHubAppManifestCallback({ code, stateValid }: { code?: string | null; stateValid?: boolean }) {
  return (
    <section className="w-full max-w-2xl rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
      <h1 className="text-lg font-semibold text-zinc-950 dark:text-zinc-50">GitHub App manifest callback</h1>
      {stateValid === false ? (
        <div className="mt-3 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
          State mismatch — the callback <code>state</code> did not match the cookie set when you started creation. This can happen if cookies were blocked or you restarted the flow. Re-try creating the app. Code below may still work if GitHub issued it, but verification failed.
        </div>
      ) : null}
      {code ? (
        <>
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
            GitHub returned a temporary manifest code. Exchange it once (code expires in 1 hour) to get your App credentials.
          </p>
          <div className="mt-4 grid gap-3">
            <form action="/api/wildwood/github/app-manifest/conversions" method="post" className="contents">
              <input name="code" type="hidden" value={code} />
              <button
                className="rounded bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
                type="submit"
              >
                Exchange code → show credentials
              </button>
            </form>

            <details className="rounded border border-zinc-200 p-3 text-xs dark:border-zinc-800">
              <summary className="cursor-pointer">Legacy local exchange</summary>
              <p className="mt-2 text-zinc-600 dark:text-zinc-400">
                If you still use the old isolated route:
              </p>
              <pre className="mt-2 overflow-auto rounded bg-zinc-50 p-2 dark:bg-zinc-900">{githubAppManifestConversionCommand(code)}</pre>
              <form action="/api/github-app-manifest/conversions" method="post" className="mt-2">
                <input name="code" type="hidden" value={code} />
                <button className="rounded border px-2 py-1 text-xs" type="submit">
                  Exchange via legacy route (dev .env.local)
                </button>
              </form>
            </details>
          </div>
        </>
      ) : (
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          No manifest code found. Start creation from the Wildwood toolbar → Auth → GitHub App (local dev).
        </p>
      )}
    </section>
  );
}
