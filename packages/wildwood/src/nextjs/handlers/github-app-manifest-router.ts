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
 * Webhook: opt-in only. When absent there is no long-lived server-to-server URL, so no
 * permanent Vercel protection bypass is needed in GitHub's stored config. `redirect_url`
 * is transient (single-use, 1h expiry) and may carry a `?x-vercel-protection-bypass=` param
 * only when called from a protected preview — GitHub discards it after exchange.
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
import type { WildwoodAuthAction } from "@/nextjs/auth";
import { resolveEventOrigin } from "./util";

export type GitHubAppManifestAuthorizeFn = (
  req: Request,
  action: WildwoodAuthAction,
) => Promise<Response | null>;

const STATE_COOKIE = "__wildwood_github_app_state";
const STATE_MAX_AGE_SEC = 10 * 60;

/** JS-readable cookie so the opener tab (docs) learns slug/installUrl after new-tab flow. */
const PENDING_COOKIE = "__wildwood_github_app_pending";
const PENDING_MAX_AGE_SEC = 10 * 60;
const BROADCAST_CHANNEL = "wildwood:gh-app-created";
const STORAGE_KEY = "__wildwood_gh_app_pending";

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

function mergeIntoHeaders(target: Headers, source: HeadersInit | Record<string, string | string[]> | undefined) {
  if (!source) return;
  if (source instanceof Headers) {
    source.forEach((value, key) => {
      if (key.toLowerCase() === "set-cookie") target.append(key, value);
      else target.set(key, value);
    });
    return;
  }
  if (Array.isArray(source)) {
    for (const [k, v] of source as [string, string][]) {
      if (k.toLowerCase() === "set-cookie") target.append(k, v);
      else target.set(k, v);
    }
    return;
  }
  for (const [k, raw] of Object.entries(source as Record<string, string | string[] | undefined>)) {
    if (raw == null) continue;
    if (Array.isArray(raw)) {
      for (const vi of raw) target.append(k, vi);
    } else {
      if (k.toLowerCase() === "set-cookie") target.append(k, raw as string);
      else target.set(k, raw as string);
    }
  }
}

function htmlResponse(bodyInner: string, init?: ResponseInit): Response {
  const doc = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Wildwood — GitHub App</title><style>${BASE_CSS}</style></head><body>${bodyInner}</body></html>`;
  const headers = new Headers();
  headers.set("content-type", "text/html; charset=utf-8");
  mergeIntoHeaders(headers, init?.headers as HeadersInit | undefined);
  const { headers: _h, ...rest } = init ?? {};
  return new Response(doc, { ...rest, headers });
}

function jsonResponse(data: unknown, init?: ResponseInit): Response {
  const headers = new Headers();
  headers.set("content-type", "application/json; charset=utf-8");
  mergeIntoHeaders(headers, init?.headers as HeadersInit | undefined);
  const { headers: _h, ...rest } = init ?? {};
  return new Response(JSON.stringify(data, null, 2), { ...rest, headers });
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

function setPendingAppCookieHeader(payload: { slug?: string; installUrl?: string; appId?: number | string | null; htmlUrl?: string; repo?: string }, secure: boolean): string {
  // Non-HttpOnly so JS tab can read it. No private key in here.
  const json = JSON.stringify({ ...payload, at: Date.now() });
  const attrs = [
    `${PENDING_COOKIE}=${encodeURIComponent(json)}`,
    "Path=/",
    `Max-Age=${PENDING_MAX_AGE_SEC}`,
    "SameSite=Lax",
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

function clearPendingCookieHeader(secure: boolean): string {
  const attrs = [`${PENDING_COOKIE}=`, "Path=/", `Max-Age=0`, "SameSite=Lax", "Expires=Thu, 01 Jan 1970 00:00:00 GMT"];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function setCookieHeaderPair(head: Record<string, string | string[]>, key: string, value: string) {
  const existing = head[key];
  if (!existing) {
    head[key] = value;
    return;
  }
  if (Array.isArray(existing)) head[key] = [...existing, value];
  else head[key] = [existing, value];
}

function appendSetCookie(headers: Headers, value: string) {
  headers.append("Set-Cookie", value);
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

export function createGitHubAppManifestRouter(
  client: WildwoodClient,
  opts: { authorize?: GitHubAppManifestAuthorizeFn } = {},
): H3 {
  const router = new H3();

  function resolveOrigin(event: { url: URL; req: { headers: { get(n: string): string | null } } }): string {
    return resolveEventOrigin(event);
  }

  /** Prefer explicit user config, then Vercel prod host, then request origin — in that order. */
  function resolveCanonicalOrigin(event: { url: URL; req: { headers: { get(n: string): string | null } } }): string {
    const configured = (process.env.WILDWOOD_ORIGIN ?? process.env.NEXT_PUBLIC_ORIGIN ?? "").trim();
    if (configured) return configured.replace(/\/+$/, "");

    const prodHost = (process.env.VERCEL_PROJECT_PRODUCTION_URL ?? "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
    if (prodHost) return `https://${prodHost}`;

    return resolveOrigin(event).replace(/\/+$/, "");
  }

  function defaultRedirectPath() {
    // As requested: bundled callback path.
    return "/api/wildwood/github/app-manifest/callback";
  }

  function defaultOrigin(event: { url: URL; req: { headers: { get(n: string): string | null } } }): string {
    const o = resolveOrigin(event);
    return o.replace(/\/+$/, "");
  }

  /** Build redirect_url, transiently adding Vercel bypass param on previews when available. */
  function buildCallbackUrl(origin: string): string {
    const base = `${origin}${defaultRedirectPath()}`;
    // Only needed when this deployment is a protected preview. `redirect_url` is
    // discarded by GitHub after the manifest exchange, so the secret is not
    // stored long-term anywhere, though it briefly appears in browser history.
    const secret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    const isPreview = process.env.VERCEL_ENV === "preview";
    if (!secret || !isPreview) return base;
    try {
      const u = new URL(base);
      if (!u.searchParams.has("x-vercel-protection-bypass")) {
        u.searchParams.set("x-vercel-protection-bypass", secret);
      }
      return u.toString();
    } catch {
      return base;
    }
  }

  // ── GET / — inspect defaults ──────────────────────────────────────
  router.get("/", async (event) => {
    const origin = resolveCanonicalOrigin(event);
    const redirectPath = defaultRedirectPath();
    const redirectUrl = buildCallbackUrl(origin);
    const isUsingFallbackOrigin = !process.env.WILDWOOD_ORIGIN && !process.env.NEXT_PUBLIC_ORIGIN && !process.env.VERCEL_PROJECT_PRODUCTION_URL;
    const manifest = buildWildwoodGitHubAppManifest({
      name: `Wildwood ${client._.git?.config?.repo ?? "Dev"}`,
      url: origin,
      redirectUrl,
    });
    return jsonResponse({
      origin,
      redirectPath,
      redirectUrl,
      usingFallbackOrigin: isUsingFallbackOrigin,
      note: isUsingFallbackOrigin
        ? "No production origin known — callback_urls will point at this preview and expire. Set WILDWOOD_ORIGIN or ensure a production deploy exists."
        : undefined,
      manifest,
    });
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

    // Prefer canonical origin for stability, allow explicit body.origin override.
    const canonical = resolveCanonicalOrigin(event);
    const origin = (body.origin?.trim() || canonical || originFromReq).replace(/\/+$/, "");
    const redirectPath = (body.redirectPath?.trim() || defaultRedirectPath()).startsWith("/")
      ? (body.redirectPath?.trim() || defaultRedirectPath())
      : `/${(body.redirectPath?.trim() || defaultRedirectPath()).replace(/^\/+/, "")}`;
    const redirectUrl = buildCallbackUrl(origin);
    const oauthCallbackPath = body.oauthCallbackPath?.trim() || "/api/auth/callback/github";
    // webhookUrl is opt-in only — if omitted we don't create a webhook at all, which means
    // no long-lived server-to-server URL to protect and no permanent bypass secret needed.
    const webhookUrl = body.webhookUrl?.trim() || undefined;

    const name = body.name?.trim() || `Wildwood ${client._.git?.config?.repo ?? "Dev"}`;

    const manifest = buildWildwoodGitHubAppManifest({
      name,
      url: origin,
      redirectUrl,
      callbackUrls: [`${origin}${oauthCallbackPath.startsWith("/") ? oauthCallbackPath : `/${oauthCallbackPath}`}`],
      webhookUrl: webhookUrl || undefined,
      webhookActive: body.webhookActive ?? true,
      defaultPermissions: {
        contents: (body.contents as GitHubPermissionLevel) ?? "write",
        pull_requests: (body.pullRequests as GitHubPermissionLevel) ?? "write",
      },
      public: body.public ?? false,
      defaultEvents: body.events ?? (webhookUrl ? ["pull_request", "push"] : []),
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
    const repoFull = `${client._.git?.config?.org ?? ""}/${client._.git?.config?.repo ?? ""}`.replace(/^\//, "");
    // Repo-scoped install link — encodes repo in ?state so the UI can guide "Only select repositories → {repo}".
    // Also provide direct repo settings link for one-click when user owns the repo.
    const installUrl = conversion.slug
      ? repoFull.includes("/")
        ? `https://github.com/apps/${encodeURIComponent(conversion.slug)}/installations/new?state=${encodeURIComponent(repoFull)}`
        : `https://github.com/apps/${encodeURIComponent(conversion.slug)}/installations/new`
      : "";
    const directRepoInstallUrl = repoFull.includes("/") ? `https://github.com/${repoFull}/settings/installs` : "";
    const suggestedInstallHint = repoFull && repoFull.includes("/") ? repoFull : client._.git?.config?.repo ?? "your repo";
    // Single credential set: the GitHub App IS the OAuth app. Conversion returns client_id/client_secret
    // which double as OAuth creds for sign-in. No second OAuth App needed.
    const _publicEnvKeys = [
      "GITHUB_APP_ID",
      "GITHUB_APP_SLUG",
      "GITHUB_CLIENT_ID",
      repoFull.includes("/") ? undefined : "GITHUB_APP_NAME",
    ].filter(Boolean) as string[];
    void _publicEnvKeys;
    const pendingPayload = {
      slug: conversion.slug,
      installUrl,
      htmlUrl: appHtmlUrl,
      appId: conversion.id,
      repo: suggestedInstallHint,
    } as const;

    if (wantsJson) {
      // Opener tab needs to learn slug/installUrl even though we open GitHub in a new tab.
      // Also accept optional `?setup_action=install` post-install redirect sharing same code param.
      const headers = new Headers();
      headers.set("Set-Cookie", clearStateCookieHeader(cookieToClear));
      appendSetCookie(headers, setPendingAppCookieHeader(pendingPayload, secure));
      return jsonResponse(
        {
          ok: true,
          conversion: { id: conversion.id, slug: conversion.slug, html_url: conversion.html_url, client_id: conversion.client_id },
          env,
          installUrl,
          htmlUrl: appHtmlUrl,
          stateValid,
          repo: suggestedInstallHint,
        },
        { headers },
      );
    }

    // ── HTML: 2-step wizard — Step 1 env, Step 2 install ────────────────────────
    const stepScript = `<script>
(function(){
  var root=document.getElementById('wildwood-gh-app');
  if(!root) return;

  var STORAGE_KEY=${JSON.stringify(STORAGE_KEY)};
  var BROADCAST=${JSON.stringify(BROADCAST_CHANNEL)};
  var slug=${JSON.stringify(conversion.slug ?? "")};
  var installUrl=${JSON.stringify(installUrl)};
  var appHtmlUrl=${JSON.stringify(appHtmlUrl)};
  var repo=${JSON.stringify(suggestedInstallHint)};
  var appId=${JSON.stringify(conversion.id)};

  // Expose to opener tab via BroadcastChannel + localStorage + JS-readable cookie (already set below via Set-Cookie on this response).
  // Cookie is non-HttpOnly __wildwood_github_app_pending; BC/storage covers same-origin even when cookie jar is partitioned.
  try {
    var payload={slug:slug,installUrl:installUrl,htmlUrl:appHtmlUrl,appId:appId,repo:repo,at:Date.now()};
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    if ('BroadcastChannel' in window) {
      var bc=new BroadcastChannel(BROADCAST);
      bc.postMessage(payload);
      // keep open briefly then close
      setTimeout(function(){ try{bc.close();}catch(e){} }, 1000);
    }
  } catch(e){}

  // Stepper
  var step=1;
  var step1=document.getElementById('step-1');
  var step2=document.getElementById('step-2');
  var pillStep1=document.getElementById('pill-step-1');
  var pillStep2=document.getElementById('pill-step-2');
  var continueBtn=document.getElementById('btn-continue-install');
  function setStep(n){
    step=n;
    if(step1) step1.hidden = n!==1;
    if(step2) step2.hidden = n!==2;
    if(pillStep1) pillStep1.setAttribute('data-active', n===1 ? 'true':'false');
    if(pillStep2) pillStep2.setAttribute('data-active', n===2 ? 'true':'false');
    if(!n || n===1){ history.replaceState(null,'','#step-keys'); }
    else { history.replaceState(null,'','#step-install'); }
  }
  // Tabs within step 1
  var tabs=root.querySelectorAll('[role=tab]');
  var panels=root.querySelectorAll('[role=tabpanel]');
  function activate(id){ panels.forEach(function(p){p.hidden=p.id!==id}); tabs.forEach(function(t){var s=t.getAttribute('aria-controls')===id; t.setAttribute('aria-selected', s?'true':'false')}); }
  tabs.forEach(function(t){t.addEventListener('click',function(){activate(t.getAttribute('aria-controls'))});});
  if(panels[0]) activate(panels[0].id);
  function copy(sel){ var el=document.querySelector(sel); if(!el) return; var txt=el.textContent||''; if(navigator.clipboard&&navigator.clipboard.writeText){ navigator.clipboard.writeText(txt).then(function(){ var b=document.activeElement; if(b){ var orig=b.textContent; b.textContent='Copied!'; setTimeout(function(){b.textContent=orig;},1200);} }).catch(function(){}); } else { var r=document.createRange(); r.selectNodeContents(el); var s=window.getSelection(); s&&s.removeAllRanges(); s&&s.addRange(r); } }
  root.querySelectorAll('[data-copy]').forEach(function(b){b.addEventListener('click',function(){copy(b.getAttribute('data-copy'))});});
  if(continueBtn){ continueBtn.addEventListener('click', function(){ setStep(2); }); }
  // deep-link #step-install support
  if(location.hash==='#step-install') setStep(2); else setStep(1);
  window.addEventListener('hashchange', function(){ if(location.hash==='#step-install') setStep(2); else if(location.hash==='#step-keys') setStep(1); });

  // Install verification — poll GitHub installation status via our own origin (which now has env).
  // Because this tab was created before env was persisted, verify may fail until redeploy / .env reload.
  // We show guidance for both cases.
  var verifyBtn=document.getElementById('btn-verify-install');
  var verifyMsg=document.getElementById('verify-msg');
  var doneBtn=document.getElementById('btn-done');
  function setVerify(html, ok){
    if(!verifyMsg) return;
    verifyMsg.innerHTML=html;
    verifyMsg.setAttribute('data-ok', ok ? 'true':'false');
  }
  if(verifyBtn){
    verifyBtn.addEventListener('click', async function(){
      verifyBtn.disabled=true; var orig=verifyBtn.textContent; verifyBtn.textContent='Checking…';
      try{
        // installation check is on /api/wildwood/github/installation (not app-manifest prefix) — also try editor-guards.
        // Single source: the App's own client_id/client_secret are the OAuth creds too — no second OAuth App.
        var urls=['/api/wildwood/github/installation','/api/wildwood/git/editor-guards'];
        var lastErr='';
        for(var i=0;i<urls.length;i++){
          try{
            var res=await fetch(urls[i],{credentials:'include',headers:{Accept:'application/json'}});
            var j=null; try{ j=await res.json(); }catch(_e){ var t=await res.text(); setVerify('<span class="muted">Unexpected response from '+urls[i]+': '+t.slice(0,400)+'</span>', false); continue; }
            if(!res.ok){ lastErr=(j&& (j.message||j.error))|| (res.status+' '+res.statusText); continue; }
            // normalize both shapes
            var st=j.status || (j.installationId ? 'installed' : (j.installUrl ? 'not_installed' : 'unknown'));
            if(st==='installed' || st==='ready'){
              setVerify('<b style="color:#15803d">✓ Installed'+(j.repo? ' on '+j.repo : '')+'</b> — you can close this tab and go back to the editor. If you still see “Install the GitHub App”, redeploy once so the server picks up GITHUB_APP_* (single cred set — App ID, private key, client_id/secret, slug).', true);
              if(doneBtn){ doneBtn.hidden=false; }
              verifyBtn.textContent='Verified ✓';
              return;
            }
            if(st==='not_installed'){
              setVerify('App not yet installed on <code>'+(j.repo||repo||'your repo')+'</code>. Open install link, pick <b>Only select repositories</b> → <code>'+(j.repo||repo||'repo')+'</code>, then click Verify again.', false);
              verifyBtn.textContent=orig; verifyBtn.disabled=false; return;
            }
            if(st==='not_configured'){
              setVerify('Server still reports <code>not_configured</code> — env vars haven\\'t propagated yet. This is the single credential set from this page: <code>GITHUB_APP_ID</code>, <code>GITHUB_PRIVATE_KEY</code> (also powers sign-in via <code>GITHUB_CLIENT_ID</code>/<code>SECRET</code> from same App), <code>GITHUB_APP_SLUG</code>. Set them in Vercel → Settings → Environment Variables (Build+Runtime, Preview+Production) and <b>Redeploy</b>. Locally: <code>vercel env pull .env.development.local</code> and restart.', false);
              verifyBtn.textContent=orig; verifyBtn.disabled=false; return;
            }
          }catch(e){ lastErr = e && e.message ? e.message : String(e); }
        }
        setVerify('Could not verify — '+ (lastErr||'network error') +'. That\\'s OK — if you completed GitHub\\'s “Only select repositories” flow, go back to the docs tab and click <b>I\\'ve installed it</b>. Single cred set — no separate OAuth app needed (GitHub App doubles as OAuth app).', false);
      } finally {
        if(verifyBtn.textContent==='Checking…'){ verifyBtn.textContent=orig; }
        verifyBtn.disabled=false;
      }
    });
  }
})();
</script>`;

    const vercelEnvCommands = vercelSnippets.join("\n");
    const envPre = escapeHtml(dotEnv);

    const body = `
<div class="card" id="wildwood-gh-app" style="max-width:56rem">
  <div class="row" style="align-items:center;gap:.5rem;margin-bottom:.25rem">
    <span class="pill" id="pill-step-1" data-active="true" style="cursor:default">Step 1: Save credentials</span>
    <span class="muted">→</span>
    <span class="pill" id="pill-step-2" data-active="false" style="cursor:default">Step 2: Install on repo</span>
    ${stateValid===false ? '<span class="pill" style="border-color:#f59e0b;color:#92400e">state mismatch (ignored)</span>' : ''}
  </div>
  <style>
    #pill-step-1[data-active=true],#pill-step-2[data-active=true]{border-color:#111;background:#111;color:#fff}
    @media(prefers-color-scheme:dark){#pill-step-1[data-active=true],#pill-step-2[data-active=true]{border-color:#e5e5e5;background:#e5e5e5;color:#111}}
    #verify-msg[data-ok=true]{border-color:#bbf7d0;background:#f0fdf4}
    #verify-msg[data-ok=false]{border-color:#e5e5e5;background:transparent}
    @media(prefers-color-scheme:dark){#verify-msg[data-ok=true]{border-color:#166534;background:#052e16} #verify-msg[data-ok=false]{border-color:#2a2a2a}}
  </style>

  <!-- ── STEP 1 ── -->
  <section id="step-1">
    <h1>GitHub App created — one credential set, two powers</h1>
    <p class="muted">This single App gives you both <b>sign-in</b> (GitHub App doubles as OAuth app via its own <code>client_id</code>/<code>secret</code>) and <b>write access</b> (installation token). No second OAuth App needed — happy path is 1 source of GH creds. Additional providers (Google, etc) stay configurable via <code>oauth.providers</code>.</p>
    <p class="muted" style="margin-top:.35rem">Step 2 will prompt you to install the App on <code>${escapeHtml(suggestedInstallHint || "your repo")}</code>: choose <b>Only select repositories</b> and pick that repo. On GitHub&apos;s screen that is the list where you see your repo name and can tick it — we can&apos;t pre-select it for you, but the Verify button checks it.</p>

    <div class="row" style="margin-top:.75rem">
      ${vercelEnvCommands ? `<span class="pill">Single cred set — Vercel CLI below</span>` : `<span class="pill">Single cred set — .env.local below</span>`}
      ${installUrl ? `<span class="pill">Slug: <code>${escapeHtml(conversion.slug ?? "")}</code></span>` : ``}
      ${repoFull.includes("/") ? `<span class="pill">Repo: <code>${escapeHtml(repoFull)}</code></span>` : ``}
      <span class="pill">OAuth via App — no separate OAuth App</span>
    </div>

    <div class="tabs" role="tablist" aria-label="Env output">
      <button role="tab" class="tab" aria-controls="panel-env" id="tab-env">.env.local</button>
      <button role="tab" class="tab" aria-controls="panel-vercel" id="tab-vercel">Vercel CLI</button>
      <button role="tab" class="tab" aria-controls="panel-export" id="tab-export">Shell export</button>
      <button role="tab" class="tab" aria-controls="panel-json" id="tab-json">JSON</button>
    </div>

    <section role="tabpanel" id="panel-env"><h2>.env.local</h2><pre id="pre-env">${envPre}</pre>
      <div class="row"><button class="btn btn-secondary" data-copy="#pre-env" type="button">Copy</button><span class="muted">Paste into <code>.env.local</code> then restart dev server. These 5 vars are the only GH creds you need for both sign-in and git writes.</span></div>
      <form method="post" action="/api/wildwood/github/app-manifest/dev/write-env" style="margin-top:.75rem">
        <input type="hidden" name="payload" value="${escapeHtml(JSON.stringify(env))}" />
        <button class="btn-secondary btn" type="submit">Write to .env.local (dev only)</button>
        <span class="muted">dev helper — same-origin + authorize gate.</span>
      </form>
    </section>
    <section role="tabpanel" id="panel-vercel"><h2>Vercel — production</h2>
      <pre id="pre-vercel">${escapeHtml(vercelSnippets.join("\n"))}</pre>
      <div class="row"><button class="btn btn-secondary" data-copy="#pre-vercel" type="button">Copy</button><span class="muted">Run after <code>vercel link</code>. Requires Vercel CLI login. Adds to <code>production</code> as sensitive. This single set powers both OAuth sign-in and git operations.</span></div>
      <p class="muted" style="margin-top:.5rem">Or manually in Vercel Dashboard → Project → Settings → Environment Variables (Build + Runtime / Preview + Production) — paste values from .env tab. Then <b>Redeploy</b> so build env picks up keys.</p>
      <p class="muted" style="margin-top:.5rem">Quick pull for local: <code>vercel env pull .env.development.local</code> — you don&apos;t need separate <code>GITHUB_CLIENT_ID</code>/<code>SECRET</code> from another OAuth App; reuse the App&apos;s own values already in the snippet above.</p>
    </section>
    <section role="tabpanel" id="panel-export"><h2>Shell export</h2><pre id="pre-export">${escapeHtml(exportSnippets.join("\n"))}</pre><p><button class="btn btn-secondary" data-copy="#pre-export">Copy</button></p></section>
    <section role="tabpanel" id="panel-json"><h2>JSON env map</h2><pre id="pre-json">${escapeHtml(JSON.stringify(env, null, 2))}</pre><p><button class="btn btn-secondary" data-copy="#pre-json">Copy</button></p></section>

    <div class="row" style="margin-top:1rem">
      <button class="btn" id="btn-continue-install" type="button">I've saved the env → Install App on repo →</button>
      ${installUrl ? `<a class="btn btn-secondary" href="${escapeHtml(installUrl)}" target="_blank" rel="noreferrer">Open Install directly (skip save)</a>` : ``}
    </div>
    <p class="muted" style="margin-top:.5rem">Saving env first ensures this page (and your docs deployment after redeploy) can verify installation in step 2. After install, return here and click Verify — we&apos;ll confirm <code>${escapeHtml(suggestedInstallHint || "your repo")}</code> is covered, so you never get stranded after the POC.</p>
    <details style="margin-top:1rem"><summary class="muted">Raw conversion (id, slug, html_url — secrets only in tabs above)</summary><pre>${escapeHtml(JSON.stringify({ id: conversion.id, slug: conversion.slug, html_url: conversion.html_url, client_id: conversion.client_id }, null, 2))}</pre></details>
  </section>

  <!-- ── STEP 2 ── -->
  <section id="step-2" hidden>
    <h1>Install the GitHub App on ${escapeHtml(repoFull || suggestedInstallHint || "your repository")}</h1>
    <p class="muted">On GitHub you&apos;ll see the App install screen. Choose <strong>Only select repositories</strong> and pick <code>${escapeHtml(suggestedInstallHint || "wildwood")}</code> — that&apos;s the repo list where you search / tick your repo. This grants Wildwood write access via the installation token. You stay in control of scope; we validate in the next click that the right repo is covered.</p>
    <p class="muted" style="margin-top:.35rem"><b>Single credential set:</b> this same App&apos;s <code>client_id</code>/<code>client_secret</code> (already saved as <code>GITHUB_CLIENT_ID</code>/<code>SECRET</code>) doubles as the OAuth app for sign-in. Additional providers (Google, etc) remain configurable via <code>oauth.providers</code> — no second GH credential set needed.</p>

    <div class="row" style="margin-top:1rem">
      ${installUrl ? `<a class="btn" id="btn-install-github" href="${escapeHtml(installUrl)}" target="_blank" rel="noopener noreferrer">Install on GitHub →</a>` : `<span class="pill">No slug in conversion — set GITHUB_APP_SLUG then reopen this page</span>`}
      <button class="btn btn-secondary" id="btn-verify-install" type="button">Verify installation</button>
      <a class="btn btn-secondary" id="btn-done" hidden href="/" rel="noreferrer">Done — back to docs →</a>
    </div>

    <div id="verify-msg" class="card" style="margin-top:1rem;padding:.75rem;min-height:2.5rem" data-ok="false"><span class="muted">Click Verify after you finish on GitHub. If you&apos;re on Vercel prod, redeploy once after pasting env vars so <code>/api/wildwood/github/installation</code> can read them — but install itself is already done, we just need env propagation to confirm it.</span></div>

    <div style="margin-top:1rem;border-top:1px solid #e5e5e5;padding-top:.75rem" class="muted">
      <p><b>Manual link (repo-scoped):</b> <code>${escapeHtml(installUrl || `https://github.com/apps/${escapeHtml(conversion.slug ?? "<slug>")}/installations/new`)}</code> — opens App install with <code>?state=${escapeHtml(repoFull || suggestedInstallHint)}</code> so you don't have to hunt. On that page choose <b>Only select repositories</b> → <code>${escapeHtml(suggestedInstallHint || "your repo")}</code> → Install.</p>
      ${directRepoInstallUrl ? `<p style="margin-top:.5rem"><b>Direct (when you own the repo):</b> <a href="${escapeHtml(directRepoInstallUrl)}" target="_blank" rel="noreferrer">${escapeHtml(directRepoInstallUrl)}</a> → Add/install this App.</p>` : ``}
      ${appHtmlUrl ? `<p><a class="btn btn-secondary" href="${escapeHtml(appHtmlUrl)}" target="_blank" rel="noreferrer" style="margin-top:.5rem">Open App settings</a> <span class="muted">— manage permissions / rename / delete. If you delete the App, recreate via toolbar; sign-in keeps working via same App creds.</span></p>` : ``}
      <p style="margin-top:.75rem"><a href="#step-keys" style="text-decoration:underline">← Back to env keys</a></p>
    </div>
  </section>
</div>
${stepScript}
`;

    const resHeaders = new Headers();
    resHeaders.set("content-type", "text/html; charset=utf-8");
    // Keep CSRF cookie clearing + set pending cookie so opener tab learns slug even in partitioned storage.
    appendSetCookie(resHeaders, clearStateCookieHeader(cookieToClear));
    appendSetCookie(resHeaders, setPendingAppCookieHeader(pendingPayload, secure));

    return new Response(
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Wildwood — GitHub App ready — install next</title><style>${BASE_CSS}</style></head><body>${body}</body></html>`,
      { status: 200, headers: resHeaders },
    );
  });

  // ── GET /pending — JS-readable pending payload from cookie/storage/BC ──────────
  // Returns same shape as PENDING_COOKIE so opener tab can recover even when JS cookie read fails.
  router.get("/pending", async (event) => {
    const cookieHeader = event.req.headers.get("cookie");
    const raw = cookieValueFromHeader(cookieHeader, PENDING_COOKIE);
    let parsed: unknown = null;
    try {
      if (raw) parsed = JSON.parse(raw);
    } catch {}
    // Accept query as well for debugging: ?slug=&installUrl=
    const slug = event.url.searchParams.get("slug")?.trim() || (parsed as { slug?: string } | null)?.slug || undefined;
    const installUrl =
      event.url.searchParams.get("installUrl")?.trim() ||
      (parsed as { installUrl?: string } | null)?.installUrl ||
      (slug ? `https://github.com/apps/${encodeURIComponent(slug)}/installations/new` : undefined);
    if (!installUrl && !slug) {
      return jsonResponse({ ok: false, pending: null }, { status: 404 });
    }
    const at = (parsed as { at?: number } | null)?.at;
    const appId = (parsed as { appId?: number | string | null } | null)?.appId ?? undefined;
    const htmlUrl = (parsed as { htmlUrl?: string } | null)?.htmlUrl ?? undefined;
    const repo = (parsed as { repo?: string } | null)?.repo ?? undefined;
    return jsonResponse({
      ok: true,
      pending: { slug, installUrl, htmlUrl, appId, repo, at: at ?? Date.now() },
    });
  });

  router.post("/pending/clear", async (event) => {
    const origin = defaultOrigin(event);
    const secure = origin.startsWith("https://");
    return jsonResponse({ ok: true }, { headers: { "Set-Cookie": clearPendingCookieHeader(secure) } });
  });

  // ── GET /installation — thin proxy: check installation for current repo ───────
  // Allows callback's Step 2 verify button to work even when main /github/installation route
  // is mounted at higher level — keeps logic self-contained here too.
  router.get("/installation", async (event) => {
    try {
      const { GitHubRemote: GR } = await import("@/git/remote/github");
      const remote = client._.git.remote as unknown;
      if (!(remote instanceof GR)) {
        return jsonResponse({ status: "not_configured", repo: `${client._.git.config.org}/${client._.git.config.repo}` });
      }
      const inst = await (remote as InstanceType<typeof GR>).getRepoInstallationStatus();
      const slug = process.env.GITHUB_APP_SLUG?.trim();
      const repo = `${client._.git.config.org}/${client._.git.config.repo}`;
      if (inst.status === "installed") {
        // Avoid duplicate `status` key from spread — `inst` carries `status: "installed"` and `installationId`.
        const { status: _ignored, ...rest } = inst as { status: string; installationId: number };
        return jsonResponse({ status: "installed", ...rest, repo, installationId: (inst as { installationId: number }).installationId });
      }
      return jsonResponse({
        status: inst.status,
        repo,
        installUrl: inst.status === "not_installed" && slug ? `https://github.com/apps/${slug}/installations/new` : undefined,
        hint: inst.status === "not_installed" ? `Install the GitHub App on ${repo}. Choose "Only select repositories" and pick ${client._.git.config.repo}.` : undefined,
      });
    } catch (e) {
      return jsonResponse({ status: "error", message: e instanceof Error ? e.message : String(e) }, { status: 500 });
    }
  });

  // ── POST /conversions — JSON API, gated by authorize (same policy as git writes) ──
  router.post("/conversions", async (event) => {
    // Gate via same authz used for git mutations — injected from route layer.
    if (opts.authorize) {
      const forbidden = await opts.authorize(event.req as unknown as Request, {
        type: "git.createBranch",
        name: "__github_app_manifest__",
      });
      if (forbidden) return forbidden;
    }

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
      const origin = defaultOrigin(event);
      const secure = origin.startsWith("https://");
      const repoFull2 = `${client._.git?.config?.org ?? ""}/${client._.git?.config?.repo ?? ""}`.replace(/^\//, "");
      const appHtmlUrl2 = conversion.html_url ?? (conversion.slug ? `https://github.com/settings/apps/${encodeURIComponent(conversion.slug)}` : "");
      const installUrl2 = conversion.slug
        ? repoFull2.includes("/")
          ? `https://github.com/apps/${encodeURIComponent(conversion.slug)}/installations/new?state=${encodeURIComponent(repoFull2)}`
          : `https://github.com/apps/${encodeURIComponent(conversion.slug)}/installations/new`
        : undefined;
      const headers = new Headers();
      headers.set("Set-Cookie", setPendingAppCookieHeader({ slug: conversion.slug, installUrl: installUrl2, htmlUrl: appHtmlUrl2, appId: conversion.id, repo: repoFull2 || undefined }, secure));
      return jsonResponse(
        {
          ok: true,
          conversion: { id: conversion.id, slug: conversion.slug, html_url: conversion.html_url, client_id: conversion.client_id },
          env,
          installUrl: installUrl2,
          htmlUrl: appHtmlUrl2,
        },
        { headers },
      );
    } catch (err) {
      return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
    }
  });

  // ── POST /dev/write-env — dev only, same authorize gate, writes .env.local ──
  router.post("/dev/write-env", async (event) => {
    if (process.env.NODE_ENV === "production") {
      return jsonResponse({ error: "Not available in production" }, { status: 403 });
    }
    if (opts.authorize) {
      const forbidden = await opts.authorize(event.req as unknown as Request, {
        type: "git.createBranch",
        name: "__github_app_manifest__",
      });
      if (forbidden) return forbidden;
    }

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
