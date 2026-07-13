"use client";

import type { KitAuthConfig, Theme } from "wildwood-kit";
import dynamic from "next/dynamic";
import * as React from "react";
import { type ReactNode } from "react";

// `next/dynamic` with `ssr:false` is only allowed inside a Client Component.
// This boundary is the client side of `WildwoodKit`/`Toolbar`: server props flow in,
// Kit (shadow DOM + useRef + portals) only ever runs in the browser.

// Extra safety layer outside `wildwood-kit`'s own error boundary — so even if
// the dynamic chunk fails to load, or Next's lazy import errors, the host page
// is unaffected.
class WildwoodToolbarBoundary extends React.Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(
      "[wildwood:toolbar] failed (isolated):",
      error,
      info.componentStack?.slice(0, 1800),
    );
  }
  render() {
    if (this.state.error) {
      // Silently hide in prod — content page must remain usable.
      // In dev, leave a hint.
      if (process.env.NODE_ENV !== "production") {
        return (
          <div
            data-wildwood-toolbar-error="true"
            style={{
              position: "fixed",
              right: 16,
              bottom: 16,
              fontSize: 11,
              opacity: 0.55,
              pointerEvents: "none",
            }}
          >
            [wildwood toolbar failed]
          </div>
        );
      }
      return null;
    }
    return this.props.children;
  }
}

const KitDynamic = dynamic(
  () =>
    import("wildwood-kit").then((m) => {
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
  {
    ssr: false,
    // Important: `dynamic` itself can throw if the chunk is missing (e.g. CDN
    // build failure). Return null — not an uncaught exception — so the page's
    // content render is never torn down.
    loading: () => null,
  },
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
  return (
    <WildwoodToolbarBoundary>
      <KitDynamic {...props} />
    </WildwoodToolbarBoundary>
  );
}
