#!/usr/bin/env node

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  prompt += chunk;
});
process.stdin.on("end", () => {
  if (prompt.includes("wait")) {
    setInterval(() => undefined, 1_000);
    return;
  }
  if (prompt.includes("fail")) {
    process.stdout.write(`${JSON.stringify({
      type: "turn.failed",
      error: { message: "deterministic failure" }
    })}\n`);
    process.exitCode = 2;
    return;
  }
  const resumed = process.argv.includes("resume");
  const events = [
    { type: "thread.started", thread_id: resumed ? "thread-resumed" : "thread-new" },
    { type: "turn.started" },
    { type: "item.started", item: { type: "command_execution", command: "secret-command" } },
    { type: "item.completed", item: { type: "command_execution", exit_code: 0 } },
    { type: "item.completed", item: { type: "agent_message", text: resumed ? "已繼續" : "已完成" } },
    { type: "turn.completed" }
  ];
  for (const event of events) process.stdout.write(`${JSON.stringify(event)}\n`);
});
