import { Button } from "./ui/button";
import { Fragment, memo, useMemo, useState } from "react";
import { FileText, Bot, MessageSquare, UnfoldVertical, X } from "lucide-react";
import { diffWordsWithSpace } from "diff";
import { computeDiff, segments, splitRows, type Row } from "./diff-model";
import type { Change } from "../src/reviews";
export type FileDiff = Change & {
  beforeContent: {
    source: string | null;
    size: number;
    binary: boolean;
    tooLarge?: boolean;
    media?: { type: string; kind: "image" | "audio" | "video" | "file" };
  };
  afterContent: {
    source: string | null;
    size: number;
    binary: boolean;
    tooLarge?: boolean;
    media?: { type: string; kind: "image" | "audio" | "video" | "file" };
  };
};

export type LineSelection = { side: "before" | "after"; start: number; end: number; text: string };
export const Diff = memo(function Diff({
  value,
  split,
  wrap,
  onAskAgent,
  onComment,
}: {
  value: FileDiff;
  split: boolean;
  wrap: boolean;
  onAskAgent?: (selection: LineSelection) => void;
  onComment?: (selection: LineSelection) => void;
}) {
  const a = value.beforeContent,
    b = value.afterContent;
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [selection, setSelection] = useState<{
    side: "before" | "after";
    anchor: number;
    end: number;
  } | null>(null);
  const model = useMemo(
    () =>
      a.binary || b.binary || a.tooLarge || b.tooLarge ? null : computeDiff(a.source, b.source),
    [a.source, b.source, a.binary, b.binary, a.tooLarge, b.tooLarge],
  );
  if (a.binary || b.binary || a.tooLarge || b.tooLarge)
    return (
      <div className="empty-diff">
        <FileText />
        <h3>
          {a.binary || b.binary ? "Binary file changed" : "File exceeds the inline diff limit"}
        </h3>
        <p>
          {a.size.toLocaleString()} → {b.size.toLocaleString()} bytes
        </p>
      </div>
    );
  if (!model)
    return <div className="empty-diff">This diff is too large to compute interactively.</div>;
  const selected: LineSelection | null = selection
    ? {
        side: selection.side,
        start: Math.min(selection.anchor, selection.end),
        end: Math.max(selection.anchor, selection.end),
        text:
          (selection.side === "before" ? a.source : b.source)
            ?.split("\n")
            .slice(
              Math.min(selection.anchor, selection.end) - 1,
              Math.max(selection.anchor, selection.end),
            )
            .join("\n")
            .slice(0, 12000) ?? "",
      }
    : null;
  const gutter = (side: "before" | "after", line?: number) => (
    <td
      className={`gutter ${selected?.side === side && line !== undefined && line >= selected.start && line <= selected.end ? "line-selected" : ""}`}
    >
      {line !== undefined && (
        <Button
          variant="ghost"
          aria-label={`Select ${side} line ${line}`}
          aria-pressed={selected?.side === side && line >= selected.start && line <= selected.end}
          onClick={(e) =>
            setSelection({
              side,
              anchor: e.shiftKey && selection?.side === side ? selection.anchor : line,
              end: line,
            })
          }
        >
          {line}
        </Button>
      )}
    </td>
  );
  const words = (row: Row, other?: Row) => {
    if (!other || row.type === "ctx" || row.text.length > 1200 || other.text.length > 1200)
      return row.text || " ";
    return (
      diffWordsWithSpace(other.text, row.text, { timeout: 10 })
        ?.filter((p) => !p.removed)
        .map((p, i) => (
          <span
            key={i}
            className={p.added ? (row.type === "add" ? "word-added" : "word-removed") : undefined}
          >
            {p.value}
          </span>
        )) ?? row.text
    );
  };
  const cells = (row: Row | undefined, side: "before" | "after", other?: Row) => (
    <>
      {gutter(side, side === "before" ? row?.old : row?.new)}
      <td
        className={`code ${row?.type === "add" ? "plus" : row?.type === "del" ? "minus" : row ? "" : "empty"}`}
      >
        {row ? words(row, other) : " "}
      </td>
    </>
  );
  const newline = (a.source ?? "").endsWith("\n") !== (b.source ?? "").endsWith("\n");
  return (
    <>
      <div className="diff-meta">
        <span>
          {value.beforeMode !== value.afterMode
            ? `Mode ${value.beforeMode || "—"} → ${value.afterMode || "—"}`
            : "Click line numbers to select · Shift-click for a range"}
        </span>
        <span>
          <b className="diff-added">+{model.additions}</b>{" "}
          <b className="diff-removed">−{model.deletions}</b>
        </span>
      </div>
      {selected && (
        <div className="diff-selection" role="region" aria-label="Selected lines">
          <span>
            {selected.side} · lines {selected.start}–{selected.end}
          </span>
          {onAskAgent && (
            <Button variant="ghost" onClick={() => onAskAgent(selected)}>
              <Bot size={13} />
              Ask agent
            </Button>
          )}
          {onComment && (
            <Button variant="ghost" onClick={() => onComment(selected)}>
              <MessageSquare size={13} />
              Comment
            </Button>
          )}
          <Button
            variant="ghost"
            aria-label="Clear line selection"
            onClick={() => setSelection(null)}
          >
            <X size={13} />
          </Button>
        </div>
      )}
      {split && (
        <div className="split-labels">
          <span>Before</span>
          <span>After</span>
        </div>
      )}
      <div className={`diff-scroll ${wrap ? "" : "nowrap"}`}>
        <table className={`diff-table ${split ? "split" : ""}`}>
          <colgroup>
            <col className="number-column" />
            {split ? (
              <>
                <col />
                <col className="number-column" />
                <col />
              </>
            ) : (
              <>
                <col className="number-column" />
                <col />
              </>
            )}
          </colgroup>
          <tbody>
            {segments(model, expanded).map((s) =>
              s.kind === "gap" ? (
                <tr key={`gap-${s.start}`} className="diff-gap">
                  <td colSpan={split ? 4 : 3}>
                    <Button
                      variant="ghost"
                      onClick={() => setExpanded((e) => new Set(e).add(s.start))}
                    >
                      <UnfoldVertical size={13} />
                      Show {s.end - s.start + 1} unchanged lines
                    </Button>
                  </td>
                </tr>
              ) : (
                <Fragment key={`rows-${s.start}`}>
                  {s.hunk !== undefined && (
                    <tr className="hunk" data-hunk={s.hunk}>
                      <td colSpan={split ? 4 : 3}>
                        @@ −{model.rows[s.start].old ?? ""} +{model.rows[s.start].new ?? ""} @@
                      </td>
                    </tr>
                  )}
                  {split
                    ? splitRows(model.rows, s.start, s.end).map((row) => (
                        <tr key={row.index}>
                          {cells(row.left, "before", row.right)}
                          {cells(row.right, "after", row.left)}
                        </tr>
                      ))
                    : model.rows.slice(s.start, s.end + 1).map((row, i) => (
                        <tr
                          key={s.start + i}
                          className={
                            row.type === "add" ? "plus" : row.type === "del" ? "minus" : ""
                          }
                        >
                          {gutter("before", row.old)}
                          {gutter("after", row.new)}
                          <td className="code">
                            <span className="line-sign">
                              {row.type === "add" ? "+" : row.type === "del" ? "−" : " "}
                            </span>
                            {row.text || " "}
                          </td>
                        </tr>
                      ))}
                </Fragment>
              ),
            )}
          </tbody>
        </table>
        {!model.hunks.length && (
          <div className="empty-diff">
            File contents are unchanged.
            {value.beforeMode !== value.afterMode ? " File mode changed." : ""}
          </div>
        )}
        {newline && (
          <p className="diff-newline">
            {b.source?.endsWith("\n") ? "Final newline added" : "No newline at end of new file"}
          </p>
        )}
      </div>
    </>
  );
});
