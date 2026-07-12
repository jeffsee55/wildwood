---
title: Kit (toolbar and editor)
author: ../authors/jeff.md
description: "The floating editor surface — WildwoodKit, Toolbar, ThemeProvider, branch sync, and the VS Code embedded shell."
---

# Kit (toolbar and editor)

Kit is the floating UI your app mounts once — at the bottom of the page or near the layout — to let editors switch branches, create drafts, and open the VS Code web shell that edits your `content/` through the same `/api/git/*` routes.

## Import paths

```ts
import { WildwoodKit, Toolbar } from "wildwood"nextjs/kit";
import type { KitAuthConfig, ToolbarProps, WildwoodKitProps } from "wildwood"nextjs/kit";
```

`WildwoodKit` and `Toolbar` are Server Components. They resolve cookies and VS Code CDN commit on the server, then render `ClientKitBoundary` (a `use client` + `dynamic(..., { ssr:false })` wrapper) whose ref/portal/shadow DOM avoids the `Cannot read useRef of null` RSC pre-resolution crash.

`@wildwood/kit` is the underlying client package — shadcn/ui + Vite library. You never import it directly unless you're building your own host frame.

## Toolbar (recommended)

One line:

```tsx
// app/layout.tsx
import { Toolbar } from "wildwood"nextjs/kit";
import { wildwood } from "@/lib/wildwood";

export default async function Layout({ children }) {
  const nav = await wildwood.nav.findMany({ with: { children: true } });
  // ...
  return (
    <html>
      <body>
        {children}
        <Toolbar wildwood={tr33} apiBase="/api" />
      </body>
    </html>
  );
}
```

- `tr33` — any `createClient` instance (`WildwoodKitHostClient = WildwoodForActiveRef`, structural). Only `_.config.ref` is read for default display.
- `apiBase` — defaults to `/api`. Mount point for the H3 handler's `/api` boundary (where `/git/*` etc live).
- `activeRef` — optional. When omitted (common case), `WildwoodKit` Server Component calls `getBranch(wildwood)` which awaits `next/headers` → `cookies()` internally and falls back to `config.ref`. Passing `activeRef` still works for custom cookie names or tests.
- `theme` — `"light" | "dark" | "system"` (default `system`). Follows `prefers-color-scheme` via `ThemeProvider`'s `matchMedia("(prefers-color-scheme: dark)")` listener. Syncs `colorScheme`, `data-kit-theme`, shadow host class, and `disableTransitionOnChange` temporarily while flipping. Pass `theme="light"` only if your docs are locked light.
- `auth` — **optional**. When omitted, Server Component derives it from `process.env.GITHUB_APP_SLUG` + `GITHUB_APP_NAME`. Those are public bits (install link / manifest UI only — never signing material). `GITHUB_APP_ID` + `GITHUB_PRIVATE_KEY` stay in `createClient({ auth: { github } })`. `auth` override controls `name`, `origin`, `enabled`, OAuth/session. Auth merging is shallow + `githubApp` merge.
- `cookieName` — override cookie name forwarded to `getBranch` when `activeRef` is auto-resolved.
- `vscodeCommit` — pin VS Code web commit SHA. When omitted, `WildwoodKit` Server Component calls `resolveVscodeWebCdn()` to fetch the pinned commit (cacheable). You only need this for air-gapped builds.
- `fallback` — optional fallback node while Next suspense holds the parent stream. Ignored once Kit hydration starts; default is a 3rem circular placeholder border (`#e4e4e7` / `#fafafa`).

Minimal `(no cookies() call in the host)` is the whole point:

```ts
<Toolbar wildwood={tr33} />
```

(plus no manual `activeRef` because that prop is now optional; `apiBase` defaults too.)

### Why Toolbar is self-sufficient

`WildwoodKit` is async Server Component. In its guts:

```ts
async function WildwoodKit({ tr33, apiBase, theme, auth: authProp, activeRef: activeRefProp, cookieName, vscodeCommit }) {
  const shouldAutoResolve = activeRefProp == null;
  const [commit, resolvedRef] = await Promise.all([
    vscodeCommit ? commit : resolveVscodeWebCdn().then(c=>c.commit),
    shouldAutoResolve ? getBranch(tr33, cookieName ? { cookieName } : undefined)
                      : Promise.resolve(activeRefProp as string),
  ]);
  const activeRef = resolvedRef ?? wildwood._.config.ref;
  const envAuth = resolveKitAuthFromEnv();
  const auth = mergeKitAuth(envAuth, authProp);
  return <ClientKitBoundary apiBase={apiBase} configRef={config.ref} activeRef={activeRef} vscodeCommit={commit} theme={theme} auth={auth} />;
}
```

`ClientKitBoundary` is `'use client'` and does `dynamic(()=>import("@wildwood/kit"), { ssr:false })` internally. So no portalled DOM touches RSC SSR.

## WildwoodKit (lower-level)

`Toolbar` is just `WildwoodKit`:

```ts
export function Toolbar({ fallback: _, ...kitProps }: ToolbarProps) {
  return <WildwoodKit {...kitProps} />;
}
```

Use `WildwoodKit` directly when you need to pass `fallback` or customize the server pointer boundaries.

## ThemeProvider

Kit's theme system lives in `packages/kit/src/components/theme-provider.tsx`. `ResolvedTheme = "dark"|"light"`, `Theme = ResolvedTheme | "system"`.

- `getSystemTheme()` — `window.matchMedia("(prefers-color-scheme: dark)").matches`.
- `disableTransitionsTemporarily` — injects a `<style>` into `head` or shadow root with `transition:none !important` for one frame to avoid flash on flip, double `requestAnimationFrame` cleanup.
- `syncThemeDom(resolved, root, shadowHost, disableTransitionOnChange)` — toggles `.dark` class on the shadow container (or `document.documentElement`) and sets `colorScheme` / `data-kit-theme` on host or `documentElement`.
- System listener: `matchMedia(...).addEventListener("change", sync)` updates `systemResolved`.
- Context: `{ theme, resolvedTheme }` via `ThemeProviderContext`. `useTheme()` throws if outside.

Your app's `html` should also have `suppressHydrationWarning` when color-scheme is driven by CSS media queries (system-default docs does this) to avoid hydration mismatch when the UA dark flips before React hydration.

## Branch sync across frames

Kit, the extension host (if running VS Code extension in desktop), and the docs page need to stay in sync when a branch changes:

- `wildwood-shared` constants:

```ts
WILDWOOD_KIT_HOST_REF_CHANNEL = "tr33-kit-host-ref"                    // Kit page → host
WILDWOOD_EXTENSION_TO_HOST_REF_CHANNEL = "tr33-extension-to-host"       // extension → Kit page
WILDWOOD_EXTENSION_WORKSPACE_CHANGED_CHANNEL = "tr33-extension-workspace-changed"
WILDWOOD_KIT_CLOSE_MESSAGE = "tr33-kit-close-editor"
WILDWOOD_KIT_BRANCH_CHANGED_MESSAGE = "tr33-kit-branch-changed"
WILDWOOD_KIT_WORKSPACE_CHANGED_MESSAGE = "tr33-kit-workspace-changed"
```

Kit posts/ref changes via `BroadcastChannel(WILDWOOD_KIT_HOST_REF_CHANNEL)` and listens on the extension-bound channels. `persistActiveRefToStorage(displayRef)` mirrors the display ref into `localStorage` under `WILDWOOD_ACTIVE_REF_STORAGE_KEY` (`wildwood.activeRef`) for the embedded editor `MessageEvent` validation (guard: origin, iframe root check, is not `MessagePort`/`ServiceWorker`).

Extension's `kit-parent` iframe root message validation: `messageOriginatedInVsCodeIframe(iframeRoot, source)` — avoids ambient postMessage hijacks.

## Editor open sequence

When the editor overlay is opened (FAB or command):

1. `setState({ kind:"checking" })`, reset guards.
2. If `displayRef === configRef` (switching from main), in parallel: create draft branch `generateBranchName()` via `POST /api/git/create-branch { name, baseRef: configRef }` (returns `name`; caller appends to `branches` sorted) and `GET /api/git/editor-guards`. Persists new ref via `localStorage`, notifies extension, `scheduleRefresh()` (coalesced `router.refresh()` inside `startTransition` delayed 800ms to avoid Set-Cookie race on RSC refresh).
3. Otherwise `GET /api/git/editor-guards` alone.
4. Guard JSON → `EditorGuardResponse`. Handles `not_configured` / `not_installed` / `error` states (renders repo, installUrl, hint). When ready, `guards.vscodeCommit ?? vscodeCommit` yields `commit`. Requires `commit` (error when both absent) + `gitOrigin` (window origin; error outside browser).
5. `editorIframeSrc(origin, base, commit)` → `{origin}{base}/vscode/editor/{commit}` (via `normalizeApiBase(apiBase)` trimming/trailing slash normalization prepending `/` if missing).
6. Set iframe `src`, state `ready`, mount hidden `iframeRef`. `iframeSrcRef` persists across re-render.
7. Async verify: `GET /api/git/editor-bootstrap` (indexed verify). `EntryCount` may drive empty-tree notice.
8. iFrame loaded flag set via onLoad.

Errors render as pinned banner above FAB/overlay. Guard/run id monotonic via `editorOpenRunRef`.

## FAB menu

`KitFabMenu` in `@wildwood/kit` provides the floating action button and menu:

- Auth panel (`KitAuthPanel`) — `KitAuthConfig`, GitHub OAuth state, GitHub App install links.
- FAB: branch display (`activeRef ?? configRef`), switch branch UI, branch name generator (`generateBranchName()` from shared: picks a random city (`BRANCH_CITIES`) + 4-char base36 suffix).
- Menu groups via shadcn `DropdownMenu` subcomponents (`DropdownMenu`, `DropdownMenuItem`, etc). Portal via `createPortal` into shadow host container (`useShadowContainer` from `lib/shadow-root`).
- Auth affordance (no-throw): `authEnabled(auth)` returns `true` even when `githubApp` is not configured so the Kit can keep showing a “Set up GitHub App” entrypoint. Editing is visually disabled with an inline hint (`setupHintLabel`). Missing GitHub App in prod is a `console.warn`, not a throw — the content page must remain usable. The host can still gate write API routes server‑side if desired. Client Kit never enforces `enforceInProduction` by throwing.
- Error isolation: `Kit` and `Toolbar` are wrapped in React error boundaries (`KitErrorBoundary`, `WildwoodToolbarBoundary`) so any render or chunk‑load failure in the floating editor surface renders a fixed‑position fallback or hides itself, and never unmounts the page content.

## Auth shape

```ts
export type KitAuthConfig = {
  enabled?: boolean;
  /**
   * @deprecated Client Kit never throws when this is missing — it shows a
   * setup entrypoint. Keep only for server-side gating of write APIs.
   */
  enforceInProduction?: boolean;
  userEmail?: string;
  githubOAuthEnabled?: boolean;
  githubApp?: { appSlug?: string; name?: string; origin?: string; configured?: boolean };
};
```

Derived from env in server wrapper; never signs requests. Private signing credentials live exclusively in `createClient({ auth: { github } })` server-side. `Toolbar` `auth` prop overrides allow custom `name`/`origin` when you run many deployments under same app.

## VS Code web surface

`resolveVscodeWebCdn()` (in `tr33/nextjs/vscode-web-cdn`) returns `{ commit, url }`. `vscode-embed-csp.ts` defines `gitObjectCacheHeaders()` (cacheable `text/html` Content-Type on editor shell responses) and `vscodeEmbedCorsHeaders`/`withVscodeEmbedCors` wrappers. `/api/vscode/cdn/...` is the mount for the VS Code web shell binary/static — `vscodeRouter` proxies to remote hosting. The editor reads `content/` by hitting `/api/git/editor-bootstrap` then the FS provider calls back to `/api/git/commit` patch/tree path.

## Dark mode

Kit has its own theme sync inside the shadow DOM (host element's `.dark` class). Your docs app's overall `html` dark class / `color-scheme` comes from your app, not Kit — but Kit will match because its shadow host adopts `resolvedTheme`. The docs app here is `system` by default (no toggle), `suppressHydrationWarning` on `<html>`.

Next: [Deploy](./deploy.md) for Vercel/Turso/GitHub App manifest, [Guides](./guides.md) for the full walkthrough used in this repo.
