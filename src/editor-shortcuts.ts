import { Prec, Transaction } from "@codemirror/state";
import { isolateHistory } from "@codemirror/commands";
import { EditorView, keymap } from "@codemirror/view";
import { isPlainMarkdownLine } from "./markdown-colors.ts";

export interface SlashEdit { from: number; to: number; insert: string; cursor: number }

/** 完整独立行加 Enter 才提交；普通段落两侧补空行，防止表格吞并相邻正文。 */
export function slashCommandEdit(text: string, cursor: number): SlashEdit | null {
  if (!Number.isInteger(cursor) || cursor < 0 || cursor > text.length || text.length > 1_000_000) return null;
  const from = text.lastIndexOf("\n", cursor - 1) + 1;
  const newline = text.indexOf("\n", cursor);
  const to = newline < 0 ? text.length : newline;
  const line = text.slice(from, to).replace(/\r$/, "");
  if (cursor !== from + line.length || !/^ {0,3}\/(code|bg|h[1-6])$/.test(line)) return null;
  const commandFrom = from + line.indexOf("/");
  try { if (!isPlainMarkdownLine(text, commandFrom, from + line.length)) return null; }
  catch { return null; }
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const before = text.slice(0, from);
  const after = newline < 0 ? "" : text.slice(newline + 1);
  const prefix = before && !/(?:\r?\n){2}$/.test(before) ? eol : "";
  const suffix = after && !/^\r?\n/.test(after) ? eol : "";
  const heading = /\/h([1-6])$/.exec(line);
  if (heading) {
    // 复用独立行保护与撤销事务；光标留在标题前缀后，继续输入标题正文。
    const marker = "#".repeat(Number(heading[1])) + " ";
    return { from, to: from + line.length, insert: prefix + marker + suffix, cursor: from + prefix.length + marker.length };
  }
  const code = line.endsWith("/code");
  const block = code ? ["```", "", "```"].join(eol) : ["| 标题 1 | 标题 2 |", "| --- | --- |", "|  |  |", "|  |  |"].join(eol);
  return { from, to: from + line.length, insert: prefix + block + suffix, cursor: from + prefix.length + (code ? 3 + eol.length : 2) };
}

/** 高优先级只消费匹配命令；IME、修饰键、只读及多选区继续走 Obsidian 原有 Enter。 */
export function expandSlashCommand(view: EditorView): boolean {
  const selection = view.state.selection;
  if (view.composing || view.state.readOnly || selection.ranges.length !== 1 || !selection.main.empty) return false;
  const edit = slashCommandEdit(view.state.doc.toString(), selection.main.head);
  if (!edit) return false;
  view.dispatch({
    changes: { from: edit.from, to: edit.to, insert: edit.insert },
    selection: { anchor: edit.cursor },
    annotations: [Transaction.userEvent.of("input.noteglow-slash"), isolateHistory.of("full")],
    scrollIntoView: true
  });
  return true;
}

export const slashCommandExtension = Prec.highest(keymap.of([{ key: "Enter", run: expandSlashCommand }]));
