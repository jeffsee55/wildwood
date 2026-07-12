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
import { resolveOrigin } from "@/env";
import { getBranch } from "./branch";
import { resolveVscodeWebCdn } from "./vscode-web-cdn";
// Keep client-boundary as a static import so tsdown can emit a proper chunk.
// `ClientKitBoundary` itself does `dynamic(..., { ssr:false })` internally.
import { ClientKitBoundary } from "./client-boundary";

/** Any `createClient()` instance satisfies this umbrella shape. */
export type WildwoodKitHostClient = WildwoodForActiveRef;

function resolveKitAuthFromEnv(): KitAuthConfig | undefined {
  // Vercel-first origin: covers NEXT_PUBLIC_ORIGIN > VERCEL_PROJECT_PRODUCTION_URL > VERCEL_BRANCH_URL > VERCEL_URL
  const vercelOrigin = resolveOrigin();

  const appSlug = process.env.GITHUB_APP_SLUG?.trim();
  const appId = process.env.GITHUB_APP_ID?.trim();
  const privateKey = process.env.GITHUB_PRIVATE_KEY?.trim();
  const configured = !!(appId && privateKey);

  if (!appSlug && !configured) {
    return {
      githubApp: {
        configured: false as const,
        name: process.env.GITHUB_APP_NAME?.trim() || "Wildwood",
        origin: vercelOrigin,
      },
    };
  }

  return {
    githubApp: {
      appSlug,
      configured: configured || !!appSlug,
      name: process.env.GITHUB_APP_NAME?.trim() || "Wildwood",
      origin: vercelOrigin,
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
  const mergedGitHubApp =
    base.githubApp || override.githubApp
      ? {
          ...base.githubApp,
          ...override.githubApp,
          // If override has explicit configured, keep it, but server truth wins when present in base
          configured:
            (override.githubApp?.configured as boolean | undefined) ??
            (base.githubApp?.configured as boolean | undefined),
        }
      : undefined;
  return {
    ...base,
    ...override,
    githubApp: mergedGitHubApp,
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

  async function safeVscodeCommit(): Promise<string> {
    if (vscodeCommit) return vscodeCommit;
    // During static prerender / build, network may be throttled or blocked.
    // Don't let VS Code CDN fetch crash /_not-found.
    if (process.env.NEXT_PHASE === "phase-production-build") {
      return process.env.WILDWOOD_VSCODE_WEB_COMMIT?.trim() || "8a1aaed389a7bc6a8f2d9dbc2b34635633cf8ff2";
    }
    try {
      const cdn = await resolveVscodeWebCdn();
      return cdn.commit;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[wildwood:kit] resolveVscodeWebCdn failed, using fallback: ${msg.slice(0, 400)}`);
      return process.env.WILDWOOD_VSCODE_WEB_COMMIT?.trim() || "8a1aaed389a7bc6a8f2d9dbc2b34635633cf8ff2";
    }
  }

  async function safeBranch(): Promise<string> {
    if (activeRefProp != null) return activeRefProp as string;
    try {
      return await getBranch(wildwood, cookieName ? { cookieName } : undefined);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (process.env.NEXT_PHASE === "phase-production-build") {
        console.warn(`[wildwood:kit] getBranch failed during build, falling back to config ref: ${msg.slice(0, 400)}`);
        return wildwood._.config.ref;
      }
      throw e;
    }
  }

  const [commit, resolvedRef] = await Promise.all([safeVscodeCommit(), safeBranch()]);

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
