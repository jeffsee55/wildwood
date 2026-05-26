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
   * Where the host app mounts Tr33’s `handle()` API (Next catch‑all under `/api/...`).
   * The VS Code web editor loads from `{apiBase}/vscode/editor` on the current origin.
   * @default "/api"
   */
  apiBase?: string;
  /**
   * GitHub owner/repo for IndexedDB git object cache keys.
   */
  repo?: string;
  /**
   * Default git ref label from host config when no `tr33-active-ref` cookie exists.
   */
  configRef?: string;
  /**
   * Active ref from the `tr33-active-ref` cookie (read on the server). Omitted in client-only hosts.
   */
  activeRef?: string | null;
  auth?: KitAuthConfig;
};

export const Kit = ({
  theme = "system",
  apiBase = "/api",
  repo,
  configRef = "main",
  activeRef = null,
  auth,
}: KitProps) => {
  return (
    <ShadowRoot css={allCss}>
      <ThemeProvider theme={theme}>
        <KitFabMenu
          apiBase={apiBase}
          repo={repo}
          configRef={configRef}
          activeRef={activeRef}
          auth={auth}
        />
        <Toaster />
      </ThemeProvider>
    </ShadowRoot>
  );
};
