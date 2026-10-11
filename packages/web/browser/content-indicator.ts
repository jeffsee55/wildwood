/** Paint on the actual content box; never mirror its viewport geometry. */
export function installContentIndicator(
  owner: Document = document,
  selectedElement?: Element,
): () => void {
  const path: string[] = [];
  for (let element = selectedElement; element?.parentElement; element = element.parentElement) {
    const index = Array.prototype.indexOf.call(element.parentElement.children, element) + 1;
    path.unshift(`> :nth-child(${index})`);
  }
  const selector = selectedElement
    ? `:root ${path.join(" ")}[data-ww-contentmap="${CSS.escape(selectedElement.getAttribute("data-ww-contentmap") || "")}"]`
    : "[data-ww-contentmap]:hover:not(:has([data-ww-contentmap]:hover, wildwood-toolbar:hover))";
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    ${selector} {
      outline: 2px solid #404040 !important;
      outline-offset: -2px !important;
    }
    @media (prefers-color-scheme: dark) {
      ${selector} {
        outline-color: #d4d4d4 !important;
      }
    }
    @media (forced-colors: active) {
      ${selector} {
        outline-color: Highlight !important;
      }
    }
  `);
  // No attributes, inline styles, wrappers, or observers on authored content.
  // Removal restores the site's own outline rules, including focus outlines.
  owner.adoptedStyleSheets = [...owner.adoptedStyleSheets, sheet];
  return () => {
    owner.adoptedStyleSheets = owner.adoptedStyleSheets.filter((candidate) => candidate !== sheet);
  };
}
