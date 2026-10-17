import assert from "node:assert/strict";
import test from "node:test";
import { splitLegacyDraft } from "../src/legacy-draft.ts";

test("imports exact legacy quotes as separate cards without losing the typed question", () => {
  const old = "请比较\n\n选区来源：学习/a.md\n> 第一行\n> 第二行\n\n选区来源：学习/b.md\n> `code`\n\n";
  const migrated = splitLegacyDraft(old);
  assert.equal(migrated.draftText, "请比较");
  assert.deepEqual(migrated.attachments.map(({ path, content }) => ({ path, content })), [
    { path: "学习/a.md", content: "第一行\n第二行" }, { path: "学习/b.md", content: "`code`" }
  ]);
  assert.notEqual(migrated.attachments[0].id, migrated.attachments[1].id);
});
test("retains ambiguous or out-of-limit legacy drafts unchanged", () => {
  for (const text of ["普通问题", "选区来源：a.md\n> 原文\n末尾新增问题", "选区来源：a.md\n> " + "x".repeat(50001)]) {
    assert.deepEqual(splitLegacyDraft(text), { draftText: text, attachments: [] });
  }
});
