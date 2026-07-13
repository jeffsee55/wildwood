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

function trimStr(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t : undefined;
}

export type WildwoodKitHostClient = {
  _?:
    | {
        config?:
          | {
              org?: string | undefined;
              repo?: string | undefined;
              ref?: string | undefined;
            }
          | undefined;
      }
    | undefined;
} & WildwoodForActiveRef;

function envTrim(name: string): string | undefined {
  return trimStr(process.env[name]);
}

// Accepts `process.env.X` directly — internal trim everywhere, no caller `.trim()` needed.
function resolveKitAuthFromEnv(
  wildwood?: WildwoodKitHostClient | null | undefined,
): KitAuthConfig | undefined {
  const vercelOrigin = resolveOrigin();

  const appSlug = envTrim("GITHUB_APP_SLUG");
  const appId = envTrim("GITHUB_APP_ID");
  const privateKey = envTrim("GITHUB_PRIVATE_KEY");
  const clientId = envTrim("GITHUB_CLIENT_ID");
  const clientSecret = envTrim("GITHUB_CLIENT_SECRET");
  const appName = envTrim("GITHUB_APP_NAME");

  const configured = !!(appId && privateKey);
  const oAuthReady = !!(clientId && clientSecret);
  const providesOAuth = true as const;

  let org: string | undefined;
  let repo: string | undefined;
  try {
    org = trimStr(wildwood?._?.config?.org);
    repo = trimStr(wildwood?._?.config?.repo);
  } catch {}
  org = org || envTrim("GITHUB_ORG");
  repo = repo || envTrim("GITHUB_REPO");
  const repoFull = org && repo ? `${org}/${repo}` : undefined;
  const directRepoInstallUrl = repoFull
    ? `https://github.com/${repoFull}/settings/installs`
    : undefined;

  if (!appSlug && !configured && !oAuthReady) {
    return {
      githubApp: {
        configured: false as const,
        name: appName || "Wildwood",
        origin: vercelOrigin,
        providesOAuth,
        // Still pass repo hints so setup UI can show repo-scoped CTAs even before App exists.
        ...(repoFull ? { repoFull } : {}),
        ...(org ? { org } : {}),
        ...(repo ? { repo } : {}),
        ...(directRepoInstallUrl ? { directRepoInstallUrl } : {}),
      } as KitAuthConfig["githubApp"] & {
        repoFull?: string;
        org?: string;
        repo?: string;
        directRepoInstallUrl?: string;
      },
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
      name: appName || "Wildwood",
      origin: vercelOrigin,
      providesOAuth,
      ...(repoFull ? { repoFull } : {}),
      ...(org ? { org } : {}),
      ...(repo ? { repo } : {}),
      ...(directRepoInstallUrl ? { directRepoInstallUrl } : {}),
    } as KitAuthConfig["githubApp"] & {
      repoFull?: string;
      org?: string;
      repo?: string;
      directRepoInstallUrl?: string;
    },
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

const FALLBACK_VSCODE_COMMIT = "8a1aaed389a7bc6a8f2d9dbc2b34635633cf8ff2";

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
  const wildwood = (wildwoodProp ?? tr33Prop) as WildwoodKitHostClient;

  async function safeVscodeCommit(): Promise<string> {
    if (typeof vscodeCommit === "string" && vscodeCommit.trim()) return vscodeCommit.trim();
    if (isNextBuildPhase()) {
      return envTrim("WILDWOOD_VSCODE_WEB_COMMIT") || FALLBACK_VSCODE_COMMIT;
    }
    try {
      const cdn = await resolveVscodeWebCdn();
      return cdn.commit?.trim() || FALLBACK_VSCODE_COMMIT;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(
        `[wildwood:kit] resolveVscodeWebCdn failed, using fallback: ${msg.slice(0, 400)}`,
      );
      return envTrim("WILDWOOD_VSCODE_WEB_COMMIT") || FALLBACK_VSCODE_COMMIT;
    }
  }

  async function safeBranch(): Promise<string> {
    const trimmedProp = trimStr(activeRefProp);
    if (trimmedProp) return trimmedProp;
    const fallbackRef = trimStr(wildwood?._?.config?.ref) || "main";
    try {
      return await getBranch(wildwood, cookieName ? { cookieName } : undefined);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (isNextBuildPhase()) {
        console.warn(
          `[wildwood:kit] getBranch failed during build, falling back to config ref: ${msg.slice(0, 400)}`,
        );
        return fallbackRef;
      }
      throw e;
    }
  }

  const [commit, resolvedRef] = await Promise.all([safeVscodeCommit(), safeBranch()]);

  const cfgRef = trimStr(wildwood?._?.config?.ref) || "main";
  const activeRef = trimStr(resolvedRef) || cfgRef;

  // Server-derived default so `<Toolbar wildwood={wildwood} />` is enough in most hosts.
  // App-supplied `auth` wins (shallow + githubApp merge). Pass wildwood directly — no cast needed.
  const envAuth = resolveKitAuthFromEnv(wildwood);
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
//
// `Toolbar` must be typed as returning `ReactNode` (not `Promise`) even though it wraps
// the async `WildwoodKit` — Next.js runtime supports async server components in JSX,
// but tsc doesn't without a cast. We hide that cast internally; callers get proper inference.
export function Toolbar(props: ToolbarProps): ReactNode {
  // Next.js allows async server component in JSX position; tsc needs help.
  return WildwoodKit(props) as unknown as ReactNode;
}
