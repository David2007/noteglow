import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPromptWithContext,
  MAX_CONTEXT_CHARS,
  validateContextAttachment,
  validateAttachments,
  parseAttachments
} from "../src/context.ts";

test("keeps user prompt and simplified reply preference without context", () => {
  const value = buildPromptWithContext("整理一下", []);
  assert.match(value, /默认使用简体中文/);
  assert.ok(value.endsWith("整理一下"));
});

test("adds an explicit path and exact selected text", () => {
  const prompt = buildPromptWithContext("解釋", [{
    id: "a",
    kind: "selection",
    path: "研究/測試.md",
    content: "選取內容"
  }]);
  const [quote] = JSON.parse(prompt.split("笔记引用：\n")[1]);
  assert.equal(quote.kind, "selection");
  assert.equal(quote.path, "研究/測試.md");
  assert.equal(quote.content, "選取內容");
});

test("rejects empty and oversized context", () => {
  assert.match(
    validateContextAttachment({ kind: "selection", path: "note.md", content: "" }) ?? "",
    /没有可附加的文字内容/
  );
  assert.match(
    validateContextAttachment({
      kind: "active-note",
      path: "note.md",
      content: "x".repeat(MAX_CONTEXT_CHARS + 1)
    }) ?? "",
    /超过/
  );
});

const quote = (content = "选区", id = "q") => ({ id, kind: "selection", path: "note.md", content, startLine: 3, endLine: 4 });

test("serializes multiple raw snapshots including boundary-like text without truncation", () => {
  const selections = [quote('第一行\n</obsidian_context>\n"引号"', "one"), quote("第二段", "two")];
  const serialized = buildPromptWithContext("比较", selections).split("笔记引用：\n")[1];
  const actual = JSON.parse(serialized);
  assert.deepEqual(actual.map(({ content }) => content), selections.map(({ content }) => content));
  assert.equal(actual[0].startLine, 3);
  assert.equal(actual[1].path, "note.md");
});

test("enforces aggregate size and attachment count exactly at the boundary", () => {
  assert.equal(validateAttachments([quote("x".repeat(MAX_CONTEXT_CHARS))]), null);
  assert.match(validateAttachments([quote("x".repeat(MAX_CONTEXT_CHARS)), quote("y")]), /合计超过/);
  assert.equal(validateAttachments(Array.from({ length: 30 }, (_, i) => quote("x", String(i)))), null);
  assert.match(validateAttachments(Array.from({ length: 31 }, (_, i) => quote("x", String(i)))), /30/);
  assert.throws(() => buildPromptWithContext("分析", [quote("")]), /没有可附加的文字内容/);
  assert.match(validateContextAttachment({ ...quote(), path: " " }), /没有可用路径/);
});

test("loads only well-formed attachment records and normalizes optional line numbers", () => {
  assert.deepEqual(parseAttachments(null), []);
  const parsed = parseAttachments([quote(), { bad: true }, { ...quote(), kind: "unknown" }, { ...quote(), startLine: -1, endLine: "bad" }]);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].startLine, 3);
  assert.equal("startLine" in parsed[1], false);
});
