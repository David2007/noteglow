import assert from "node:assert/strict";
import test from "node:test";
import {
  ConversationRepository,
  MAX_MESSAGES_PER_CONVERSATION,
  loadPluginSettings
} from "../src/conversation-store.ts";

const message = (id, role = "user", text = id, createdAt = 10) => ({
  id,
  role,
  text,
  createdAt
});

test("migrates legacy settings into one resumable conversation", () => {
  const loaded = loadPluginSettings({
    codexPath: "/bin/codex",
    sandboxMode: "read-only",
    approveForMe: false,
    sessionId: "thread-old",
    messages: [message("m1", "user", "整理研究筆記")],
    draftText: "", draftAttachments: [], draftImages: [], model: ""
  }, { now: () => 100, makeId: () => "conversation-1" });

  assert.equal(loaded.migratedLegacy, true);
  assert.equal(loaded.settings.schemaVersion, 1);
  assert.equal(loaded.settings.activeConversationId, "conversation-1");
  assert.deepEqual(loaded.settings.conversations[0], {
    id: "conversation-1",
    title: "整理研究筆記",
    threadId: "thread-old",
    createdAt: 100,
    updatedAt: 100,
    archived: false,
    messages: [message("m1", "user", "整理研究筆記")],
    draftText: "", draftAttachments: [], draftImages: [], model: ""
  });
});

test("reload keeps each conversation draft, model, references and visible history separate", () => {
  const data = loadPluginSettings(null, { makeId: () => "draft" }).settings;
  const reference = { id: "q", kind: "selection", path: "a.md", content: "原文", startLine: 4, endLine: 5 };
  data.conversations[0].draftText = "请比较";
  data.conversations[0].draftAttachments = [reference];
  data.conversations[0].model = "gpt-6-luna";
  data.conversations[0].messages.push({ ...message("sent"), attachments: [reference] });
  const restored = loadPluginSettings(JSON.parse(JSON.stringify(data))).settings.conversations[0];
  assert.equal(restored.draftText, "请比较");
  assert.equal(restored.model, "gpt-6-luna");
  assert.deepEqual(restored.draftAttachments, [reference]);
  assert.deepEqual(restored.messages[0].attachments, [reference]);
});

test("isolates malformed conversations and selects a valid fallback", () => {
  const loaded = loadPluginSettings({
    schemaVersion: 1,
    activeConversationId: "missing",
    conversations: [
      { broken: true },
      {
        id: "valid",
        title: "保留",
        threadId: null,
        createdAt: 1,
        updatedAt: 2,
        archived: false,
        messages: [message("ok"), { id: "bad" }]
      }
    ]
  });

  assert.equal(loaded.recoveredRecords, 1);
  assert.equal(loaded.settings.activeConversationId, "valid");
  assert.deepEqual(loaded.settings.conversations[0].messages, [message("ok")]);
});

test("preserves known data with future fields and recovers an all-archived store", () => {
  let sequence = 0;
  const loaded = loadPluginSettings({
    schemaVersion: 2,
    activeConversationId: "archived",
    futureField: { ignored: true },
    conversations: [{
      id: "archived",
      title: "舊對話",
      threadId: "thread-old",
      createdAt: 1,
      updatedAt: 2,
      archived: true,
      messages: [],
      futureConversationField: true
    }]
  }, { now: () => 3, makeId: () => `new-${++sequence}` });

  assert.equal(loaded.migratedLegacy, false);
  assert.equal(loaded.settings.conversations[0].threadId, "thread-old");
  assert.equal(loaded.settings.conversations.length, 2);
  assert.equal(loaded.settings.activeConversationId, "new-1");
});

test("creates, selects, renames, archives, restores, and deletes conversations", () => {
  let clock = 20;
  let sequence = 0;
  const loaded = loadPluginSettings(null, {
    now: () => clock,
    makeId: () => `c${++sequence}`
  });
  const repository = new ConversationRepository(
    loaded.settings,
    () => ++clock,
    () => `c${++sequence}`
  );

  repository.appendMessage(message("first", "user", "第一個主題"));
  assert.equal(repository.active.title, "第一個主題");

  const second = repository.create("第二個");
  repository.rename(second.id, "  第二個   對話  ");
  assert.equal(repository.active.title, "第二個 對話");

  repository.setArchived(second.id, true);
  assert.equal(repository.active.id, "c1");
  repository.setArchived(second.id, false);
  repository.select(second.id);
  repository.setThreadId("thread-2");
  assert.equal(repository.active.threadId, "thread-2");

  repository.delete(second.id);
  assert.equal(repository.active.id, "c1");
  assert.equal(loaded.settings.conversations.length, 1);
});

test("bounds persisted visible messages per conversation", () => {
  const loaded = loadPluginSettings(null, { now: () => 1, makeId: () => "bounded" });
  const repository = new ConversationRepository(loaded.settings, () => 2, () => "unused");
  for (let index = 0; index < MAX_MESSAGES_PER_CONVERSATION + 3; index += 1) {
    repository.appendMessage(message(`m${index}`));
  }
  assert.equal(repository.active.messages.length, MAX_MESSAGES_PER_CONVERSATION);
  assert.equal(repository.active.messages[0].id, "m3");
});
