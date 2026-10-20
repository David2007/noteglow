import { fromMarkdown } from "mdast-util-from-markdown";
import type { Editor } from "obsidian";
import { Transaction } from "@codemirror/state";
import { isolateHistory } from "@codemirror/commands";
import type { EditorView } from "@codemirror/view";

export function replyTargetAvailable(view: { file: unknown; getMode(): string; editor: Editor } | null, open: boolean, unloaded: boolean): boolean {
  if (unloaded || !view?.file || !open || view.getMode() !== "source") return false;
  const cm = (view.editor as unknown as { cm?: { state: { readOnly: boolean } } }).cm;
  return !cm?.state.readOnly;
}

/** 只读取 Markdown 代码节点；不从高亮后的 DOM 提取，避免混入复制按钮等插件文字。 */
export function replyCodeBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  function visit(node: { type: string; value?: string; children?: unknown[] }): void {
    if (node.type === "code") blocks.push(node.value ?? "");
    for (const child of node.children ?? []) visit(child as Parameters<typeof visit>[0]);
  }
  visit(fromMarkdown(markdown));
  return blocks;
}

/** 在选区活动端插入，并显式隔离前后输入；单个 transaction 本身不能保证独立撤销。 */
export function insertReplyCode(editor: Editor, code: string): void {
  if (!code) throw new Error("代码块为空，未插入。");
  const cm = (editor as unknown as { cm?: EditorView }).cm;
  // Obsidian 桌面编辑器使用 CM6。旧宿主无法提供历史隔离时拒绝写入，
  // 避免降级 transaction 将用户刚输入的文字和 Apply 合并撤销。
  if (!cm?.state || typeof cm.dispatch !== "function") throw new Error("当前编辑器不支持独立撤销，请更新 Obsidian 后重试。");
  if (cm.state.readOnly) throw new Error("当前笔记为只读，未插入。");
  const cursor = cm.state.selection.main.head;
  cm.dispatch({
    changes: { from: cursor, to: cursor, insert: code },
    selection: { anchor: cursor + cm.state.toText(code).length },
    annotations: [Transaction.userEvent.of("input.noteglow-apply"), isolateHistory.of("full")],
    scrollIntoView: true
  });
  editor.focus();
}

export interface ReplyActionOptions {
  body: HTMLElement;
  header: HTMLElement;
  markdown: string;
  active: () => boolean;
  copy: (text: string) => Promise<void>;
  apply: (code: string) => void;
  notice: (message: string) => void;
}

/** 生命周期由消息 DOM 所有：切换对话后旧按钮即使被调用也不能写入笔记。 */
export function addReplyActions(options: ReplyActionOptions): void {
  const { body, header, markdown } = options;
  const button = (parent: HTMLElement, text: string, label: string, action: () => void | Promise<void>, success: string): void => {
    const el = parent.ownerDocument.createElement("button");
    el.type = "button"; el.className = "codex-notes-reply-action"; el.textContent = text;
    el.setAttribute("aria-label", label); el.title = label;
    parent.appendChild(el);
    el.addEventListener("click", async () => {
      if (el.disabled || !el.isConnected || !options.active()) return;
      el.disabled = true;
      try { await action(); options.notice(success); }
      catch (error) { options.notice(error instanceof Error ? error.message : "操作失败，请重试。"); }
      finally { el.disabled = false; }
    });
  };
  button(header, "Copy", "复制整条 Codex 回复（Markdown）", () => options.copy(markdown), "已复制整条回复。");
  const blocks = replyCodeBlocks(markdown);
  for (const codeEl of Array.from(body.querySelectorAll("pre > code"))) {
    // 渲染器通常额外添加一个末尾换行。仅匹配确切代码内容，特殊渲染器不匹配时不冒险插入。
    const rendered = (codeEl.textContent ?? "").replace(/\r\n?/g, "\n");
    const matches = blocks.filter((code) => rendered === code || rendered === `${code}\n`);
    // 图形等特殊渲染可能省略 pre，末尾换行又可能由渲染器添加；
    // 多个不同原文均能匹配时不能靠顺序猜测，否则可能插入相邻代码块的额外换行。
    if (new Set(matches).size !== 1) continue;
    const index = blocks.indexOf(matches[0]);
    const [code] = blocks.splice(index, 1);
    const toolbar = body.ownerDocument.createElement("div");
    toolbar.className = "codex-notes-code-actions";
    codeEl.parentElement!.before(toolbar);
    button(toolbar, "Apply", "将此代码插入笔记光标位置", () => options.apply(code), "已插入代码，可撤销。");
  }
}
