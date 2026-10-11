// Adapted from jeffsee55/fx-proj (3626ae1): compact hunks and split-row pairing.
import { diffLines } from "diff";

export type RowType = "ctx" | "add" | "del";

export interface Row {
  type: RowType;
  old?: number;
  new?: number;
  text: string;
}

export interface Hunk {
  /** Row indices, inclusive, including surrounding context. */
  start: number;
  end: number;
  /** First changed row, where navigation lands. */
  first: number;
}

export interface DiffModel {
  rows: Row[];
  hunks: Hunk[];
  additions: number;
  deletions: number;
}

export const CONTEXT = 3;

const splitLines = (text: string) => {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
};

export function computeDiff(oldText: string | null, newText: string | null): DiffModel | null {
  if ((oldText?.length ?? 0) + (newText?.length ?? 0) > 512 * 1024) return null;
  const parts = diffLines(oldText ?? "", newText ?? "", { timeout: 150, maxEditLength: 10000 });
  if (!parts) return null;
  const rows: Row[] = [];
  let o = 1;
  let n = 1;
  for (const part of parts) {
    for (const text of splitLines(part.value)) {
      if (part.added) rows.push({ type: "add", new: n++, text });
      else if (part.removed) rows.push({ type: "del", old: o++, text });
      else rows.push({ type: "ctx", old: o++, new: n++, text });
    }
  }
  const hunks: Hunk[] = [];
  rows.forEach((r, i) => {
    if (r.type === "ctx") return;
    const last = hunks.at(-1);
    if (last && i - CONTEXT <= last.end + 1) last.end = Math.min(rows.length - 1, i + CONTEXT);
    else
      hunks.push({
        start: Math.max(0, i - CONTEXT),
        end: Math.min(rows.length - 1, i + CONTEXT),
        first: i,
      });
  });
  return {
    rows,
    hunks,
    additions: rows.filter((r) => r.type === "add").length,
    deletions: rows.filter((r) => r.type === "del").length,
  };
}

export type Segment =
  | { kind: "rows"; start: number; end: number; hunk?: number }
  | { kind: "gap"; start: number; end: number };

/** Visible row ranges and the collapsed gaps between them. `expanded` holds gap starts the user opened. */
export function segments(model: DiffModel, expanded: Set<number>): Segment[] {
  const out: Segment[] = [];
  let cursor = 0;
  const push = (s: Segment) => {
    const last = out.at(-1);
    if (
      s.kind === "rows" &&
      last?.kind === "rows" &&
      last.end + 1 === s.start &&
      s.hunk === undefined
    )
      last.end = s.end;
    else out.push(s);
  };
  model.hunks.forEach((h, i) => {
    if (h.start > cursor)
      push(
        expanded.has(cursor)
          ? { kind: "rows", start: cursor, end: h.start - 1 }
          : { kind: "gap", start: cursor, end: h.start - 1 },
      );
    out.push({ kind: "rows", start: h.start, end: h.end, hunk: i });
    cursor = h.end + 1;
  });
  if (cursor < model.rows.length) {
    push(
      expanded.has(cursor) || !model.hunks.length
        ? { kind: "rows", start: cursor, end: model.rows.length - 1 }
        : { kind: "gap", start: cursor, end: model.rows.length - 1 },
    );
  }
  return out;
}

export interface SplitRow {
  left?: Row;
  right?: Row;
  /** Index of the row in the unified list, for anchoring. */
  index: number;
}

/** Pairs removed and added runs side by side. */
export function splitRows(rows: Row[], start: number, end: number): SplitRow[] {
  const out: SplitRow[] = [];
  let i = start;
  while (i <= end) {
    const r = rows[i];
    if (r.type === "ctx") {
      out.push({ left: r, right: r, index: i });
      i++;
      continue;
    }
    const dels: number[] = [];
    const adds: number[] = [];
    while (i <= end && rows[i].type === "del") dels.push(i++);
    while (i <= end && rows[i].type === "add") adds.push(i++);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
      out.push({
        left: dels[k] !== undefined ? rows[dels[k]] : undefined,
        right: adds[k] !== undefined ? rows[adds[k]] : undefined,
        index: adds[k] ?? dels[k],
      });
    }
  }
  return out;
}

export const lineOn = (r: Row | undefined, side: "old" | "new") =>
  side === "new" ? r?.new : r?.type === "add" ? undefined : r?.old;
