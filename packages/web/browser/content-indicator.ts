/** Paint on the actual content box; never mirror its viewport geometry. */
export function installContentIndicator(owner: Document = document): () => void {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    [data-ww-contentmap]:hover:not(:has([data-ww-contentmap]:hover, wildwood-toolbar:hover)) {
      outline: 2px solid #668268 !important;
      outline-offset: -2px !important;
    }
    @media (prefers-color-scheme: dark) {
      [data-ww-contentmap]:hover:not(:has([data-ww-contentmap]:hover, wildwood-toolbar:hover)) {
        outline-color: #a4bba4 !important;
      }
    }
    @media (forced-colors: active) {
      [data-ww-contentmap]:hover:not(:has([data-ww-contentmap]:hover, wildwood-toolbar:hover)) {
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
