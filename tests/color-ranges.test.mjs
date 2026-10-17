import assert from "node:assert/strict";
import test from "node:test";
import { ChangeSet } from "@codemirror/state";
import { normalizeColor, parseLastColors, replaceColor, mergeRanges, mapColorRanges, relocateColorRanges, parseNoteColors, projectMarkdown, alignRenderedText } from "../src/color-ranges.ts";

const background = (from, to, color = "#fff88f") => ({ from, to, property: "background", color });
const foreground = (from, to, color = "#c0392b") => ({ from, to, property: "foreground", color });

test("normalizes one hex color and rejects CSS strings or malformed values", () => {
  assert.equal(normalizeColor(" #AbC "), "#aabbcc");
  assert.equal(normalizeColor("#FFF88F"), "#fff88f");
  for (const value of ["", "red", "#12", "#12345g", "#12345678", "url(a)", "#fff; color:red"]) assert.equal(normalizeColor(value), null);
});

test("latest background replaces overlapping segments while foreground survives", () => {
  const input = [background(0, 12), foreground(2, 10)];
  const output = replaceColor(input, 4, 8, "background", "#abc");
  assert.deepEqual(output.filter((item) => item.property === "background"), [background(0, 4), background(4, 8, "#aabbcc"), background(8, 12)]);
  assert.deepEqual(output.filter((item) => item.property === "foreground"), [foreground(2, 10)]);
  assert.deepEqual(input, [background(0, 12), foreground(2, 10)]);
  assert.deepEqual(replaceColor(output, 0, 12, "background", "#ccddee").filter((item) => item.property === "background"), [background(0, 12, "#ccddee")]);
});

test("clear removes both colors only inside selection and validates boundaries", () => {
  assert.deepEqual(replaceColor([background(0, 6), foreground(0, 6)], 2, 4), [background(0, 2), background(4, 6), foreground(0, 2), foreground(4, 6)]);
  assert.deepEqual(replaceColor([background(0, 6)], 0, 6), []);
  assert.deepEqual(replaceColor([], 0, 1), []);
  for (const [from, to] of [[0, 0], [2, 1], [-1, 2], [0.5, 2]]) assert.throws(() => replaceColor([], from, to), /连续选区/);
  assert.throws(() => replaceColor([], 0, 1, "background", "blue"), /#RGB/);
});

test("merges touching matching colors without merging distinct attributes or colors", () => {
  assert.deepEqual(mergeRanges([background(2, 4), background(0, 2), foreground(0, 2), background(4, 6, "#ffffff"), background(6, 6)]), [background(0, 4), background(4, 6, "#ffffff"), foreground(0, 2)]);
  assert.deepEqual(mergeRanges([]), []);
});

test("CodeMirror mapping follows UTF16 edits, excludes edge inserts and drops deleted ranges", () => {
  const changes = ChangeSet.of({ from: 3, insert: "X" }, 6);
  assert.deepEqual(mapColorRanges([background(3, 6)], (position, association) => changes.mapPos(position, association)), [background(4, 7)]);
  const inside = ChangeSet.of({ from: 2, insert: "🙂" }, 6);
  assert.deepEqual(mapColorRanges([background(1, 4)], (position, association) => inside.mapPos(position, association)), [background(1, 6)]);
  const removed = ChangeSet.of({ from: 1, to: 4 }, 6);
  assert.deepEqual(mapColorRanges([background(1, 4)], (position, association) => removed.mapPos(position, association)), []);
});

test("external edits preserve unchanged prefix/suffix and uniquely relocated text", () => {
  assert.deepEqual(relocateColorRanges({ text: "alpha tail", ranges: [background(0, 5), foreground(6, 10)] }, "alpha NEW tail"), [background(0, 5), foreground(10, 14)]);
  assert.deepEqual(relocateColorRanges({ text: "before SELECT after", ranges: [background(7, 13)] }, "another SELECT changed"), [background(8, 14)]);
  assert.deepEqual(relocateColorRanges({ text: "🙂价格", ranges: [background(2, 4)] }, "🙂价格"), [background(2, 4)]);
});

test("deleting an earlier repeated phrase never transfers its color to the later phrase", () => {
  assert.deepEqual(relocateColorRanges({ text: "X foo\nY foo", ranges: [background(2, 5)] }, "Y foo"), []);
  assert.deepEqual(relocateColorRanges({ text: "X foo\nY foo", ranges: [background(8, 11)] }, "Y foo"), [background(2, 5)]);
  assert.deepEqual(relocateColorRanges({ text: "before foo after", ranges: [background(7, 10)] }, "new foo and foo elsewhere"), []);
  assert.deepEqual(relocateColorRanges({ text: "before foo after", ranges: [background(7, 10)] }, "no matching phrase"), []);
});

test("sidecar parser preserves snapshot, rejects corrupted ranges and normalizes hex", () => {
  const parsed = parseNoteColors({ version: 1, notes: { "学习/a.md": { text: "🙂价格", ranges: [background(2, 4, "#ABC")] } } });
  assert.equal(parsed.notes["学习/a.md"].text, "🙂价格");
  assert.deepEqual(parsed.notes["学习/a.md"].ranges, [background(2, 4, "#aabbcc")]);
  for (const raw of [null, {}, { version: 2, notes: {} }, { version: 1, notes: [] }, { version: 1, notes: { "a.md": { text: "a", ranges: [background(0, 2)] } } }, { version: 1, notes: { "a.md": { text: "a", ranges: [{ ...background(0, 1), property: "unknown" }] } } }]) assert.throws(() => parseNoteColors(raw));
});

test("legacy sidecars get default last colors without changing note text or ranges", () => {
  const old = { version: 1, notes: { "学习/a.md": { text: "**原文** 与 `code`", ranges: [background(2, 4), foreground(2, 4)] } } };
  const before = JSON.stringify(old);
  const parsed = parseNoteColors(old);
  assert.equal(parsed.version, 1);
  assert.deepEqual(parsed.lastColors, { foreground: "#c0392b", background: "#fff88f" });
  assert.equal(parsed.notes["学习/a.md"].text, old.notes["学习/a.md"].text);
  assert.deepEqual(parsed.notes["学习/a.md"].ranges, old.notes["学习/a.md"].ranges);
  assert.equal(JSON.stringify(old), before);
});

test("last color fields fall back independently and never disable valid note records", () => {
  const defaults = { foreground: "#c0392b", background: "#fff88f" };
  for (const invalid of [undefined, null, "#123456", [], 1]) assert.deepEqual(parseLastColors(invalid), defaults);
  for (const invalid of [undefined, null, 42, "red", "#xyz", "#fff; color:red"]) {
    const parsed = parseNoteColors({ version: 1, notes: { "note.md": { text: "word", ranges: [background(0, 4)] } }, lastColors: { foreground: invalid, background: "#ABC" } });
    assert.deepEqual(parsed.lastColors, { foreground: "#c0392b", background: "#aabbcc" });
    assert.deepEqual(parsed.notes["note.md"].ranges, [background(0, 4)]);
    assert.deepEqual(parseLastColors({ foreground: "#123456", background: invalid }), { foreground: "#123456", background: "#fff88f" });
  }
});

test("remembered foreground and background survive a version-one JSON round trip", () => {
  const raw = { version: 1, notes: { "note.md": { text: "原始 Markdown", ranges: [background(0, 2)] } }, lastColors: { foreground: " #0Af ", background: "#FFE1B3" } };
  const before = JSON.stringify(raw);
  const parsed = parseNoteColors(raw);
  assert.deepEqual(parsed.lastColors, { foreground: "#00aaff", background: "#ffe1b3" });
  const reopened = parseNoteColors(JSON.parse(JSON.stringify(parsed)));
  assert.deepEqual(reopened.lastColors, parsed.lastColors);
  assert.deepEqual(reopened.notes, parsed.notes);
  parsed.lastColors.foreground = "#ffffff";
  assert.equal(reopened.lastColors.foreground, "#00aaff");
  assert.equal(JSON.stringify(raw), before);
});

test("reading projection keeps list/bold/italic/link text and exact source offsets", () => {
  const source = "## 标题\n6. **加粗** 与 *斜体* [链接](https://example.com)\n";
  const projection = projectMarkdown(source, 100);
  assert.equal(projection.text, "标题\n加粗 与 斜体 链接\n");
  const first = projection.text.indexOf("加粗");
  assert.equal(projection.offsets[first], 100 + source.indexOf("加粗"));
  assert.equal(projection.offsets[first + 1], 101 + source.indexOf("加粗"));
  assert.deepEqual(alignRenderedText(projection, "标题加粗 与 斜体 链接").filter((item) => item !== null).length, 12);
});

test("inline and fenced code preserve raw asterisks, underscores and angle brackets", () => {
  assert.equal(projectMarkdown("`user_tab * x` 与 \\*字面星号\\*").text, "user_tab * x 与 *字面星号*");
  const source = "```go\nif x < 1 {\n  x = x * 2\n}\n```";
  const projection = projectMarkdown(source);
  assert.equal(projection.text, "if x < 1 {\n  x = x * 2\n}\n");
  const alignment = alignRenderedText(projection, "if x < 1 {\n  x = x * 2\n}\n");
  assert.equal(alignment[0], source.indexOf("if"));
  assert.equal(alignment[2], source.indexOf("if") + 2);
});

test("rendering mismatch fails closed; exact whitespace maps but collapsed whitespace stays uncertain", () => {
  const projection = projectMarkdown("**one** two");
  assert.equal(alignRenderedText(projection, "one THREE"), null);
  assert.equal(alignRenderedText(projection, "one two")[3], 7);
  const collapsed = alignRenderedText(projectMarkdown("one  two"), "one two");
  assert.equal(collapsed[3], null);
  assert.equal(collapsed[4], 5);
  assert.deepEqual(alignRenderedText(projectMarkdown(""), ""), []);
});
