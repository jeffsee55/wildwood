'use client'

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
   * Always pass whatever you have — library decides prod vs dev behavior.
   * In dev, missing fields are tolerated (install UI hidden). In prod, missing
   * `githubApp.appSlug` will throw to surface broken config.
   */
  auth?: KitAuthConfig;
};

export const Kit = ({
  theme = "system",
  apiBase = "/api",
  vscodeCommit,
  configRef = "main",
  activeRef = null,
  auth,
}: KitProps) => {
  return (
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
  );
};
