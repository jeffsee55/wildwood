import type { KitAuthConfig, Theme } from "@tr33/kit";
import { Kit } from "@tr33/kit";
import { cookies } from "next/headers";
import { type ReactNode, Suspense } from "react";
import { resolveActiveRef, type Tr33ForActiveRef } from "./resolve-active-ref";
import { resolveVscodeWebCdn } from "./vscode-web-cdn";

/** Same as {@link Tr33ForActiveRef}. */
export type Tr33KitHostClient = Tr33ForActiveRef;

export type Tr33KitProps = {
  tr33: Tr33KitHostClient;
  apiBase?: string;
  theme?: Theme;
  auth?: KitAuthConfig;
};

/**
 * Server wrapper: reads `tr33-active-ref` and renders the client {@link Kit}.
 * Call from within {@link Toolbar} (or your own `<Suspense>`) so `cookies()` stays off the page shell.
 */
export async function Tr33Kit({ tr33, apiBase, theme, auth }: Tr33KitProps) {
  const cookieStore = await cookies();
  const activeRef = resolveActiveRef({
    tr33,
    cookies: cookieStore,
  });
  const vscodeCommit = (await resolveVscodeWebCdn()).commit;
  return (
    <Kit
      apiBase={apiBase}
      configRef={tr33._.config.ref}
      activeRef={activeRef}
      vscodeCommit={vscodeCommit}
      theme={theme}
      auth={auth}
    />
  );
}

const defaultKitFallback = (
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

export type ToolbarProps = Tr33KitProps & {
  fallback?: ReactNode;
};

export type { KitAuthConfig };

/**
 * Suspense boundary + {@link Tr33Kit} (reads `cookies()` inside the boundary).
 */
export function Toolbar({
  fallback = defaultKitFallback,
  ...kitProps
}: ToolbarProps) {
  return (
    <Suspense fallback={fallback}>
      <Tr33Kit {...kitProps} />
    </Suspense>
  );
}
