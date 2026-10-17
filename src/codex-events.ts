export type CodexProgressKind = "status" | "command" | "file" | "tool";
export type CodexProgressState = "running" | "success" | "warning" | "error";

export interface CodexProgressEvent {
  kind: CodexProgressKind;
  state: CodexProgressState;
  label: string;
}

export interface ParsedCodexEvent {
  type: string;
  threadId: string | null;
  finalText: string | null;
  errorMessage: string | null;
  progress: CodexProgressEvent | null;
}

type JsonObject = Record<string, unknown>;

export function parseCodexEvent(line: string): ParsedCodexEvent | null {
  if (!line.trim()) return null;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isJsonObject(value)) return null;

  const type = readString(value, "type") ?? "unknown";
  const item = isJsonObject(value.item) ? value.item : null;
  const error = isJsonObject(value.error) ? value.error : null;

  return {
    type,
    threadId: readString(value, "thread_id") ??
      (type === "thread.started" ? readString(value, "threadId") : null),
    finalText: type === "item.completed" && item?.type === "agent_message"
      ? readString(item, "text")
      : null,
    errorMessage: type === "turn.failed" && error ? readString(error, "message") : null,
    progress: progressFor(type, item)
  };
}

function progressFor(type: string, item: JsonObject | null): CodexProgressEvent | null {
  if (type === "turn.started") {
    return { kind: "status", state: "running", label: "Codex 正在处理" };
  }
  if (type === "turn.completed") {
    return { kind: "status", state: "success", label: "Codex 已完成" };
  }
  if (type === "turn.failed") {
    return { kind: "status", state: "error", label: "Codex 执行失败" };
  }
  if (!item || (type !== "item.started" && type !== "item.completed")) return null;

  const itemType = readString(item, "type") ?? "unknown";
  const completed = type === "item.completed";
  const state: CodexProgressState = completed ? "success" : "running";

  if (itemType === "command_execution") {
    const exitCode = readNumber(item, "exit_code");
    const failed = completed && exitCode !== null && exitCode !== 0;
    return {
      kind: "command",
      state: failed ? "error" : state,
      label: failed ? "命令执行失败" : completed ? "命令执行完成" : "正在执行命令"
    };
  }
  if (itemType === "file_change") {
    return { kind: "file", state, label: completed ? "文件变更完成" : "正在处理文件变更" };
  }
  if (itemType === "mcp_tool_call" || itemType === "tool_call") {
    return { kind: "tool", state, label: completed ? "工具执行完成" : "正在使用工具" };
  }
  return null;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: JsonObject, key: string): string | null {
  return typeof value[key] === "string" ? value[key] : null;
}

function readNumber(value: JsonObject, key: string): number | null {
  return typeof value[key] === "number" ? value[key] : null;
}
