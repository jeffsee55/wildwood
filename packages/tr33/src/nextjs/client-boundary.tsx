'use client';

import type { KitAuthConfig, Theme } from "@tr33/kit";
import dynamic from "next/dynamic";
import { type ReactNode } from "react";

// `next/dynamic` with `ssr:false` is only allowed inside a Client Component.
// This boundary is the client side of `Tr33Kit`/`Toolbar`: server props flow in,
// Kit (shadow DOM + useRef + portals) only ever runs in the browser.
const KitDynamic = dynamic(
  () =>
    import("@tr33/kit").then((m) => {
      const Kit = m.Kit as React.ComponentType<{
        apiBase?: string;
        theme?: Theme;
        auth?: KitAuthConfig;
        configRef: string;
        activeRef: string;
        vscodeCommit: string;
      }>;
      function Bound(props: {
        apiBase?: string;
        theme?: Theme;
        auth?: KitAuthConfig;
        configRef: string;
        activeRef: string;
        vscodeCommit: string;
      }) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return <Kit {...(props as any)} />;
      }
      return { default: Bound };
    }),
  { ssr: false, loading: () => null },
) as unknown as (props: {
  apiBase?: string;
  theme?: Theme;
  auth?: KitAuthConfig;
  configRef: string;
  activeRef: string;
  vscodeCommit: string;
}) => ReactNode;

export function ClientKitBoundary(props: {
  apiBase?: string;
  theme?: Theme;
  auth?: KitAuthConfig;
  configRef: string;
  activeRef: string;
  vscodeCommit: string;
}) {
  return <KitDynamic {...props} />;
}
