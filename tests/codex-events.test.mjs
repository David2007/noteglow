import assert from "node:assert/strict";
import test from "node:test";
import { parseCodexEvent } from "../src/codex-events.ts";

test("parses thread and final assistant events", () => {
  const thread = parseCodexEvent('{"type":"thread.started","thread_id":"abc"}');
  const message = parseCodexEvent(
    '{"type":"item.completed","item":{"type":"agent_message","text":"完成"}}'
  );
  assert.equal(thread?.threadId, "abc");
  assert.equal(message?.finalText, "完成");
  assert.equal(message?.progress, null);
});

test("normalizes safe progress without exposing command payloads", () => {
  const event = parseCodexEvent(
    '{"type":"item.started","item":{"type":"command_execution","command":"print-secret"}}'
  );
  assert.deepEqual(event?.progress, {
    kind: "command",
    state: "running",
    label: "正在执行命令"
  });
  assert.equal(JSON.stringify(event).includes("print-secret"), false);
});

test("classifies failed commands and turn errors", () => {
  const command = parseCodexEvent(
    '{"type":"item.completed","item":{"type":"command_execution","exit_code":2}}'
  );
  const turn = parseCodexEvent(
    '{"type":"turn.failed","error":{"message":"failure detail"}}'
  );
  assert.equal(command?.progress?.state, "error");
  assert.equal(turn?.errorMessage, "failure detail");
  assert.equal(turn?.progress?.label, "Codex 执行失败");
});

test("ignores malformed input and preserves unknown events safely", () => {
  assert.equal(parseCodexEvent("not-json"), null);
  const unknown = parseCodexEvent('{"type":"future.event","secret":"hidden"}');
  assert.equal(unknown?.type, "future.event");
  assert.equal(unknown?.progress, null);
  assert.equal(JSON.stringify(unknown).includes("hidden"), false);
});
