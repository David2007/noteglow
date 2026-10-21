import { EditorState, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import { cleanMarkdownSyntax } from "./markdown-colors.ts";

/** 保持 CM 原生语义样式，仅遮住分隔符；光标进入也不展开，Source mode 完全不提供装饰。 */
export function cleanEditorExtension(enabled: (state: EditorState) => boolean): Extension {
  const decorate = (state: EditorState): DecorationSet => enabled(state)
    ? Decoration.set(cleanMarkdownSyntax(state.doc.toString()).ranges.map(({ from, to }) => Decoration.replace({}).range(from, to)), true)
    : Decoration.none;
  const field = StateField.define<{ active: boolean; decorations: DecorationSet }>({
    create: (state) => ({ active: enabled(state), decorations: decorate(state) }),
    update: (value, transaction) => transaction.docChanged || enabled(transaction.state) !== value.active ? { active: enabled(transaction.state), decorations: decorate(transaction.state) } : value,
    provide: (value) => [EditorView.decorations.from(value, (entry) => entry.decorations), EditorView.atomicRanges.of((view) => view.state.field(value).decorations)]
  });
  return [field, EditorState.changeFilter.of((transaction) => {
    if (!transaction.docChanged || !transaction.isUserEvent("delete") || !enabled(transaction.startState) || transaction.startState.selection.ranges.length !== 1 || !transaction.startState.selection.main.empty) return true;
    let allowed = true;
    // 普通 Backspace/Delete 不能无意切掉隐藏分隔符；明确选择或格式命令仍可移除格式。
    transaction.changes.iterChangedRanges((from, to) => transaction.startState.field(field).decorations.between(from, to, (start, end) => { if (from < end && to > start) allowed = false; }));
    return allowed;
  })];
}
