'use client'

import * as React from "react";
import {
  ThemeProvider,
  type ResolvedTheme,
  type Theme,
} from "@/components/theme-provider";
import { KitFabMenu } from "@/components/kit-fab-menu";
import type { KitAuthConfig } from "@/components/kit-auth-panel";
import { Toaster } from "@/components/ui/sonner";
import sonnerCss from "sonner/dist/styles.css?inline";
import css from "../index.css?inline";
import { ShadowRoot } from "./shadow-root";

const allCss = css + "\n" + sonnerCss;

export type { ResolvedTheme, Theme }
export type { KitAuthConfig };

export type KitProps = {
  /**
   * Visual theme for Kit UI. Defaults to `"system"` (`prefers-color-scheme`).
   * Kit does not persist or toggle theme internally; the host app controls this prop.
   */
  theme?: Theme;
  /**
   * Where the host app mounts Wildwood’s `handle()` API (Next catch‑all under `/api/...`).
   * The VS Code web editor loads from `{apiBase}/vscode/editor` on the current origin.
   * @default "/api"
   */
  apiBase?: string;
  /**
   * Default git ref label from host config when no `wildwood-active-ref` cookie exists.
   */
  configRef?: string;
  /**
   * Pinned VS Code web commit from the server (see {@link WildwoodKit}).
   */
  vscodeCommit?: string;
  activeRef?: string | null;
  /**
   * Auth affordance — optional. Missing `githubApp.appSlug` is normal on first deploy:
   * the Kit will render a "Set up GitHub App" entrypoint inline and disable editing
   * affordances until configured. This never throws.
   */
  auth?: KitAuthConfig;
};

class KitErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Must never crash host page. Log for diagnostics, surface inline fallback.
    console.error("[wildwood:kit] rendering failed (isolated):", error, info.componentStack?.slice(0, 2000));
  }
  render() {
    if (this.state.error) {
      const e = this.state.error;
      return (
        <div
          data-kit-error-boundary="true"
          role="status"
          aria-live="polite"
          style={{
            position: "fixed",
            right: 24,
            bottom: 24,
            zIndex: 2147483646,
            maxWidth: "min(92vw,22rem)",
            padding: "10px 12px",
            borderRadius: 10,
            border: "1px solid rgba(0,0,0,0.12)",
            background: "color-mix(in srgb, Canvas 92%, red 8%)",
            color: "CanvasText",
            fontSize: 12,
            lineHeight: "1.5",
            boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
          }}
        >
          <div style={{ fontWeight: 600 }}>Wildwood editor unavailable</div>
          <div style={{ opacity: 0.85, marginTop: 4, wordBreak: "break-word" }}>{e.message.slice(0, 600)}</div>
          <div style={{ opacity: 0.7, marginTop: 6, fontSize: 11 }}>
            The page content is unaffected. Check env: <code>GITHUB_APP_SLUG</code>, <code>GITHUB_APP_ID</code>, <code>GITHUB_PRIVATE_KEY</code>. Docs: <code>/docs/kit#github-app</code>
          </div>
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            style={{
              marginTop: 8,
              padding: "4px 8px",
              borderRadius: 8,
              border: "1px solid currentColor",
              background: "transparent",
              fontSize: 11,
              cursor: "pointer",
            }}
          >
            Dismiss
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export const Kit = ({
  theme = "system",
  apiBase = "/api",
  vscodeCommit,
  configRef = "main",
  activeRef = null,
  auth,
}: KitProps) => {
  return (
    <KitErrorBoundary>
      <ShadowRoot css={allCss}>
        <ThemeProvider theme={theme}>
          <KitFabMenu
            apiBase={apiBase}
            vscodeCommit={vscodeCommit}
            configRef={configRef}
            activeRef={activeRef}
            auth={auth}
          />
          <Toaster />
        </ThemeProvider>
      </ShadowRoot>
    </KitErrorBoundary>
  );
};
