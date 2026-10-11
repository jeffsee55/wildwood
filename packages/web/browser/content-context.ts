import type { ContentMap } from "../src/sourcemap";

export type ComposerContext = { id: string; text: string; label: string; excerpt: string };

export function contentAnnotation(
  raw: string | null,
  displayedText: string,
  pageUrl: string,
): ComposerContext {
  const text = contentContext(raw, displayedText, pageUrl);
  const map: ContentMap = JSON.parse(raw!);
  return {
    id: JSON.stringify(map),
    text,
    label: `${map.source}${map.path.length ? ` · ${map.path.join(".")}` : ""}`,
    excerpt: displayedText.trim().slice(0, 240),
  };
}

/** Source metadata is context for an agent, never authority to read or write content. */
export function contentContext(raw: string | null, text: string, pageUrl: string): string {
  if (!raw || raw.length > 32768) throw new Error("This element has no usable content source map.");
  const map: ContentMap = JSON.parse(raw);
  if (
    !map ||
    typeof map !== "object" ||
    map.v !== 1 ||
    ![map.repository, map.snapshot, map.version, map.source, map.canonical].every(
      (value) => typeof value === "string" && value.length > 0,
    ) ||
    !Array.isArray(map.path) ||
    !map.path.every(
      (value) => typeof value === "string" || (Number.isInteger(value) && value >= 0),
    ) ||
    !map.variant ||
    typeof map.variant !== "object" ||
    Array.isArray(map.variant) ||
    !Object.values(map.variant).every((value) => typeof value === "string")
  )
    throw new Error("This element has an invalid content source map.");
  const url = new URL(pageUrl);
  // Preview credentials and other query parameters do not belong in model context.
  return `Selected page content:\n${JSON.stringify(
    {
      page: `${url.origin}${url.pathname}`,
      repository: map.repository,
      file: map.source,
      canonical: map.canonical,
      field: map.path,
      snapshot: map.snapshot,
      schemaVersion: map.version,
      variant: map.variant,
      displayedText: text.trim().slice(0, 6000),
    },
    null,
    2,
  )}\nRead the current draft through MCP before editing; this snapshot identifies the displayed source.`;
}

export function isContentShortcut(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "isComposing">,
) {
  return (
    (event.metaKey || event.ctrlKey) &&
    event.key.toLowerCase() === "l" &&
    !event.altKey &&
    !event.shiftKey &&
    !event.isComposing
  );
}
