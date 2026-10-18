import type { Conversation } from "./types";

export function searchConversations(
  conversations: readonly Conversation[],
  query: string
): Conversation[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return [...conversations];
  return conversations.filter((conversation) =>
    conversation.title.toLocaleLowerCase().includes(normalized)
      || conversation.messages.some(({ text }) => text.toLocaleLowerCase().includes(normalized))
  );
}

export function exportConversationMarkdown(conversation: Conversation, exportedAt = Date.now()): string {
  const lines = [
    `# ${conversation.title}`,
    "",
    `> 导出自 Codex 笔记助手：${new Date(exportedAt).toISOString()}`,
    ""
  ];
  for (const message of conversation.messages) {
    lines.push(
      `## ${roleLabel(message.role)} — ${new Date(message.createdAt).toISOString()}`,
      "",
      message.text,
      ""
    );
    // 聊天中折叠显示的引用在导出中保留完整快照，保证回答依据可追溯。
    for (const attachment of message.attachments ?? []) {
      const location = attachment.startLine ? `（第 ${attachment.startLine}–${attachment.endLine ?? attachment.startLine} 行）` : "";
      lines.push(`引用：${attachment.path}${location}`, "", ...attachment.content.split("\n").map((line) => `> ${line}`), "");
    }
    for (const image of message.images ?? []) {
      // 图片仍保存在当前 Vault 的插件私有目录，导出不复制二进制或泄露原文件的绝对路径。
      lines.push(`图片附件：${image.name.replace(/[\r\n]/g, " ")}（${image.width}×${image.height}，SHA256 ${image.sha256}；原图请在 NoteGlow 对话中查看）`, "");
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function safeExportBasename(title: string): string {
  return title
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|#^[\]]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.+$/g, "")
    .slice(0, 80) || "Codex 对话";
}

function roleLabel(role: "user" | "assistant" | "system"): string {
  if (role === "user") return "你";
  if (role === "assistant") return "Codex";
  return "系统";
}
