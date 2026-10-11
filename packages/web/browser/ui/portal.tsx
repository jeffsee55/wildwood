import { createContext, useContext, type ReactNode } from "react";

// Portals must stay inside the toolbar's shadow root to inherit its stylesheet.
const PortalContext = createContext<HTMLElement | undefined>(undefined);
export function PortalProvider({
  container,
  children,
}: {
  container: HTMLElement;
  children: ReactNode;
}) {
  return <PortalContext.Provider value={container}>{children}</PortalContext.Provider>;
}
export function usePortalContainer() {
  return useContext(PortalContext);
}
