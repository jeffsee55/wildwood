/**
 * `wildwood/nextjs/handlers/device-auth-router`
 *
 * Library-owned UI for the device-authorization flow (RFC 8628) plus a
 * dev-only sign-in page offering fixed local identities (no password prompt).
 * Mounted by `createHandler` at:
 *
 *   GET /api/wildwood/device            — verify/approve a device user_code
 *   GET /api/wildwood/device/signin     — dev-only sign-in (404 in production)
 *
 * These pages talk to better-auth's endpoints (served by the route layer under
 * `/api/auth/*`) from inline browser JS, using the caller's session cookie.
 * Nothing here bleeds into userland — the host app needs no /device pages.
 *
 * UI is intentionally inline HTML (same approach as the GitHub App manifest
 * router): a few KB of strings that ship in the package and cannot be
 * tree-shaken. All markup is isolated behind `renderDevicePage` /
 * `renderSigninPage`, so if this UI later grows into a compiled bundle we can
 * swap those two functions for a same-origin CDN proxy (see vscode-router
 * `/cdn`) without touching routes, mount, or auth wiring.
 */

import { H3 } from "h3";
import type { WildwoodClient } from "@/client/index";

// Where better-auth endpoints are served by the route layer.
const AUTH_BASE = "/api/auth";
// This router's own mount prefix (for building links between its pages).
const SELF_BASE = "/api/wildwood/device";

const BASE_CSS = `
  :root{color-scheme:light dark}
  *{box-sizing:border-box}
  body{font:14px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;max-width:34rem;margin:3rem auto;padding:0 1rem;color:#111}
  @media(prefers-color-scheme:dark){body{color:#e8e8e8;background:#0a0a0a}}
  h1{font-size:.8rem;font-weight:600;text-transform:uppercase;letter-spacing:.18em;margin:.25rem 0 1rem}
  p{color:#555;font-size:12.5px;line-height:1.9}
  @media(prefers-color-scheme:dark){p{color:#9a9a9a}}
  .card{border:1px solid #e1e1e1;border-radius:12px;padding:1.5rem;background:#fff}
  @media(prefers-color-scheme:dark){.card{background:#141414;border-color:#262626}}
  code{border:1px solid #e5e5e5;border-radius:6px;padding:.1rem .4rem;letter-spacing:.2em;background:#fafafa}
  @media(prefers-color-scheme:dark){code{background:#171717;border-color:#2a2a2a}}
  input{width:100%;border:1px solid #ddd;border-radius:8px;padding:.55rem .7rem;font:inherit;letter-spacing:.15em;text-transform:uppercase;background:#fff;color:inherit}
  input[type=email],input[type=password]{text-transform:none;letter-spacing:normal}
  @media(prefers-color-scheme:dark){input{background:#1f1f1f;border-color:#2a2a2a}}
  .row{display:flex;gap:.6rem;margin-top:1rem}
  button{appearance:none;border:1px solid #111;background:#111;color:#fff;border-radius:8px;padding:.55rem .95rem;font:inherit;font-weight:600;cursor:pointer}
  button.secondary{background:#fff;color:#111;border-color:#ddd}
  @media(prefers-color-scheme:dark){button.secondary{background:#1f1f1f;color:#e8e8e8;border-color:#2a2a2a}}
  button:disabled{opacity:.5;cursor:default}
  .ok{color:#16a34a} .err{color:#dc2626} .muted{color:#888;font-size:11.5px}
  label{display:block;margin-top:.9rem;font-size:11px;text-transform:uppercase;letter-spacing:.12em;color:#888}
`;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function htmlResponse(title: string, bodyInner: string, init?: ResponseInit): Response {
  const doc = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(
    title,
  )}</title><style>${BASE_CSS}</style></head><body>${bodyInner}</body></html>`;
  const headers = new Headers(init?.headers);
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cache-control", "no-store");
  const { headers: _omit, ...rest } = init ?? {};
  return new Response(doc, { ...rest, headers });
}

function isProd(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * Device verification + approve/deny page. All state transitions happen in the
 * browser against `${AUTH_BASE}/device*` using the caller's session cookie:
 *  1. GET  /device?user_code=…  — claim (bind the code to this session)
 *  2. POST /device/approve|deny — decide
 */
function renderDevicePage(userCode: string): string {
  const uc = escapeHtml(userCode);
  const authBase = escapeHtml(AUTH_BASE);
  const selfBase = escapeHtml(SELF_BASE);
  return `
  <div class="card">
    <h1>Device authorization</h1>
    <p>A device is requesting access to your account. Confirm the code shown on the device, then approve.</p>

    <form id="code-form" ${userCode ? "hidden" : ""}>
      <label for="uc">User code</label>
      <input id="uc" name="uc" value="${uc}" placeholder="XXXXXXXX" autocomplete="off" autofocus />
      <div class="row"><button type="submit">Continue</button></div>
    </form>

    <div id="decide" ${userCode ? "" : "hidden"}>
      <p>Code <code id="code-label">${uc}</code></p>
      <div id="status" class="muted">Checking…</div>
      <div class="row" id="actions" hidden>
        <button id="approve" type="button">Approve</button>
        <button id="deny" type="button" class="secondary">Deny</button>
      </div>
      <p id="result"></p>
    </div>
  </div>

  <script>
  (function(){
    var AUTH_BASE = ${JSON.stringify(AUTH_BASE)};
    var SELF_BASE = ${JSON.stringify(SELF_BASE)};
    var codeForm = document.getElementById('code-form');
    var decide = document.getElementById('decide');
    var statusEl = document.getElementById('status');
    var actions = document.getElementById('actions');
    var resultEl = document.getElementById('result');
    var approveBtn = document.getElementById('approve');
    var denyBtn = document.getElementById('deny');

    var params = new URLSearchParams(location.search);
    var userCode = (params.get('user_code') || ${JSON.stringify(userCode)} || '').trim();

    if (codeForm) {
      codeForm.addEventListener('submit', function(e){
        e.preventDefault();
        var v = (document.getElementById('uc').value || '').trim();
        if (v) location.href = SELF_BASE + '?user_code=' + encodeURIComponent(v);
      });
    }

    function signInPrompt(){
      var next = SELF_BASE + '?user_code=' + encodeURIComponent(userCode);
      statusEl.className = 'err';
      statusEl.innerHTML = 'You must sign in first. ' +
        '<a href="' + SELF_BASE + '/signin?next=' + encodeURIComponent(next) + '">Sign in</a>';
    }

    async function claim(){
      if (!userCode) return;
      try {
        var res = await fetch(AUTH_BASE + '/device?user_code=' + encodeURIComponent(userCode), {
          credentials: 'include', headers: { 'accept': 'application/json' }
        });
        if (res.status === 401 || res.status === 403) return signInPrompt();
        var data = await res.json().catch(function(){ return null; });
        if (!res.ok) {
          statusEl.className = 'err';
          statusEl.textContent = (data && (data.error_description || data.error)) || 'Invalid or expired code.';
          return;
        }
        if (data && data.status === 'approved') {
          statusEl.className = 'ok'; statusEl.textContent = 'Already approved.'; return;
        }
        if (data && data.status === 'denied') {
          statusEl.className = 'err'; statusEl.textContent = 'This code was denied.'; return;
        }
        statusEl.className = 'muted'; statusEl.textContent = 'Ready to approve.';
        actions.hidden = false;
      } catch (e) {
        statusEl.className = 'err'; statusEl.textContent = String(e);
      }
    }

    async function post(path){
      approveBtn.disabled = true; denyBtn.disabled = true;
      try {
        var res = await fetch(AUTH_BASE + '/device/' + path, {
          method: 'POST', credentials: 'include',
          headers: { 'content-type': 'application/json', 'accept': 'application/json' },
          body: JSON.stringify({ userCode: userCode })
        });
        var data = await res.json().catch(function(){ return null; });
        if (res.status === 401 || res.status === 403) return signInPrompt();
        if (!res.ok) {
          resultEl.className = 'err';
          resultEl.textContent = (data && (data.error_description || data.error)) || 'Request failed.';
          approveBtn.disabled = false; denyBtn.disabled = false;
          return;
        }
        actions.hidden = true;
        resultEl.className = path === 'approve' ? 'ok' : 'muted';
        resultEl.textContent = path === 'approve'
          ? 'Device approved. You can return to your device.'
          : 'Device denied.';
      } catch (e) {
        resultEl.className = 'err'; resultEl.textContent = String(e);
        approveBtn.disabled = false; denyBtn.disabled = false;
      }
    }

    if (approveBtn) approveBtn.addEventListener('click', function(){ post('approve'); });
    if (denyBtn) denyBtn.addEventListener('click', function(){ post('deny'); });
    claim();
  })();
  </script>
  `;
}

/**
 * Fixed local-dev identities. These exist purely to mirror production auth
 * flows (and to demo authz once roles land) — they are NOT secrets. There is no
 * DB migration/seed step: users are upserted on first sign-in via better-auth's
 * sign-up endpoint using a shared, hardcoded dev password (below).
 *
 * `role` is not enforced yet; it's surfaced here so the upcoming authz layer has
 * a stable identity to key off of. Emails use a real `.com` TLD because
 * better-auth's email validation rejects addresses without one.
 */
const DEV_USERS: ReadonlyArray<{ email: string; name: string; role: string }> = [
  { email: "admin@wildwood.com", name: "Wildwood Admin", role: "admin" },
  { email: "owner@wildwood.com", name: "Wildwood Owner", role: "owner" },
  { email: "contributer@wildwood.com", name: "Wildwood Contributer", role: "contributer" },
];

// Shared, non-secret dev password. Never prompted — hardcoded at persistence
// time so sign-in is fully opaque to the user.
const DEV_PASSWORD = "wildwood-dev-password";

/** Dev-only sign-in page — pick a fixed identity; no password prompt. */
function renderSigninPage(next: string): string {
  const buttons = DEV_USERS.map(
    (u) => `
      <button type="button" class="dev-user secondary" data-email="${escapeHtml(u.email)}" data-name="${escapeHtml(u.name)}">
        <span class="dev-role">${escapeHtml(u.role)}</span>
        <span class="dev-email">${escapeHtml(u.email)}</span>
      </button>`,
  ).join("");
  return `
  <div class="card">
    <h1>Sign in</h1>
    <p class="muted">Local development sign-in. Pick an identity to mirror production auth flows — no password required. Not available in production.</p>
    <div id="users" class="user-list">${buttons}</div>
    <p id="result"></p>
  </div>

  <style>
    .user-list{display:flex;flex-direction:column;gap:.6rem;margin-top:1rem}
    button.dev-user{display:flex;flex-direction:column;align-items:flex-start;gap:.2rem;width:100%;text-align:left;padding:.7rem .9rem}
    .dev-role{font-size:11px;text-transform:uppercase;letter-spacing:.14em;color:#888;font-weight:700}
    .dev-email{font-weight:500;letter-spacing:normal;text-transform:none}
  </style>

  <script>
  (function(){
    var AUTH_BASE = ${JSON.stringify(AUTH_BASE)};
    var next = ${JSON.stringify(next)};
    var PASSWORD = ${JSON.stringify(DEV_PASSWORD)};
    var resultEl = document.getElementById('result');
    var buttons = Array.prototype.slice.call(document.querySelectorAll('.dev-user'));

    async function call(path, body){
      var res = await fetch(AUTH_BASE + path, {
        method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json', 'accept': 'application/json' },
        body: JSON.stringify(body)
      });
      var data = await res.json().catch(function(){ return null; });
      return { ok: res.ok, data: data };
    }

    async function signIn(email, name){
      buttons.forEach(function(b){ b.disabled = true; });
      resultEl.className = 'muted'; resultEl.textContent = 'Signing in as ' + email + '…';
      try {
        var r = await call('/sign-in/email', { email: email, password: PASSWORD });
        // Upsert: if the identity doesn't exist yet, create it then retry.
        if (!r.ok || !(r.data && r.data.user)) {
          await call('/sign-up/email', { email: email, password: PASSWORD, name: name });
          r = await call('/sign-in/email', { email: email, password: PASSWORD });
        }
        if (r.ok && r.data && r.data.user) {
          resultEl.className = 'ok'; resultEl.textContent = 'Signed in. Redirecting…';
          location.href = next || '/';
          return;
        }
        resultEl.className = 'err';
        resultEl.textContent = (r.data && (r.data.message || r.data.error)) || 'Sign-in failed.';
      } catch (e) {
        resultEl.className = 'err'; resultEl.textContent = String(e);
      } finally {
        buttons.forEach(function(b){ b.disabled = false; });
      }
    }

    buttons.forEach(function(btn){
      btn.addEventListener('click', function(){
        signIn(btn.getAttribute('data-email'), btn.getAttribute('data-name'));
      });
    });
  })();
  </script>
  `;
}

/**
 * OAuth 2.1 consent page for the `oauthProvider` plugin (used by MCP clients).
 *
 * The authorization server redirects the signed-in user here with the full
 * signed authorization query string when a client requests consent. This page
 * shows the requesting client + scopes, then POSTs the decision to
 * `${AUTH_BASE}/oauth2/consent` with `{ accept, oauth_query }` where
 * `oauth_query` is this page's own `location.search` (the server needs it to
 * reconstruct + re-verify the request). The endpoint returns `{ redirect_uri }`
 * which we navigate to, handing the authorization code back to the client.
 */
function renderConsentPage(): string {
  return `
  <div class="card">
    <h1>Authorize application</h1>
    <p>An application is requesting access to your account. Review the details below, then approve or deny.</p>
    <div id="details" class="muted">Loading…</div>
    <div class="row" id="actions" hidden>
      <button id="approve" type="button">Approve</button>
      <button id="deny" type="button" class="secondary">Deny</button>
    </div>
    <p id="result"></p>
  </div>

  <script>
  (function(){
    var AUTH_BASE = ${JSON.stringify(AUTH_BASE)};
    var SELF_BASE = ${JSON.stringify(SELF_BASE)};
    var detailsEl = document.getElementById('details');
    var actions = document.getElementById('actions');
    var resultEl = document.getElementById('result');
    var approveBtn = document.getElementById('approve');
    var denyBtn = document.getElementById('deny');

    var params = new URLSearchParams(location.search);
    var clientId = params.get('client_id') || '(unknown client)';
    var scope = params.get('scope') || '';
    var scopes = scope.split(/[\\s+]+/).filter(Boolean);

    var scopeHtml = scopes.length
      ? '<ul>' + scopes.map(function(s){ return '<li><code>' + s.replace(/[&<>"]/g,'') + '</code></li>'; }).join('') + '</ul>'
      : '<p class="muted">No specific scopes requested.</p>';
    detailsEl.innerHTML =
      '<p>Client <code>' + clientId.replace(/[&<>"]/g,'') + '</code> is requesting:</p>' + scopeHtml;
    actions.hidden = false;

    async function decide(accept){
      approveBtn.disabled = true; denyBtn.disabled = true;
      resultEl.className = 'muted'; resultEl.textContent = accept ? 'Authorizing…' : 'Denying…';
      try {
        var res = await fetch(AUTH_BASE + '/oauth2/consent', {
          method: 'POST', credentials: 'include',
          headers: { 'content-type': 'application/json', 'accept': 'application/json' },
          body: JSON.stringify({ accept: accept, oauth_query: location.search })
        });
        if (res.status === 401 || res.status === 403) {
          resultEl.className = 'err';
          var next = SELF_BASE + '/consent' + location.search;
          resultEl.innerHTML = 'You must sign in first. <a href="' + SELF_BASE +
            '/signin?next=' + encodeURIComponent(next) + '">Sign in</a>';
          return;
        }
        var data = await res.json().catch(function(){ return null; });
        var redirect = data && (data.redirect_uri || data.redirectURI);
        if (res.ok && redirect) { location.href = redirect; return; }
        resultEl.className = 'err';
        resultEl.textContent = (data && (data.error_description || data.error)) || 'Authorization failed.';
        approveBtn.disabled = false; denyBtn.disabled = false;
      } catch (e) {
        resultEl.className = 'err'; resultEl.textContent = String(e);
        approveBtn.disabled = false; denyBtn.disabled = false;
      }
    }

    approveBtn.addEventListener('click', function(){ decide(true); });
    denyBtn.addEventListener('click', function(){ decide(false); });
  })();
  </script>
  `;
}

export function createDeviceAuthRouter(_client: WildwoodClient): H3 {
  const router = new H3();

  // GET /api/wildwood/device[?user_code=…]
  router.get("/", async (event) => {
    const userCode = (event.url.searchParams.get("user_code") ?? "").trim();
    return htmlResponse("Wildwood — Device authorization", renderDevicePage(userCode));
  });

  // GET /api/wildwood/device/signin — dev-only.
  router.get("/signin", async (event) => {
    if (isProd()) return new Response("Not found", { status: 404 });
    // Post-sign-in target resolution, in priority order:
    //  1. Explicit `?next=…` — the device flow bounces through here with
    //     `?next=…/device?user_code=…` so the user lands on the approval page.
    //  2. OAuth 2.1 `login` prompt — the `oauthProvider` redirects here with the
    //     signed authorization query (client_id/response_type/…) but no `next`.
    //     After sign-in we must return to `/oauth2/authorize` carrying those same
    //     params so the flow resumes and issues the code.
    //  3. App home.
    const params = event.url.searchParams;
    const explicitNext = (params.get("next") ?? "").trim();
    let target = "/";
    if (explicitNext) {
      target = explicitNext;
    } else if (params.get("client_id") && params.get("response_type")) {
      target = `${AUTH_BASE}/oauth2/authorize?${params.toString()}`;
    }
    // Only allow same-origin relative redirects.
    const safeNext = target.startsWith("/") && !target.startsWith("//") ? target : "/";
    return htmlResponse("Wildwood — Sign in", renderSigninPage(safeNext));
  });

  // GET /api/wildwood/device/consent — OAuth 2.1 consent page (MCP clients).
  router.get("/consent", async () => {
    return htmlResponse("Wildwood — Authorize application", renderConsentPage());
  });

  return router;
}
