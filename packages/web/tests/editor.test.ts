import { expect, test } from "vitest";
import { formatSelection, markdownBody, retryKey, SourceHistory } from "../browser/editor-model";

test("formatting round trips a selection without touching frontmatter or adjacent content", () => {
  const source = "---\ntitle: A\n---\nHello world!";
  const start = source.indexOf("world");
  const bold = formatSelection(source, start, start + 5, "bold");
  expect(bold.source).toBe(source.replace("world", "**world**"));
  expect(formatSelection(bold.source, bold.start, bold.end, "bold")).toEqual({
    source,
    start,
    end: start + 5,
  });
});
test("line formatting includes selected lines but leaves the next line intact", () => {
  const source = "first\nsecond\nthird";
  const edit = formatSelection(source, 2, 13, "list");
  expect(edit.source).toBe("- first\n- second\nthird");
  expect(formatSelection(edit.source, edit.start, edit.end, "list").source).toBe(source);
});
test("empty selections receive editable placeholders and frontmatter supports CRLF", () => {
  expect(formatSelection("", 0, 0, "link")).toEqual({
    source: "[link text](https://)",
    start: 1,
    end: 10,
  });
  expect(markdownBody("---\r\ntitle: Hi\r\n---\r\n# Hello").body).toBe("# Hello");
  expect(markdownBody("---\nAn unfinished separator").body).toBe("---\nAn unfinished separator");
});
test("identical retries retain their key and changed save intent receives a new key", () => {
  const attempt = retryKey(null, { source: "A", revision: 1 });
  expect(retryKey(attempt, { source: "A", revision: 1 })).toBe(attempt);
  expect(retryKey(attempt, { source: "B", revision: 1 }).key).not.toBe(attempt.key);
});

test("undo groups typing and treats formatting as a separate reversible edit", () => {
  const history = new SourceHistory("Original");
  history.record("Original a", true, 1000);
  history.record("Original ab", true, 1200);
  history.record("Original **ab**");
  expect(history.step(-1)).toBe("Original ab");
  expect(history.step(-1)).toBe("Original");
  expect(history.step(1)).toBe("Original ab");
  history.record("Different", true, 2000);
  expect(history.step(1)).toBe("Different");
  expect(history.step(-1)).toBe("Original ab");
});
