import * as React from "react";
import { createPortal } from "react-dom";

const fontFaceRegex = /@font-face\s*\{[^}]*\}/g;

function extractFontFaces(css: string): { fontFaces: string; rest: string } {
  const fontFaces = (css.match(fontFaceRegex) || []).join("\n");
  const rest = css.replace(fontFaceRegex, "");
  return { fontFaces, rest };
}

function rewriteSelectorsForShadow(css: string): string {
  return css
    .replace(/(?<![.\-\w#])(:root)\b/g, ":host")
    .replace(/(?<![.\-\w#])(html)\b(?!\s*[{,]?\s*\.)/g, ":host")
    .replace(/(?<![.\-\w#])(body)\b/g, ":host");
}

export type KitShadowContextValue = {
  /** Portal target inside the shadow tree (theme class + UI root). */
  portal: HTMLDivElement | null;
  /** Light-DOM shadow host; use for `color-scheme` / isolation from the embedding page. */
  host: HTMLDivElement | null;
};

const KitShadowContext = React.createContext<KitShadowContextValue>({
  portal: null,
  host: null,
});

/** Inner shadow tree portal target (full-screen wrapper). */
export function useShadowContainer(): HTMLDivElement | null {
  return React.useContext(KitShadowContext).portal;
}

/** Light-DOM node that owns the shadow root (`:host` in kit CSS). */
export function useShadowHost(): HTMLDivElement | null {
  return React.useContext(KitShadowContext).host;
}

export function ShadowRoot({ css, children }: { css: string; children: React.ReactNode }) {
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const [hostElement, setHostElement] = React.useState<HTMLDivElement | null>(null);
  const [shadowRoot, setShadowRoot] = React.useState<ShadowRoot | null>(null);
  const [container, setContainer] = React.useState<HTMLDivElement | null>(null);
  const fontStyleRef = React.useRef<HTMLStyleElement | null>(null);

  const setHostRef = React.useCallback((node: HTMLDivElement | null) => {
    hostRef.current = node;
    setHostElement(node);
  }, []);

  React.useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    if (host.shadowRoot) {
      setShadowRoot(host.shadowRoot);
      const wrapper = host.shadowRoot.querySelector("div");
      if (wrapper) {
        setContainer(wrapper as HTMLDivElement);
      }
      return;
    }

    const shadow = host.attachShadow({ mode: "open" });

    const { fontFaces, rest } = extractFontFaces(css);
    const rewritten = rewriteSelectorsForShadow(rest);

    const shadowStyle = document.createElement("style");
    shadowStyle.textContent =
      rewritten +
      "\n[data-slot],[data-sonner-toaster],button,a,input,select,textarea{pointer-events:auto;}";
    shadow.appendChild(shadowStyle);

    if (fontFaces) {
      const docStyle = document.createElement("style");
      docStyle.textContent = fontFaces;
      docStyle.setAttribute("data-kit-fonts", "");
      document.head.appendChild(docStyle);
      fontStyleRef.current = docStyle;
    }

    const wrapper = document.createElement("div");
    /* Full-viewport layer inside shadow; children should use `absolute` (not `fixed`) so
     * positioning is relative to this box—`fixed` inside shadow often resolves against the
     * zero-size light-DOM host and breaks FAB placement. */
    wrapper.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
    shadow.appendChild(wrapper);

    setShadowRoot(shadow);
    setContainer(wrapper);

    return () => {
      fontStyleRef.current?.remove();
      fontStyleRef.current = null;
    };
  }, [css]);

  const shadowValue = React.useMemo(
    () => ({
      portal: container,
      host: hostElement,
    }),
    [container, hostElement],
  );

  return (
    <div ref={setHostRef} data-kit-shadow-host="">
      {shadowRoot && container ? (
        <KitShadowContext.Provider value={shadowValue}>
          {createPortal(children, container)}
        </KitShadowContext.Provider>
      ) : null}
    </div>
  );
}
