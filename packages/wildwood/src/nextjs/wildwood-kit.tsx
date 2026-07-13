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
import { isNextBuildPhase } from "@/runtime";
import { getBranch } from "./branch";
import { resolveVscodeWebCdn } from "./vscode-web-cdn";
// Keep client-boundary as a static import so tsdown can emit a proper chunk.
// `ClientKitBoundary` itself does `dynamic(..., { ssr:false })` internally.
import { ClientKitBoundary } from "./client-boundary";

/** Any `createClient()` instance satisfies this umbrella shape. */
export type WildwoodKitHostClient = WildwoodForActiveRef & {
  _?: { config?: { org?: string | undefined; repo?: string | undefined; ref?: string | undefined } | undefined } | undefined;
};

function resolveKitAuthFromEnv(wildwood?: WildwoodKitHostClient | null | undefined): KitAuthConfig | undefined {
  // Vercel-first origin: covers NEXT_PUBLIC_ORIGIN > VERCEL_PROJECT_PRODUCTION_URL > VERCEL_BRANCH_URL > VERCEL_URL
  const vercelOrigin = resolveOrigin();

  const appSlug = process.env.GITHUB_APP_SLUG?.trim();
  const appId = process.env.GITHUB_APP_ID?.trim();
  const privateKey = process.env.GITHUB_PRIVATE_KEY?.trim();
  const clientId = process.env.GITHUB_CLIENT_ID?.trim();
  const clientSecret = process.env.GITHUB_CLIENT_SECRET?.trim();

  const configured = !!(appId && privateKey);
  // A GitHub App's own client_id/client_secret *are* the OAuth credentials.
  // We don't need a second OAuth App — one set does both git writes and sign-in.
  const oAuthReady = !!(clientId && clientSecret);
  // Even if oAuth env hasn't propagated yet (just created via manifest),
  // the App itself implies OAuth capability. The UI should say "via App"
  // and prompt redeploy if needed, rather than "set GitHub OAuth env vars".
  const providesOAuth = true as const;

  // Best-effort org/repo for repo-scoped install links — avoids generic /installations/new
  // that forces user to hunt through all repos. We prefer wildwood client's git config
  // (defineConfig org/repo or env-inferred), which is always correct for the current site.
  let org: string | undefined;
  let repo: string | undefined;
  try {
    // wildwood._.config is public in host; safe to read even during build — never throws.
    org = wildwood?._?.config?.org?.trim();
    repo = wildwood?._?.config?.repo?.trim();
  } catch {}
  // Only canonical envs per cleanup: org/repo come from Vercel system envs or defineConfig.
  // No WILDWOOD_GITHUB_* cascade — config already resolved them.
  // Fallback to GITHUB_ORG/REPO only if user explicitly mapped (rare).
  org = org || process.env.GITHUB_ORG?.trim();
  repo = repo || process.env.GITHUB_REPO?.trim();
  const repoFull = org && repo ? `${org}/${repo}` : undefined;
  const directRepoInstallUrl = repoFull ? `https://github.com/${repoFull}/settings/installs` : undefined;

  if (!appSlug && !configured && !oAuthReady) {
    return {
      githubApp: {
        configured: false as const,
        name: process.env.GITHUB_APP_NAME?.trim() || "Wildwood",
        origin: vercelOrigin,
        providesOAuth,
        // Still pass repo hints so setup UI can show repo-scoped CTAs even before App exists.
        ...(repoFull ? { repoFull } : {}),
        ...(org ? { org } : {}),
        ...(repo ? { repo } : {}),
        ...(directRepoInstallUrl ? { directRepoInstallUrl } : {}),
      } as KitAuthConfig["githubApp"] & { repoFull?: string; org?: string; repo?: string; directRepoInstallUrl?: string },
      // Keep back-compat flag false — new `oauth.providers` below is the real source.
      githubOAuthEnabled: false,
      oauth: {
        providers: [{ id: "github", name: "GitHub", viaGitHubApp: false, enabled: false }],
      },
    } as KitAuthConfig;
  }

  const appPresent = !!(appSlug || configured);
  const githubEnabled = configured || oAuthReady || !!appSlug;

  return {
    githubApp: {
      appSlug,
      configured: configured || !!appSlug,
      name: process.env.GITHUB_APP_NAME?.trim() || "Wildwood",
      origin: vercelOrigin,
      providesOAuth,
      ...(repoFull ? { repoFull } : {}),
      ...(org ? { org } : {}),
      ...(repo ? { repo } : {}),
      ...(directRepoInstallUrl ? { directRepoInstallUrl } : {}),
    } as KitAuthConfig["githubApp"] & { repoFull?: string; org?: string; repo?: string; directRepoInstallUrl?: string },
    githubOAuthEnabled: githubEnabled,
    oauth: {
      providers: [
        {
          id: "github" as const,
          name: "GitHub",
          // Single credential set happy path: the App doubles as the OAuth app.
          viaGitHubApp: appPresent ? true : undefined,
          enabled: githubEnabled,
        },
      ],
    },
  } as KitAuthConfig;
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
          configured:
            (override.githubApp?.configured as boolean | undefined) ??
            (base.githubApp?.configured as boolean | undefined),
          providesOAuth:
            (override.githubApp?.providesOAuth as boolean | undefined) ??
            (base.githubApp?.providesOAuth as boolean | undefined) ??
            true,
        }
      : undefined;

  // Merge OAuth providers: override list wins if provided, else keep base.
  // Otherwise keep new pluggable shape while still honoring legacy githubOAuthEnabled.
  const mergedOAuth =
    override.oauth || base.oauth
      ? {
          providers:
            override.oauth?.providers ??
            base.oauth?.providers ??
            (base.githubOAuthEnabled || override.githubOAuthEnabled
              ? [{ id: "github" as const, name: "GitHub", enabled: true }]
              : undefined),
        }
      : undefined;

  return {
    ...base,
    ...override,
    githubApp: mergedGitHubApp,
    oauth: mergedOAuth,
    githubOAuthEnabled:
      (override.githubOAuthEnabled as boolean | undefined) ??
      (base.githubOAuthEnabled as boolean | undefined),
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
    if (isNextBuildPhase()) {
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
    const fallbackRef =
      (wildwood as { _?: { config?: { ref?: string | undefined } | undefined } | undefined })?._?.config?.ref?.trim() ||
      "main";
    try {
      return await getBranch(wildwood, cookieName ? { cookieName } : undefined);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (isNextBuildPhase()) {
        console.warn(`[wildwood:kit] getBranch failed during build, falling back to config ref: ${msg.slice(0, 400)}`);
        return fallbackRef;
      }
      throw e;
    }
  }

  const [commit, resolvedRef] = await Promise.all([safeVscodeCommit(), safeBranch()]);

  const cfgRef =
    (wildwood as { _?: { config?: { ref?: string | undefined } | undefined } | undefined })?._?.config?.ref?.trim() ||
    "main";
  const activeRef = (resolvedRef?.trim() || cfgRef) as string;
  // Server-derived default so `<Toolbar wildwood={wildwood} />` is enough in most hosts.
  // App-supplied `auth` wins (shallow + githubApp merge). Pass wildwood so we can read org/repo
  // for repo-scoped install links (avoids generic picker UX).
  const envAuth = resolveKitAuthFromEnv(wildwood as WildwoodKitHostClient);
  const auth = mergeKitAuth(envAuth, authProp);

  return (
    <ClientKitBoundary
      apiBase={apiBase}
      configRef={cfgRef}
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
// Note: `WildwoodKit` returns `Promise<Element>` — `Toolbar` is a sync wrapper so it
// can be used as `JSX` without requiring `async` boundary at callsite.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function Toolbar(props: ToolbarProps): any {
  // Cast via `any` to allow async server component `WildwoodKit` in JSX position
  // without tsc complaining `Promise<Element>` is not valid JSX element type.
  // Next.js runtime supports it.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (WildwoodKit as any)(props) as any;
}
