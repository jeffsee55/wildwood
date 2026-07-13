/* eslint-disable react-refresh/only-export-components */
import * as React from "react";
import { useShadowContainer, useShadowHost } from "@/lib/shadow-root";

export type Theme = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";

type ThemeProviderProps = {
  children: React.ReactNode;
  /** When `"system"` (default), follows `prefers-color-scheme`. Otherwise forces light or dark. */
  theme?: Theme;
  disableTransitionOnChange?: boolean;
};

type ThemeProviderState = {
  theme: Theme;
  resolvedTheme: ResolvedTheme;
};

const COLOR_SCHEME_QUERY = "(prefers-color-scheme: dark)";

const ThemeProviderContext = React.createContext<ThemeProviderState | undefined>(undefined);

function getSystemTheme(): ResolvedTheme {
  if (window.matchMedia(COLOR_SCHEME_QUERY).matches) {
    return "dark";
  }

  return "light";
}

function disableTransitionsTemporarily(root: Element) {
  const style = document.createElement("style");
  style.textContent =
    "*,*::before,*::after{-webkit-transition:none!important;transition:none!important}";

  const styleHost = root.getRootNode() === document ? document.head : root;
  styleHost.appendChild(style);

  return () => {
    window.getComputedStyle(document.body);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        style.remove();
      });
    });
  };
}

function syncThemeDom(
  resolved: ResolvedTheme,
  root: Element,
  shadowHost: HTMLDivElement | null,
  disableTransitionOnChange: boolean,
) {
  const restoreTransitions = disableTransitionOnChange ? disableTransitionsTemporarily(root) : null;

  root.classList.remove("dark");
  if (resolved === "dark") {
    root.classList.add("dark");
  }

  if (shadowHost) {
    shadowHost.style.colorScheme = resolved === "dark" ? "dark" : "light";
    shadowHost.setAttribute("data-kit-theme", resolved);
  } else {
    document.documentElement.style.colorScheme = resolved === "dark" ? "dark" : "light";
    document.documentElement.setAttribute("data-kit-theme", resolved);
  }

  if (restoreTransitions) {
    restoreTransitions();
  }
}

export function ThemeProvider({
  children,
  theme: themeProp = "system",
  disableTransitionOnChange = true,
  ...props
}: ThemeProviderProps) {
  const shadowContainer = useShadowContainer();
  const shadowHost = useShadowHost();

  const theme = themeProp;

  const [systemResolved, setSystemResolved] = React.useState<ResolvedTheme>(() =>
    typeof window !== "undefined" && theme === "system" ? getSystemTheme() : "light",
  );

  const resolvedTheme: ResolvedTheme = theme === "system" ? systemResolved : theme;

  React.useLayoutEffect(() => {
    if (theme !== "system") {
      return undefined;
    }

    const sync = () => {
      setSystemResolved(getSystemTheme());
    };

    sync();
    const mediaQuery = window.matchMedia(COLOR_SCHEME_QUERY);
    mediaQuery.addEventListener("change", sync);

    return () => {
      mediaQuery.removeEventListener("change", sync);
    };
  }, [theme]);

  React.useLayoutEffect(() => {
    const root = shadowContainer ?? document.documentElement;
    syncThemeDom(resolvedTheme, root, shadowHost, disableTransitionOnChange);
  }, [resolvedTheme, shadowContainer, shadowHost, disableTransitionOnChange]);

  const value = React.useMemo(
    () => ({
      theme,
      resolvedTheme,
    }),
    [theme, resolvedTheme],
  );

  return (
    <ThemeProviderContext.Provider {...props} value={value}>
      {children}
    </ThemeProviderContext.Provider>
  );
}

export const useTheme = () => {
  const context = React.useContext(ThemeProviderContext);

  if (context === undefined) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }

  return context;
};
