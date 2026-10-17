import assert from "node:assert/strict";
import test from "node:test";
import {
  exportConversationMarkdown,
  safeExportBasename,
  searchConversations
} from "../src/conversation-utils.ts";

const conversations = [{
  id: "one",
  title: "研究整理",
  threadId: "must-not-export",
  createdAt: 1,
  updatedAt: 2,
  archived: false,
  messages: [
    { id: "m1", role: "user", text: "比較兩份論文", createdAt: 1000 },
    { id: "m2", role: "assistant", text: "以下是可見摘要", createdAt: 2000 }
  ]
}, {
  id: "two",
  title: "會議",
  threadId: null,
  createdAt: 1,
  updatedAt: 2,
  archived: true,
  messages: [{ id: "m3", role: "system", text: "本機錯誤", createdAt: 3000 }]
}];

test("searches titles and visible message text locally", () => {
  assert.deepEqual(searchConversations(conversations, "研究").map(({ id }) => id), ["one"]);
  assert.deepEqual(searchConversations(conversations, "可見摘要").map(({ id }) => id), ["one"]);
  assert.deepEqual(searchConversations(conversations, "本機錯誤").map(({ id }) => id), ["two"]);
});

test("exports only visible conversation content as Markdown", () => {
  const output = exportConversationMarkdown(conversations[0], 4000);
  assert.match(output, /^# 研究整理/m);
  assert.match(output, /## 你 — 1970-01-01T00:00:01\.000Z/);
  assert.match(output, /比較兩份論文/);
  assert.match(output, /## Codex — 1970-01-01T00:00:02\.000Z/);
  assert.equal(output.includes("must-not-export"), false);
  assert.equal(output.includes("threadId"), false);
});

test("creates filesystem-safe bounded export names", () => {
  assert.equal(safeExportBasename('  A/B: C? "D".  '), "A-B- C- -D-");
  assert.equal(safeExportBasename("..."), "Codex 对话");
  assert.ok(safeExportBasename("x".repeat(200)).length <= 80);
});

test("export includes complete quotation snapshots even when chat renders compact cards", () => {
  const conversation = structuredClone(conversations[0]);
  conversation.messages[0].attachments = [{ id: "q", kind: "selection", path: "long/folder/a.md", content: "第一行\n第二行", startLine: 2, endLine: 3 }];
  const output = exportConversationMarkdown(conversation, 4000);
  assert.match(output, /引用：long\/folder\/a\.md（第 2–3 行）/);
  assert.match(output, /> 第一行\n> 第二行/);
  assert.equal(output.includes("must-not-export"), false);
});
