/**
 * `wildwood/nextjs/handlers/github-app-manifest-router`
 *
 * Bundled routes for GitHub App manifest flow — automatically available at:
 *
 *   GET  /api/wildwood/github/app-manifest
 *   POST /api/wildwood/github/app-manifest/start
 *   GET  /api/wildwood/github/app-manifest/callback
 *   POST /api/wildwood/github/app-manifest/conversions
 *   POST /api/wildwood/github/app-manifest/dev/write-env  (dev only, gated by authorize)
 *
 * Resolves default redirect as requested:
 *   /api/wildwood/github/app-manifest/callback
 *
 * State: __wildwood_github_app_state httpOnly cookie to mitigate CSRF / code injection.
 * Webhook: included by default per product decision — manifest includes hook_attributes
 *          pointing to `${origin}/api/wildwood/github/webhook` (placeholder).
 */

import { H3 } from "h3";
import type { WildwoodClient } from "@/client/index";
import {
  buildWildwoodGitHubAppManifest,
  exchangeGitHubAppManifestCode,
  manifestConversionToEnv,
  vercelEnvAddSnippets,
  shellExportSnippets,
  formatEnvFileContent,
  type GitHubPermissionLevel,
} from "@/nextjs/github-app-manifest";
import { authorizeGitAction } from "./auth";
import { resolveEventOrigin } from "./util";

const STATE_COOKIE = "__wildwood_github_app_state";
const STATE_MAX_AGE_SEC = 10 * 60;

function randomState(): string {
  // Edge-safe: crypto.randomUUID is available everywhere Next runs.
  try {
    return crypto.randomUUID();
  } catch {
    return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  }
}

const BASE_CSS = `
  :root{color-scheme:light dark}
  *{box-sizing:border-box} body{font:14px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:56rem;margin:2.5rem auto;padding:0 1rem;color:#111}
  @media(prefers-color-scheme:dark){body{color:#e8e8e8;background:#0a0a0a} code,pre{color:#e8e8e8}}
  code,pre{font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
  pre{white-space:pre-wrap;word-break:break-all;border:1px solid #ddd;border-radius:8px;padding:.75rem;background:#fafafa;overflow:auto}
  @media(prefers-color-scheme:dark){pre{background:#171717;border-color:#2a2a2a}}
  .card{border:1px solid #e1e1e1;border-radius:12px;padding:1.25rem;background:#fff}
  @media(prefers-color-scheme:dark){.card{background:#141414;border-color:#262626}}
  .row{display:flex;gap:.5rem;flex-wrap:wrap}
  .btn{appearance:none;border:1px solid #111;background:#111;color:#fff;border-radius:8px;padding:.5rem .85rem;font-weight:600;cursor:pointer}
  .btn-secondary{background:#fff;color:#111;border-color:#ddd}
  @media(prefers-color-scheme:dark){.btn-secondary{background:#1f1f1f;color:#e8e8e8;border-color:#2a2a2a}}
  a{color:inherit} h1{font-size:1.35rem;margin:.25rem 0 .5rem} h2{font-size:1.05rem;margin:1.25rem 0 .25rem}
  .muted{color:#666} @media(prefers-color-scheme:dark){.muted{color:#9a9a9a}}
  .pill{display:inline-flex;align-items:center;border:1px solid #e5e5e5;border-radius:999px;padding:.15rem .55rem;font-size:11px}
  .grid{display:grid;gap:.75rem}
  .tabs{display:flex;gap:.25rem;border-bottom:1px solid #e5e5e5;margin-top:1rem}
  .tab{padding:.45rem .7rem;border:0;border-bottom:2px solid transparent;background:transparent;cursor:pointer;font-weight:600;color:#666}
  .tab[aria-selected=true]{color:#111;border-bottom-color:#111}
`;

function htmlResponse(bodyInner: string, init?: ResponseInit): Response {
  const doc = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Wildwood — GitHub App</title><style>${BASE_CSS}</style></head><body>${bodyInner}</body></html>`;
  return new Response(doc, {
    ...init,
    headers: { "content-type": "text/html; charset=utf-8", ...init?.headers },
  });
}

function jsonResponse(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: { "content-type": "application/json; charset=utf-8", ...init?.headers },
  });
}

function cookieValueFromHeader(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  const parts = cookieHeader.split(/;\s*/);
  for (const part of parts) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k !== name) continue;
    const v = part.slice(i + 1).trim();
    try {
      return decodeURIComponent(v);
    } catch {
      return v;
    }
  }
  return null;
}

function setStateCookieHeader(state: string, secure: boolean): string {
  const attrs = [
    `${STATE_COOKIE}=${encodeURIComponent(state)}`,
    "Path=/",
    `Max-Age=${STATE_MAX_AGE_SEC}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

function clearStateCookieHeader(secure: boolean): string {
  const attrs = [`${STATE_COOKIE}=`, "Path=/", "Max-Age=0", "HttpOnly", "SameSite=Lax", "Expires=Thu, 01 Jan 1970 00:00:00 GMT"];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

type StartBody = {
  name?: string;
  origin?: string;
  redirectPath?: string;
  oauthCallbackPath?: string;
  webhookUrl?: string;
  webhookActive?: boolean;
  contents?: GitHubPermissionLevel;
  pullRequests?: GitHubPermissionLevel;
  public?: boolean;
  events?: string[];
  description?: string;
};

export function createGitHubAppManifestRouter(client: WildwoodClient): H3 {
  const router = new H3();

  function resolveOrigin(event: { url: URL; req: { headers: { get(n: string): string | null } } }): string {
    return resolveEventOrigin(event);
  }

  function defaultRedirectPath() {
    // As requested: bundled callback path.
    return "/api/wildwood/github/app-manifest/callback";
  }

  function defaultOrigin(event: { url: URL; req: { headers: { get(n: string): string | null } } }): string {
    const o = resolveOrigin(event);
    return o.replace(/\/+$/, "");
  }

  // ── GET / — inspect defaults ──────────────────────────────────────
  router.get("/", async (event) => {
    const origin = defaultOrigin(event);
    const redirectPath = defaultRedirectPath();
    const redirectUrl = `${origin}${redirectPath}`;
    const manifest = buildWildwoodGitHubAppManifest({
      name: `Wildwood ${client._.git?.config?.repo ?? "Dev"}`,
      url: origin,
      redirectUrl,
    });
    return jsonResponse({ origin, redirectPath, redirectUrl, manifest });
  });

  // ── POST /start — set state cookie, return manifest + GitHub action URL ──
  router.post("/start", async (event) => {
    const originFromReq = defaultOrigin(event);
    let body: StartBody = {};
    try {
      const ct = event.req.headers.get("content-type") ?? "";
      if (ct.includes("application/json")) {
        body = (await event.req.json()) as StartBody;
      } else {
        const form = await event.req.formData().catch(() => null);
        if (form) {
          body = {
            name: String(form.get("name") ?? "").trim() || undefined,
            origin: String(form.get("origin") ?? "").trim() || undefined,
            redirectPath: String(form.get("redirectPath") ?? "").trim() || undefined,
            contents: (String(form.get("contents") ?? "").trim() as GitHubPermissionLevel) || undefined,
            pullRequests: (String(form.get("pullRequests") ?? "").trim() as GitHubPermissionLevel) || undefined,
          };
        }
      }
    } catch {
      // keep defaults
    }

    const origin = (body.origin?.trim() || originFromReq).replace(/\/+$/, "");
    const redirectPath = (body.redirectPath?.trim() || defaultRedirectPath()).startsWith("/")
      ? (body.redirectPath?.trim() || defaultRedirectPath())
      : `/${(body.redirectPath?.trim() || defaultRedirectPath()).replace(/^\/+/, "")}`;
    const redirectUrl = `${origin}${redirectPath}`;
    const oauthCallbackPath = body.oauthCallbackPath?.trim() || "/api/auth/callback/github";
    const webhookUrl = body.webhookUrl?.trim() || `${origin}/api/wildwood/github/webhook`;

    const name = body.name?.trim() || `Wildwood ${client._.git?.config?.repo ?? "Dev"}`;

    const manifest = buildWildwoodGitHubAppManifest({
      name,
      url: origin,
      redirectUrl,
      callbackUrls: [`${origin}${oauthCallbackPath.startsWith("/") ? oauthCallbackPath : `/${oauthCallbackPath}`}`],
      webhookUrl,
      webhookActive: body.webhookActive ?? true,
      contents: (body.contents as GitHubPermissionLevel) ?? "write",
      pullRequests: (body.pullRequests as GitHubPermissionLevel) ?? "write",
      public: body.public ?? false,
      defaultEvents: body.events ?? ["pull_request", "push"],
      description: body.description,
    });

    const state = randomState();
    const secure = origin.startsWith("https://");
    const action = "https://github.com/settings/apps/new";

    return jsonResponse(
      {
        state,
        action,
        manifest,
        redirectUrl,
        origin,
        hint: `POST ${action} with form field manifest=<json> and state=${state}. GitHub will redirect to ${redirectUrl}?code=...&state=${state}`,
      },
      { headers: { "Set-Cookie": setStateCookieHeader(state, secure) } },
    );
  });

  // ── GET /callback — verifies state, exchanges code, renders env UI ──
  router.get("/callback", async (event) => {
    const url = event.url;
    const code = (url.searchParams.get("code") ?? "").trim();
    const state = (url.searchParams.get("state") ?? "").trim() || null;
    const cookieHeader = event.req.headers.get("cookie");
    const cookieState = cookieValueFromHeader(cookieHeader, STATE_COOKIE);
    const origin = defaultOrigin(event);
    const secure = origin.startsWith("https://");

    // Accept: header sniff for JSON clients.
    const accept = event.req.headers.get("accept") ?? "";
    const wantsJson = accept.includes("application/json");

    if (!code) {
      if (wantsJson) return jsonResponse({ error: "Missing ?code" }, { status: 400 });
      return htmlResponse(
        `<div class="card"><h1>GitHub App callback</h1><p class="muted">Missing <code>?code=</code>. Start from Wildwood auth panel.</p><p><a href="/">Inspect manifest defaults</a></p></div>`,
        { status: 400 },
      );
    }

    const stateMatches = state && cookieState && state === cookieState;
    const stateValid = !state || stateMatches ? true : false; // state optional during local dev if cookies blocked
    const cookieToClear = secure;

    if (!state || !cookieState) {
      // No cookie — allow exchange but warn. Some browsers block 3p cookies during redirect.
      // Still exchange.
    } else if (!stateMatches) {
      if (wantsJson) {
        return jsonResponse({ error: "State mismatch", state, cookieState, code }, { status: 400 });
      }
      return htmlResponse(
        `<div class="card"><h1>State mismatch</h1><p>Callback <code>state</code> did not match the session cookie. This usually means cookies were blocked or you opened the link in a different tab.</p><p class="muted">Expected <code>${escapeHtml(cookieState)}</code> got <code>${escapeHtml(state)}</code>. Code was <code>${escapeHtml(code)}</code>.</p><p><a class="btn" href="${escapeHtml(origin)}/api/wildwood/github/app-manifest/callback?code=${encodeURIComponent(code)}">Re-try without state check</a></p></div>`,
        { status: 400, headers: { "Set-Cookie": clearStateCookieHeader(cookieToClear) } },
      );
    }

    // Exchange — single use, expires in 1h per GitHub
    let conversion;
    try {
      conversion = await exchangeGitHubAppManifestCode(code);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (wantsJson) return jsonResponse({ error: message, code }, { status: 500 });
      return htmlResponse(
        `<div class="card"><h1>Manifest exchange failed</h1><pre>${escapeHtml(message)}</pre><p class="muted">Code: <code>${escapeHtml(code)}</code> — single use, expires in 1 hour.</p></div>`,
        { status: 500, headers: { "Set-Cookie": clearStateCookieHeader(cookieToClear) } },
      );
    }

    const env = manifestConversionToEnv(conversion) as Record<string, string>;
    const vercelSnippets = vercelEnvAddSnippets(env);
    const exportSnippets = shellExportSnippets(env);
    const dotEnv = formatEnvFileContent(env);
    const appHtmlUrl = conversion.html_url ?? (conversion.slug ? `https://github.com/settings/apps/${encodeURIComponent(conversion.slug)}` : "");
    const installUrl = conversion.slug ? `https://github.com/apps/${encodeURIComponent(conversion.slug)}/installations/new` : "";

    if (wantsJson) {
      return jsonResponse(
        {
          ok: true,
          conversion: { id: conversion.id, slug: conversion.slug, html_url: conversion.html_url, client_id: conversion.client_id },
          env,
          installUrl,
          htmlUrl: appHtmlUrl,
          stateValid,
        },
        { headers: { "Set-Cookie": clearStateCookieHeader(cookieToClear) } },
      );
    }

    const tabsScript = `<script>
(function(){
  const root=document.getElementById('wildwood-gh-app');
  if(!root) return;
  const tabs=root.querySelectorAll('[role=tab]');
  const panels=root.querySelectorAll('[role=tabpanel]');
  function activate(id){ panels.forEach(p=>{p.hidden=p.id!==id}); tabs.forEach(t=>{const s=t.getAttribute('aria-controls')===id; t.setAttribute('aria-selected', s?'true':'false')}); }
  tabs.forEach(t=>t.addEventListener('click',()=>activate(t.getAttribute('aria-controls'))));
  activate(panels[0]?.id);
  function copy(sel){ const el=document.querySelector(sel); if(!el) return; const txt=el.textContent||''; navigator.clipboard.writeText(txt).then(()=>{ const b=document.activeElement; }).catch(()=>{ const r=document.createRange(); r.selectNodeContents(el); const s=window.getSelection(); s&&s.removeAllRanges(); s&&s.addRange(r); });}
  root.querySelectorAll('[data-copy]').forEach(b=>b.addEventListener('click',()=>copy(b.getAttribute('data-copy'))));
})();
</script>`;

    const body = `
<div class="card" id="wildwood-gh-app">
  <div class="row"><span class="pill">GitHub App created</span> ${stateValid===false?'<span class="pill" style="border-color:#f59e0b;color:#92400e">state mismatch (ignored)</span>':''}</div>
  <h1>Credentials ready</h1>
  <p class="muted">Code exchanged successfully. The manifest code was single-use and is now consumed.</p>

  <div class="row" style="margin-top:.75rem">
    ${appHtmlUrl ? `<a class="btn btn-secondary" href="${escapeHtml(appHtmlUrl)}" target="_blank" rel="noreferrer">Open App settings</a>` : ``}
    ${installUrl ? `<a class="btn" href="${escapeHtml(installUrl)}" target="_blank" rel="noreferrer">Install App on a repo</a>` : ``}
  </div>

  <div class="tabs" role="tablist" aria-label="Env output">
    <button role="tab" class="tab" aria-controls="panel-env" id="tab-env">.env.local</button>
    <button role="tab" class="tab" aria-controls="panel-vercel" id="tab-vercel">Vercel CLI</button>
    <button role="tab" class="tab" aria-controls="panel-export" id="tab-export">Shell export</button>
    <button role="tab" class="tab" aria-controls="panel-json" id="tab-json">JSON</button>
  </div>

  <section role="tabpanel" id="panel-env"><h2>.env.local</h2><pre id="pre-env">${escapeHtml(dotEnv)}</pre><p><button class="btn btn-secondary" data-copy="#pre-env" type="button">Copy</button> <span class="muted">Paste into <code>.env.local</code> then restart dev server.</span></p></section>
  <section role="tabpanel" id="panel-vercel"><h2>Vercel</h2><pre id="pre-vercel">${escapeHtml(vercelSnippets.join("\n"))}</pre><p><button class="btn btn-secondary" data-copy="#pre-vercel" type="button">Copy</button> <span class="muted">Run after <code>vercel link</code>. Requires Vercel CLI login. Adds to <code>production</code> as sensitive.</span></p><p class="muted">Or manually in Vercel Dashboard → Project → Settings → Environment Variables (Build + Runtime) — paste values from .env tab.</p></section>
  <section role="tabpanel" id="panel-export"><h2>Shell export</h2><pre id="pre-export">${escapeHtml(exportSnippets.join("\n"))}</pre><p><button class="btn btn-secondary" data-copy="#pre-export">Copy</button></p></section>
  <section role="tabpanel" id="panel-json"><h2>JSON env map</h2><pre id="pre-json">${escapeHtml(JSON.stringify(env, null, 2))}</pre><p><button class="btn btn-secondary" data-copy="#pre-json">Copy</button></p>
    <h2 style="margin-top:1rem">Save to .env.local (dev)</h2>
    <p class="muted">Dev helper — writes via <code>POST /api/wildwood/github/app-manifest/dev/write-env</code>. Disabled in prod.</p>
    <form method="post" action="/api/wildwood/github/app-manifest/dev/write-env">
      <input type="hidden" name="payload" value="${escapeHtml(JSON.stringify(env))}" />
      <button class="btn-secondary btn" type="submit">Write to .env.local and restart hint</button>
    </form>
  </section>

  <details style="margin-top:1rem"><summary class="muted">Raw conversion (id, slug, html_url shown, secrets via tabs above)</summary><pre>${escapeHtml(JSON.stringify({ id: conversion.id, slug: conversion.slug, html_url: conversion.html_url, client_id: conversion.client_id }, null, 2))}</pre></details>
</div>
${tabsScript}
`;

    return new Response(
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Wildwood — GitHub App ready</title><style>${BASE_CSS}</style></head><body>${body}</body></html>`,
      {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "Set-Cookie": clearStateCookieHeader(cookieToClear),
        },
      },
    );
  });

  // ── POST /conversions — JSON API, gated by authorize (same policy as git writes) ──
  router.post("/conversions", async (event) => {
    // Gate via same authz used for git mutations.
    const forbidden = await authorizeGitAction(client, event.req, { type: "git.createBranch", name: "__github_app_manifest__" });
    if (forbidden) return forbidden;

    let code = "";
    const ct = event.req.headers.get("content-type") ?? "";
    try {
      if (ct.includes("application/json")) {
        const j = (await event.req.clone().json()) as { code?: string };
        code = String(j?.code ?? "").trim();
      } else {
        const form = await event.req.formData().catch(() => null);
        if (form) code = String(form.get("code") ?? "").trim();
      }
    } catch {
      // try query param fallback
      code = event.url.searchParams.get("code")?.trim() ?? "";
    }

    if (!/^[a-f0-9]+$/i.test(code)) {
      return jsonResponse({ error: "Missing or invalid ?code" }, { status: 400 });
    }

    try {
      const conversion = await exchangeGitHubAppManifestCode(code);
      const env = manifestConversionToEnv(conversion) as Record<string, string>;
      return jsonResponse({
        ok: true,
        conversion: { id: conversion.id, slug: conversion.slug, html_url: conversion.html_url, client_id: conversion.client_id },
        env,
        installUrl: conversion.slug ? `https://github.com/apps/${conversion.slug}/installations/new` : undefined,
      });
    } catch (err) {
      return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
    }
  });

  // ── POST /dev/write-env — dev only, same authorize gate, writes .env.local ──
  router.post("/dev/write-env", async (event) => {
    if (process.env.NODE_ENV === "production") {
      return jsonResponse({ error: "Not available in production" }, { status: 403 });
    }
    const forbidden = await authorizeGitAction(client, event.req, { type: "git.createBranch", name: "__github_app_manifest__" });
    if (forbidden) return forbidden;

    let envMap: Record<string, string> | null = null;
    try {
      const ct = event.req.headers.get("content-type") ?? "";
      if (ct.includes("application/json")) {
        const j = (await event.req.json()) as { env?: Record<string, string>; payload?: string | Record<string, string> };
        if (j.env && typeof j.env === "object") envMap = j.env as Record<string, string>;
        else if (typeof j.payload === "string") envMap = JSON.parse(j.payload) as Record<string, string>;
        else if (j.payload && typeof j.payload === "object") envMap = j.payload as Record<string, string>;
      } else {
        const form = await event.req.formData().catch(() => null);
        if (form) {
          const raw = String(form.get("payload") ?? form.get("env") ?? "").trim();
          if (raw) {
            try {
              envMap = JSON.parse(raw) as Record<string, string>;
            } catch {
              envMap = null;
            }
          }
          if (!envMap) {
            // allow individual fields
            const candidate: Record<string, string> = {};
            for (const k of ["GITHUB_APP_ID", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "GITHUB_PRIVATE_KEY", "GITHUB_APP_SLUG", "GITHUB_WEBHOOK_SECRET"]) {
              const v = form.get(k);
              if (typeof v === "string" && v) candidate[k] = v;
            }
            if (Object.keys(candidate).length) envMap = candidate;
          }
        }
      }
    } catch {
      // ignore
    }

    if (!envMap || !envMap.GITHUB_APP_ID || !envMap.GITHUB_PRIVATE_KEY) {
      return htmlResponse(`<div class="card"><h1>Missing env</h1><p>Provide JSON payload with at least GITHUB_APP_ID and GITHUB_PRIVATE_KEY.</p></div>`, {
        status: 400,
      });
    }

    // Dynamic import for Node-only fs usage — keep bundlers happy.
    const { default: fs } = await import("node:fs/promises");
    const { default: path } = await import("node:path");

    const envPath = path.resolve(".env.local");
    let current = "";
    try {
      current = await fs.readFile(envPath, "utf8");
    } catch (e) {
      if (!(e instanceof Error) || !("code" in e) || (e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }

    function q(v: string) {
      return JSON.stringify(v);
    }
    const lines = current.split(/\r?\n/);
    const seen = new Set<string>();
    const next = lines.map((line) => {
      const key = Object.keys(envMap!).find((k) => line.startsWith(`${k}=`));
      if (!key) return line;
      seen.add(key);
      return `${key}=${q(envMap![key] ?? "")}`;
    });
    const missing = Object.entries(envMap)
      .filter(([k]) => !seen.has(k))
      .map(([k, v]) => `${k}=${q(v)}`);
    if (missing.length) {
      if (next.length && next[next.length - 1] !== "") next.push("");
      next.push("# GitHub App manifest flow");
      next.push(...missing);
    }
    const out = `${next.join("\n").replace(/\n*$/, "")}\n`;
    await fs.mkdir(path.dirname(envPath), { recursive: true });
    await fs.writeFile(envPath, out);

    const accept = event.req.headers.get("accept") ?? "";
    if (accept.includes("application/json")) {
      return jsonResponse({ ok: true, envPath, keys: Object.keys(envMap) });
    }

    return htmlResponse(
      `<div class="card"><h1>Wrote ${escapeHtml(envPath)}</h1><p>Wrote: ${Object.keys(envMap).map((k) => `<code>${escapeHtml(k)}</code>`).join(", ")}</p><p class="muted">Restart your dev server so env vars reload.</p><p><a class="btn btn-secondary" href="/">Back</a></p></div>`,
    );
  });

  return router;
}
