import { randomUUID } from "node:crypto";
import { type ContextAttachment, validateAttachments } from "./context.ts";

export function splitLegacyDraft(text: string): { draftText: string; attachments: ContextAttachment[] } {
  const headers = [...text.matchAll(/^选区来源：([^\n]+)\n/gm)];
  if (!headers.length) return { draftText: text, attachments: [] };
  const attachments: ContextAttachment[] = [];
  for (let index = 0; index < headers.length; index++) {
    const header = headers[index];
    const end = headers[index + 1]?.index ?? text.length;
    const section = text.slice((header.index ?? 0) + header[0].length, end).replace(/\n+$/, "");
    const lines = section.split("\n");
    // 只识别旧插件生成的精确格式；有额外文字时保留整份草稿，不猜测或丢掉内容。
    if (!lines.length || lines.some((line) => !line.startsWith("> "))) return { draftText: text, attachments: [] };
    attachments.push({ id: randomUUID(), kind: "selection", path: header[1], content: lines.map((line) => line.slice(2)).join("\n") });
  }
  if (validateAttachments(attachments)) return { draftText: text, attachments: [] };
  return { draftText: text.slice(0, headers[0].index).replace(/\n+$/, ""), attachments };
}
