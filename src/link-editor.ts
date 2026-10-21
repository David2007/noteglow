import { MarkdownView, Modal, Notice, Plugin, Setting, type Editor } from "obsidian";
import { type EditorView } from "@codemirror/view";
import { Transaction } from "@codemirror/state";
import { isolateHistory } from "@codemirror/commands";
import { cleanMarkdownSyntax, markdownLinkAddress, type MarkdownInlineLink } from "./markdown-colors.ts";

function currentLink(editor: Editor): { link: MarkdownInlineLink; source: string } | undefined {
  const at = editor.posToOffset(editor.getCursor());
  const source = editor.getValue();
  const link = cleanMarkdownSyntax(source).links.find((link) => at >= link.from && at <= link.to);
  return link ? { link, source } : undefined;
}

/** 地址编辑保留原标签和可选 title；弹窗期间有任何正文/文件变化就拒绝旧快照写入。 */
export function registerLinkEditor(plugin: Plugin): void {
  const modals = new Set<Modal>();
  plugin.register(() => { for (const modal of modals) modal.close(); modals.clear(); });
  const open = (editor: Editor, view: MarkdownView, target: { link: MarkdownInlineLink; source: string }): void => {
    const { source, link } = target;
    if (editor.getValue() !== source) { new Notice("笔记已改变，请重新打开链接编辑。"); return; }
    const file = view.file, path = file?.path;
    let value = link.url;
    const modal = new Modal(plugin.app);
    modal.setTitle("编辑链接地址");
    new Setting(modal.contentEl).setName("链接地址")
      .setDesc("单个地址，最多 8192 字符；保存时整体校验，不接受换行或尖括号。示例：https://example.com/docs")
      .addText((input) => input.setValue(value).onChange((next) => { value = next; }));
    new Setting(modal.contentEl).addButton((button) => button.setButtonText("保存").setCta().onClick(() => {
      const address = markdownLinkAddress(value);
      if (!address) { new Notice("请输入不含换行或尖括号的单个链接地址（最多 8192 字符）。"); return; }
      const cm = (editor as unknown as { cm?: EditorView }).cm;
      if (!cm || cm.state.readOnly || view.getMode() !== "source" || view.file !== file || view.file?.path !== path || editor.getValue() !== source || cm.state.doc.toString() !== source || !plugin.app.workspace.getLeavesOfType("markdown").some((leaf) => leaf.view === view)) {
        new Notice("笔记已改变、关闭或只读，请重新打开链接编辑。"); return;
      }
      cm.dispatch({ changes: { from: link.addressFrom, to: link.addressTo, insert: address }, annotations: [Transaction.userEvent.of("input.noteglow-link"), isolateHistory.of("full")] });
      modal.close();
    }));
    modals.add(modal);
    modal.onClose = () => { modals.delete(modal); };
    modal.open();
  };
  plugin.addCommand({ id: "edit-current-link-address", name: "编辑当前位置链接地址", editorCheckCallback: (checking, editor, view) => {
    const link = currentLink(editor);
    if (!(view instanceof MarkdownView) || !link) return false;
    if (!checking) open(editor, view, link);
    return true;
  } });
  plugin.registerEvent(plugin.app.workspace.on("editor-menu", (menu, editor, view) => {
    if (!(view instanceof MarkdownView)) return;
    const link = currentLink(editor);
    if (link) menu.addItem((item) => item.setTitle("编辑链接地址").setIcon("link").onClick(() => open(editor, view, link)));
  }));
}
