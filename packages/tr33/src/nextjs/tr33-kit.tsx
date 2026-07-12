/**
 * Server component wrappers around the client `@tr33/kit` editor surface.
 *
 * Owns cookie resolution — hosts can simply do:
 *
 *   import { Toolbar } from "tr33/nextjs/kit";
 *   <Toolbar tr33={tr33} />
 *
 * No `cookies()` needed in the host.
 *
 * Architecture:
 * - This file is a Server Component (async, uses `next/headers` via `getBranch`).
 * - It resolves branch + VS Code commit on the server, then renders
 *   `<ClientKitBoundary />` which is `'use client'` + `dynamic(...,{ssr:false})`.
 *   The Kit's shadow DOM / `useRef` / `createPortal` therefore never runs during SSG,
 *   fixing the pre-existing `Cannot read useRef of null` crash.
 */

import type { KitAuthConfig, Theme } from "@tr33/kit";
import { type ReactNode } from "react";
import type { Tr33ForActiveRef } from "./resolve-active-ref";
import { getBranch } from "./branch";
import { resolveVscodeWebCdn } from "./vscode-web-cdn";
// Keep client-boundary as a static import so tsdown can emit a proper chunk.
// `ClientKitBoundary` itself does `dynamic(..., { ssr:false })` internally.
import { ClientKitBoundary } from "./client-boundary";

/** Any `createClient()` instance satisfies this umbrella shape. */
export type Tr33KitHostClient = Tr33ForActiveRef;

function resolveKitAuthFromEnv(): KitAuthConfig | undefined {
  const appSlug = process.env.GITHUB_APP_SLUG?.trim();
  if (!appSlug) return undefined;
  return {
    githubApp: {
      appSlug,
      // Host can override `name` via `auth` prop; keep a sensible default here
      // so most hosts don't need to pass `auth` at all.
      name: process.env.GITHUB_APP_NAME?.trim() || "Tr33",
      origin: process.env.NEXT_PUBLIC_ORIGIN?.trim() || undefined,
    },
  };
}

function mergeKitAuth(
  base: KitAuthConfig | undefined,
  override: KitAuthConfig | undefined,
): KitAuthConfig | undefined {
  if (!base && !override) return undefined;
  if (!base) return override;
  if (!override) return base;
  return {
    ...base,
    ...override,
    githubApp:
      base.githubApp || override.githubApp
        ? { ...base.githubApp, ...override.githubApp }
        : undefined,
  };
}

export type Tr33KitProps = {
  /** Tr33 client (only `_.config.ref` is read here for default display). */
  tr33: Tr33KitHostClient;
  /** Mount point for Tr33's H3 API (defaults to /api). */
  apiBase?: string;
  theme?: Theme;
  /**
   * Kit UI auth — **optional**. When omitted, `Tr33Kit` (a Server Component)
   * derives it from `process.env.GITHUB_APP_SLUG` + `GITHUB_APP_NAME`. Those
   * are the *public* bits (used only for install link / manifest UI in the browser,
   * never for signing API requests). The *private* bits (`GITHUB_APP_ID`,
   * `GITHUB_PRIVATE_KEY`) stay in `createClient({ auth: { github, … } })` and never
   * leave the server.
   *
   * Pass `auth` only when you need to override `name`, `origin`, `enabled`, or
   * when providing session/OAuth fields for custom setups (Playground).
   */
  auth?: KitAuthConfig;
  /**
   * Active git ref. When omitted, resolved automatically from cookies via
   * `getBranch(tr33)` (`await cookies()` internally). Passing it explicitly
   * still works — useful for custom cookie names or testing.
   */
  activeRef?: string | null;
  /** Cookie name override forwarded to `getBranch` when `activeRef` is auto-resolved. */
  cookieName?: string;
  /** VS Code web commit SHA override — when omitted, fetched via `resolveVscodeWebCdn()`. */
  vscodeCommit?: string;
};

export type ToolbarProps = Tr33KitProps & {
  /** Rendered while Next suspense-holds the parent stream — ignored once Kit hydration starts. */
  fallback?: ReactNode;
};

export type { KitAuthConfig };

export async function Tr33Kit({
  tr33,
  apiBase,
  theme,
  auth: authProp,
  activeRef: activeRefProp,
  cookieName,
  vscodeCommit,
}: Tr33KitProps) {
  const shouldAutoResolve = activeRefProp == null;
  const [commit, resolvedRef] = await Promise.all([
    vscodeCommit ? Promise.resolve(vscodeCommit) : resolveVscodeWebCdn().then((c) => c.commit),
    shouldAutoResolve
      ? getBranch(tr33, cookieName ? { cookieName } : undefined)
      : Promise.resolve(activeRefProp as string),
  ]);

  const activeRef = resolvedRef ?? tr33._.config.ref;
  // Server-derived default so `<Toolbar tr33={tr33} />` is enough in most hosts.
  // App-supplied `auth` wins (shallow + githubApp merge).
  const envAuth = resolveKitAuthFromEnv();
  const auth = mergeKitAuth(envAuth, authProp);

  return (
    <ClientKitBoundary
      apiBase={apiBase}
      configRef={tr33._.config.ref}
      activeRef={activeRef}
      vscodeCommit={commit}
      theme={theme}
      auth={auth}
    />
  );
}

const defaultToolbarFallback = (
  <div
    aria-hidden
    style={{
      height: "3rem",
      width: "3rem",
      borderRadius: "9999px",
      border: "1px solid #e4e4e7",
      background: "#fafafa",
    }}
  />
);

// Self-sufficient — the host no longer needs to call `cookies()` / `resolveBranch`.
// `activeRef` is optional and auto-resolved from cookies when omitted.
export function Toolbar({ fallback: _fallback = defaultToolbarFallback, ...kitProps }: ToolbarProps) {
  return <Tr33Kit {...kitProps} />;
}
