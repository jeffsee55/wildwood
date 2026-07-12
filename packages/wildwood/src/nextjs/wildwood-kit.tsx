/**
 * Server component wrappers around the client `wildwood-kit` editor surface.
 *
 * Owns cookie resolution — hosts can simply do:
 *
 *   import { Toolbar } from "wildwood/nextjs/kit";
 *   <Toolbar wildwood={wildwood} />
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

import type { KitAuthConfig, Theme } from "wildwood-kit";
import { type ReactNode } from "react";
import type { WildwoodForActiveRef } from "./resolve-active-ref";
import { getBranch } from "./branch";
import { resolveVscodeWebCdn } from "./vscode-web-cdn";
// Keep client-boundary as a static import so tsdown can emit a proper chunk.
// `ClientKitBoundary` itself does `dynamic(..., { ssr:false })` internally.
import { ClientKitBoundary } from "./client-boundary";

/** Any `createClient()` instance satisfies this umbrella shape. */
export type WildwoodKitHostClient = WildwoodForActiveRef;

function resolveKitAuthFromEnv(): KitAuthConfig | undefined {
  const appSlug = process.env.GITHUB_APP_SLUG?.trim();
  if (!appSlug) return undefined;
  return {
    githubApp: {
      appSlug,
      // Host can override `name` via `auth` prop; keep a sensible default here
      // so most hosts don't need to pass `auth` at all.
      name: process.env.GITHUB_APP_NAME?.trim() || "Wildwood",
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

export type WildwoodKitProps = {
  /** Wildwood client (only `_.config.ref` is read here for default display). */
  wildwood: WildwoodKitHostClient;
  /** @deprecated use `wildwood` */
  tr33?: WildwoodKitHostClient;
  /** Mount point for Wildwood's H3 API (defaults to /api). */
  apiBase?: string;
  theme?: Theme;
  /**
   * Kit UI auth — **optional**. When omitted, `WildwoodKit` (a Server Component)
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
   * `getBranch(wildwood)` (`await cookies()` internally). Passing it explicitly
   * still works — useful for custom cookie names or testing.
   */
  activeRef?: string | null;
  /** Cookie name override forwarded to `getBranch` when `activeRef` is auto-resolved. */
  cookieName?: string;
  /** VS Code web commit SHA override — when omitted, fetched via `resolveVscodeWebCdn()`. */
  vscodeCommit?: string;
};

export type ToolbarProps = WildwoodKitProps & {
  /** Rendered while Next suspense-holds the parent stream — ignored once Kit hydration starts. */
  fallback?: ReactNode;
};

export type { KitAuthConfig };

export async function WildwoodKit({
  wildwood: wildwoodProp,
  tr33: tr33Prop,
  apiBase,
  theme,
  auth: authProp,
  activeRef: activeRefProp,
  cookieName,
  vscodeCommit,
}: WildwoodKitProps) {
  const wildwood = wildwoodProp ?? tr33Prop!;
  const shouldAutoResolve = activeRefProp == null;
  const [commit, resolvedRef] = await Promise.all([
    vscodeCommit ? Promise.resolve(vscodeCommit) : resolveVscodeWebCdn().then((c) => c.commit),
    shouldAutoResolve
      ? getBranch(wildwood, cookieName ? { cookieName } : undefined)
      : Promise.resolve(activeRefProp as string),
  ]);

  const activeRef = resolvedRef ?? wildwood._.config.ref;
  // Server-derived default so `<Toolbar wildwood={wildwood} />` is enough in most hosts.
  // App-supplied `auth` wins (shallow + githubApp merge).
  const envAuth = resolveKitAuthFromEnv();
  const auth = mergeKitAuth(envAuth, authProp);

  return (
    <ClientKitBoundary
      apiBase={apiBase}
      configRef={wildwood._.config.ref}
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
  return <WildwoodKit {...kitProps} />;
}
