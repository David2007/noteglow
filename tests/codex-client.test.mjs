import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildCodexArgs, CodexClient } from "../src/codex-client.ts";

const executable = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));

test("streams normalized progress and returns the final response", async () => {
  const client = new CodexClient();
  const progress = [];
  const threads = [];
  const response = await client.send("hello", process.cwd(), settings(null), {
    onThreadId: (threadId) => threads.push(threadId),
    onStatus: () => undefined,
    onProgress: (event) => progress.push(event)
  });

  assert.equal(response, "已完成");
  assert.deepEqual(threads, ["thread-new"]);
  assert.deepEqual(progress.map((event) => event.label), [
    "Codex 正在处理",
    "正在执行命令",
    "命令执行完成",
    "Codex 已完成"
  ]);
  assert.equal(JSON.stringify(progress).includes("secret-command"), false);
  assert.equal(client.running, false);
});

test("uses the resume path when a session id exists", async () => {
  const client = new CodexClient();
  const response = await client.send("continue", process.cwd(), settings("existing"), {
    onThreadId: () => undefined,
    onStatus: () => undefined,
    onProgress: () => undefined
  });
  assert.equal(response, "已繼續");
});

test("never combines explicit sandbox and approve-for-me", () => {
  const writable = buildCodexArgs({
    ...settings(null),
    approveForMe: true,
    sandboxMode: "workspace-write"
  }, "/vault");
  assert.equal(writable.includes("--approve-for-me"), true);
  assert.equal(writable.includes("--sandbox"), false);

  const readOnly = buildCodexArgs({
    ...settings(null),
    approveForMe: true,
    sandboxMode: "read-only"
  }, "/vault");
  assert.equal(readOnly.includes("--approve-for-me"), false);
  assert.deepEqual(readOnly.slice(readOnly.indexOf("--sandbox"), readOnly.indexOf("--sandbox") + 2), [
    "--sandbox",
    "read-only"
  ]);
});

test("surfaces normalized turn failures", async () => {
  const client = new CodexClient();
  await assert.rejects(
    client.send("fail", process.cwd(), settings(null), {
      onThreadId: () => undefined,
      onStatus: () => undefined,
      onProgress: () => undefined
    }),
    /deterministic failure/
  );
  assert.equal(client.running, false);
});

test("stops an active process and remains reusable", async () => {
  const client = new CodexClient();
  const pending = client.send("wait", process.cwd(), settings(null), {
    onThreadId: () => undefined,
    onStatus: () => undefined,
    onProgress: () => undefined
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(client.running, true);
  client.stop();
  await assert.rejects(pending, /已停止/);
  assert.equal(client.running, false);

  const response = await client.send("hello", process.cwd(), settings(null), {
    onThreadId: () => undefined,
    onStatus: () => undefined,
    onProgress: () => undefined
  });
  assert.equal(response, "已完成");
});

function settings(sessionId) {
  return {
    codexPath: executable,
    sandboxMode: "read-only",
    approveForMe: false,
    sessionId,
    model: ""
  };
}

test("passes selected model on new and resumed turns without relaxing the sandbox", () => {
  for (const sessionId of [null, "existing"]) {
    const args = buildCodexArgs({ ...settings(sessionId), model: "gpt-6-luna" }, "/vault");
    assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2), ["--model", "gpt-6-luna"]);
    assert.ok(args.includes("--skip-git-repo-check"));
    assert.equal(args.includes("--dangerously-bypass-approvals-and-sandbox"), false);
    if (sessionId) {
      assert.ok(args.includes('sandbox_mode="read-only"'));
      assert.ok(args.includes('approval_policy="on-request"'));
      assert.ok(args.includes('approvals_reviewer="user"'));
    }
  }
});

test('passes multiple image files in order on new and resumed turns, keeping stdin distinct', () => {
  for (const sessionId of [null, 'existing']) {
    const paths=['/private/tmp/图 1.png','/private/tmp/图 2.jpg'];
    const args=buildCodexArgs({...settings(sessionId),imagePaths:paths},'/vault');
    assert.deepEqual(args.flatMap((value,index)=>value==='--image'?[args[index+1]]:[]),paths);
    assert.deepEqual(args.slice(-2),['--','-']);
    assert.equal(args.includes('--dangerously-bypass-approvals-and-sandbox'),false);
    if(sessionId)assert.ok(args.includes(sessionId));
  }
});
test('rejects invalid image paths before claiming a client request slot', async () => {
  const client=new CodexClient();
  for (const imagePaths of [['relative.png'],['/tmp/a\0.png'],Array(5).fill('/tmp/a.png')]) {
    await assert.rejects(client.send('question',process.cwd(),{...settings(null),imagePaths},{onThreadId(){},onStatus(){},onProgress(){}}),/图片发送路径/);
    assert.equal(client.running,false);
  }
});
