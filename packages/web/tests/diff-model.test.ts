import { test, expect } from "vitest";
import { computeDiff, segments, splitRows } from "../browser/diff-model";
test("review context collapses without dropping lines and replacement rows align", () => {
  const before = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`);
  const after = [...before];
  after.splice(25, 2, "replacement");
  const model = computeDiff(before.join("\n"), after.join("\n"))!;
  expect([model.additions, model.deletions]).toEqual([1, 2]);
  const collapsed = segments(model, new Set());
  expect(collapsed.filter((s) => s.kind === "gap")).toHaveLength(2);
  const expanded = segments(
    model,
    new Set(collapsed.filter((s) => s.kind === "gap").map((s) => s.start)),
  );
  expect(expanded.every((s) => s.kind === "rows")).toBe(true);
  expect(expanded.reduce((n, s) => n + s.end - s.start + 1, 0)).toBe(model.rows.length);
  const rows = splitRows(model.rows, 0, model.rows.length - 1);
  expect(rows.filter((r) => r.left?.type === "del")).toHaveLength(2);
  expect(rows.find((r) => r.right?.type === "add")?.left?.old).toBe(26);
});
test("review preserves empty files and EOF-only changes and rejects oversized interactive diffs", () => {
  expect(computeDiff("", "")?.rows).toHaveLength(0);
  expect(computeDiff(null, "new\n")?.additions).toBe(1);
  expect(computeDiff("old\n", null)?.deletions).toBe(1);
  expect(computeDiff("line", "line\n")?.hunks).toHaveLength(1);
  expect(computeDiff("a".repeat(600000), "b")).toBeNull();
});
