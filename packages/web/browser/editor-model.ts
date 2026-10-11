export type Format = "bold" | "italic" | "code" | "link" | "heading" | "list" | "quote";
/** Selection transforms are independent of rendering and preserve surrounding source bytes. */
export function formatSelection(source: string, start: number, end: number, format: Format) {
  const selected = source.slice(start, end);
  if (["heading", "list", "quote"].includes(format)) {
    const from = start === 0 ? 0 : source.lastIndexOf("\n", start - 1) + 1;
    const next = source.indexOf("\n", Math.max(start, end - 1));
    const to = next < 0 ? source.length : next;
    const block = source.slice(from, to);
    const prefix = { heading: "## ", list: "- ", quote: "> " }[
      format as "heading" | "list" | "quote"
    ];
    const lines = block.split("\n");
    const remove = lines.every((line) => line.startsWith(prefix));
    const replacement = lines
      .map((line) => (remove ? line.slice(prefix.length) : prefix + line))
      .join("\n");
    return {
      source: source.slice(0, from) + replacement + source.slice(to),
      start: from,
      end: from + replacement.length,
    };
  }
  const mark = { bold: "**", italic: "_", code: "`", link: "[" }[
    format as "bold" | "italic" | "code" | "link"
  ];
  const suffix = format === "link" ? "](https://)" : mark;
  const text = selected || (format === "link" ? "link text" : "text");
  // Pressing a format shortcut twice unwraps the selected text.
  if (
    format !== "link" &&
    start >= mark.length &&
    source.slice(start - mark.length, start) === mark &&
    source.slice(end, end + mark.length) === mark
  )
    return {
      source: source.slice(0, start - mark.length) + selected + source.slice(end + mark.length),
      start: start - mark.length,
      end: end - mark.length,
    };
  return {
    source: source.slice(0, start) + mark + text + suffix + source.slice(end),
    start: start + mark.length,
    end: start + mark.length + text.length,
  };
}
export function markdownBody(source: string) {
  // Display frontmatter as source, never confuse it with a Markdown horizontal rule.
  const match = /^(?:\uFEFF)?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)(?:\r?\n|$)/.exec(source);
  return { metadata: match?.[0] ?? "", body: source.slice(match?.[0].length ?? 0) };
}
/** Preserve one operation key across identical retries, including edits that are undone. */
export function retryKey(previous: { payload: string; key: string } | null, payload: unknown) {
  const encoded = JSON.stringify(payload);
  return previous?.payload === encoded ? previous : { payload: encoded, key: crypto.randomUUID() };
}

/** Bounded history covers typing and toolbar transforms with the same undo/redo stack. */
export class SourceHistory {
  private entries: string[];
  private cursor = 0;
  private typedAt = 0;
  constructor(source: string) {
    this.entries = [source];
  }
  record(source: string, typing = false, now = Date.now()) {
    if (source === this.entries[this.cursor]) return;
    const coalesce =
      typing &&
      this.typedAt > 0 &&
      now - this.typedAt < 750 &&
      this.cursor === this.entries.length - 1;
    this.entries.splice(this.cursor + 1);
    if (coalesce) this.entries[this.cursor] = source;
    else {
      this.entries.push(source);
      this.cursor++;
    }
    // Keep at most 8 MiB of source history, including the current document.
    let size = this.entries.reduce((n, entry) => n + entry.length * 2, 0);
    while (this.entries.length > 1 && (this.entries.length > 100 || size > 8 * 1024 * 1024)) {
      size -= this.entries.shift()!.length * 2;
      this.cursor--;
    }
    this.typedAt = typing ? now : 0;
  }
  step(direction: -1 | 1) {
    this.cursor = Math.max(0, Math.min(this.entries.length - 1, this.cursor + direction));
    this.typedAt = 0;
    return this.entries[this.cursor];
  }
}
