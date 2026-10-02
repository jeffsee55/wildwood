import { Tabs, TabsList, TabsTrigger, TabsContent } from "./ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { Textarea } from "./ui/textarea";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "./ui/collapsible";
import { useDeferredValue, useRef, useState } from "react";
import Markdown, { defaultUrlTransform, type Components } from "react-markdown";
import {
  Bold,
  Italic,
  Code,
  Link,
  Heading2,
  List,
  Quote,
  Eye,
  FileCode2,
  Columns2,
} from "lucide-react";
import { Button } from "./ui/button";
import { formatSelection, markdownBody, SourceHistory, type Format } from "./editor-model";
const previewComponents: Components = {
  a: ({ children, href }) => (
    <a href={href || undefined} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  img: ({ src, alt }) =>
    src ? (
      <img src={src} alt={alt || ""} loading="lazy" />
    ) : (
      <span className="preview-image-placeholder">Image: {alt || "External image"}</span>
    ),
};
const formats = [
  ["bold", Bold, "Bold", "B"],
  ["italic", Italic, "Italic", "I"],
  ["heading", Heading2, "Heading", ""],
  ["list", List, "Bullet list", ""],
  ["quote", Quote, "Quote", ""],
  ["code", Code, "Inline code", ""],
  ["link", Link, "Link", "K"],
] as const;
export default function MarkdownEditor({
  source,
  onChange,
  onSave,
  disabled,
  markdown,
  endpoint,
  snapshot,
}: {
  source: string;
  onChange: (value: string) => void;
  onSave: () => void;
  disabled: boolean;
  markdown: boolean;
  endpoint: string;
  snapshot: string;
}) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const history = useRef<SourceHistory | null>(null);
  history.current ??= new SourceHistory(source);
  function change(value: string, typing = false) {
    history.current!.record(value, typing);
    onChange(value);
  }
  const [mode, setMode] = useState<"write" | "preview" | "split">("write");
  const [position, setPosition] = useState({ line: 1, column: 1 });
  const deferred = useDeferredValue(source);
  const preview = markdownBody(deferred);
  function selection() {
    const el = textarea.current;
    if (!el) return;
    const before = el.value.slice(0, el.selectionStart);
    setPosition({
      line: before.split("\n").length,
      column: before.length - before.lastIndexOf("\n"),
    });
  }
  function format(kind: Format) {
    const el = textarea.current;
    if (!el || disabled) return;
    const edit = formatSelection(source, el.selectionStart, el.selectionEnd, kind);
    change(edit.source);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(edit.start, edit.end);
      selection();
    });
  }
  return (
    <Tabs
      className="markdown-editor"
      value={mode}
      onValueChange={(value) => setMode(value as "write" | "split" | "preview")}
    >
      <div className="editor-tools">
        <div className="format-actions" role="group" aria-label="Markdown formatting">
          {markdown &&
            formats.map(([kind, Icon, label, key]) => (
              <Tooltip key={kind}>
                <TooltipTrigger
                  render={<Button variant="ghost" size="icon" />}
                  disabled={disabled || mode === "preview"}
                  aria-label={label}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => format(kind)}
                >
                  <Icon />
                </TooltipTrigger>
                <TooltipContent>{key ? `${label} (⌘ / Ctrl ${key})` : label}</TooltipContent>
              </Tooltip>
            ))}
          {!markdown && <span className="editor-language">Source</span>}
        </div>
        {markdown && (
          <TabsList className="editor-modes" aria-label="Editor layout">
            {(
              [
                ["write", FileCode2, "Write"],
                ["split", Columns2, "Split"],
                ["preview", Eye, "Preview"],
              ] as const
            ).map(([value, Icon, label]) => (
              <TabsTrigger key={value} value={value}>
                <Icon />
                <span>{label}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        )}
      </div>
      <TabsContent key={mode} value={mode} className={`editor-panes ${mode}`}>
        {mode !== "preview" && (
          <Textarea
            ref={textarea}
            aria-label="Document source"
            value={source}
            onChange={(e) => change(e.target.value, true)}
            onSelect={selection}
            spellCheck={false}
            disabled={disabled}
            autoFocus
            onKeyDown={(e) => {
              if (!(e.metaKey || e.ctrlKey) || e.altKey || e.nativeEvent.isComposing) return;
              const key = e.key.toLowerCase();
              if (key === "z" || key === "y") {
                e.preventDefault();
                onChange(history.current!.step(key === "y" || e.shiftKey ? 1 : -1));
              } else if (key === "s") {
                e.preventDefault();
                onSave();
              } else if (markdown && ["b", "i", "k"].includes(key)) {
                e.preventDefault();
                format(key === "b" ? "bold" : key === "i" ? "italic" : "link");
              }
            }}
          />
        )}
        {mode !== "write" && (
          <div className="markdown-preview" aria-label="Markdown preview" tabIndex={0}>
            {preview.metadata && (
              <Collapsible className="preview-metadata">
                <CollapsibleTrigger
                  render={<Button variant="ghost" className="disclosure-trigger" />}
                >
                  Document properties
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <pre>{preview.metadata}</pre>
                </CollapsibleContent>
              </Collapsible>
            )}
            {preview.body.trim() ? (
              <Markdown
                skipHtml
                urlTransform={(url, key) => {
                  if (key === "src")
                    return url.startsWith("/media/")
                      ? `${endpoint}/media?${new URLSearchParams({ path: url.slice(1), snapshot })}`
                      : "";
                  return defaultUrlTransform(url);
                }}
                components={previewComponents}
              >
                {preview.body}
              </Markdown>
            ) : (
              <p className="preview-empty">Your words will appear here.</p>
            )}
          </div>
        )}
      </TabsContent>
      <div className="editor-status">
        <span>
          {source.trim() ? source.trim().split(/\s+/).length.toLocaleString() : 0} words{" "}
          <span aria-hidden="true">·</span> {source.length.toLocaleString()} characters
        </span>
        <span>
          Ln {position.line}, Col {position.column}
        </span>
      </div>
    </Tabs>
  );
}
