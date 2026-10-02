import { memo, type ReactNode } from "react";
import { structuredPatch, diffWordsWithSpace } from "diff";
import { FileText } from "lucide-react";
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

export const Diff = memo(function Diff({
  value,
  split,
  wrap,
}: {
  value: FileDiff;
  split: boolean;
  wrap: boolean;
}) {
  const a = value.beforeContent,
    b = value.afterContent;
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
        <p>Both immutable blob identifiers remain in the review.</p>
      </div>
    );
  const patch = structuredPatch(
    value.path,
    value.path,
    a.source || "",
    b.source || "",
    "Before",
    "After",
    { context: 4, timeout: 150, maxEditLength: 10000 },
  );
  if (!patch)
    return <div className="empty-diff">This diff is too large to compute interactively.</div>;
  const word = (text: string, other: string, added: boolean) =>
    text.length < 1200 && other.length < 1200
      ? (diffWordsWithSpace(other, text, { timeout: 10 })
          ?.filter((p) => !p.removed)
          .map((p, i) => (
            <span key={i} className={p.added ? (added ? "word-added" : "word-removed") : ""}>
              {p.value}
            </span>
          )) ?? text)
      : text;
  return (
    <>
      <div className="diff-meta">
        <span>
          {value.beforeMode !== value.afterMode
            ? `Mode ${value.beforeMode || "—"} → ${value.afterMode || "—"}`
            : "Source diff"}
        </span>
        <span>
          {a.size.toLocaleString()} → {b.size.toLocaleString()} bytes
        </span>
      </div>
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
            {patch.hunks.flatMap((h, hi) => {
              let left = h.oldStart,
                right = h.newStart;
              const rows: ReactNode[] = [
                <tr className="hunk" key={`h${hi}`}>
                  <td colSpan={split ? 4 : 3}>
                    @@ −{h.oldStart},{h.oldLines} +{h.newStart},{h.newLines} @@
                  </td>
                </tr>,
              ];
              for (let i = 0; i < h.lines.length; i++) {
                const line = h.lines[i],
                  kind = line[0],
                  text = line.slice(1);
                if (kind === "\\") continue;
                if (split && (kind === "-" || kind === "+")) {
                  const removed: string[] = [],
                    added: string[] = [];
                  while (i < h.lines.length && h.lines[i][0] === "-")
                    removed.push(h.lines[i++].slice(1));
                  while (i < h.lines.length && h.lines[i][0] === "+")
                    added.push(h.lines[i++].slice(1));
                  i--;
                  for (let n = 0; n < Math.max(removed.length, added.length); n++) {
                    rows.push(
                      <tr key={`${hi}-${i}-${n}`}>
                        <td className={removed[n] !== undefined ? "minus gutter" : "gutter"}>
                          {removed[n] !== undefined ? left++ : ""}
                        </td>
                        <td className={removed[n] !== undefined ? "minus code" : "code empty"}>
                          {removed[n] !== undefined ? word(removed[n], added[n] ?? "", false) : ""}
                        </td>
                        <td className={added[n] !== undefined ? "plus gutter" : "gutter"}>
                          {added[n] !== undefined ? right++ : ""}
                        </td>
                        <td className={added[n] !== undefined ? "plus code" : "code empty"}>
                          {added[n] !== undefined ? word(added[n], removed[n] ?? "", true) : ""}
                        </td>
                      </tr>,
                    );
                  }
                  continue;
                }
                rows.push(
                  split ? (
                    <tr key={`${hi}-${i}`}>
                      <td className="gutter">{left++}</td>
                      <td className="code">{text}</td>
                      <td className="gutter">{right++}</td>
                      <td className="code">{text}</td>
                    </tr>
                  ) : (
                    <tr
                      key={`${hi}-${i}`}
                      className={kind === "+" ? "plus" : kind === "-" ? "minus" : ""}
                    >
                      <td className="gutter">{kind !== "+" ? left++ : ""}</td>
                      <td className="gutter">{kind !== "-" ? right++ : ""}</td>
                      <td className="code">
                        <span className="line-sign">{kind}</span>
                        {text}
                      </td>
                    </tr>
                  ),
                );
              }
              return rows;
            })}
          </tbody>
        </table>
        {!patch.hunks.length && (
          <div className="empty-diff">
            File contents are unchanged.
            {value.beforeMode !== value.afterMode ? " File mode changed." : ""}
          </div>
        )}
      </div>
    </>
  );
});
