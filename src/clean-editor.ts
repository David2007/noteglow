import { EditorState, Prec, StateField, Transaction, type Extension } from "@codemirror/state";
import { Decoration, EditorView, keymap, type DecorationSet } from "@codemirror/view";
import { isolateHistory } from "@codemirror/commands";
import { cleanMarkdownSyntax } from "./markdown-colors.ts";

/** 保持 CM 原生语义样式，仅遮住分隔符；光标进入也不展开，Source mode 完全不提供装饰。 */
export function cleanEditorExtension(enabled: (state: EditorState) => boolean): Extension {
  const decorate = (state: EditorState): { decorations: DecorationSet; atomic: DecorationSet } => {
    if (!enabled(state)) return { decorations: Decoration.none, atomic: Decoration.none };
    const syntax = cleanMarkdownSyntax(state.doc.toString());
    // 宿主会在活动行移除嵌套引用 widget；由同一个 AST 提供固定 gutter，避免焦点改变层级外观。
    const replacements = syntax.ranges.map(({ from, to }) => Decoration.replace({}).range(from, to));
    return { atomic: Decoration.set(replacements, true), decorations: Decoration.set([
      ...replacements,
      ...syntax.quoteLines.map(({ from, depth }) => Decoration.line({ attributes: {
        class: "noteglow-quote-line",
        style: `--noteglow-quote-depth: ${depth}`
      } }).range(from))
    ], true) };
  };
  const field = StateField.define<{ active: boolean; decorations: DecorationSet; atomic: DecorationSet }>({
    create: (state) => ({ active: enabled(state), ...decorate(state) }),
    update: (value, transaction) => transaction.docChanged || enabled(transaction.state) !== value.active ? { active: enabled(transaction.state), ...decorate(transaction.state) } : value,
    provide: (value) => [EditorView.decorations.from(value, (entry) => entry.decorations), EditorView.atomicRanges.of((view) => view.state.field(value).atomic)]
  });
  return [field, Prec.highest(keymap.of([{ key: "Backspace", run: (view) => {
    const { state } = view, selection = state.selection;
    if (!enabled(state) || view.composing || state.readOnly || selection.ranges.length !== 1 || !selection.main.empty) return false;
    const cursor = selection.main.head, line = state.doc.lineAt(cursor);
    const syntax = cleanMarkdownSyntax(state.doc.toString());
    const prefixes = syntax.quotes.filter((range) => range.from >= line.from && range.to <= line.to).sort((a, b) => b.from - a.from);
    const prefix = prefixes[0], firstPrefix = prefixes.at(-1);
    if (!prefix || !firstPrefix) return false;
    // 列表等容器的可见前缀不属于引用；在其前方退格仍交还宿主。
    if (cursor < firstPrefix.from && state.sliceDoc(line.from, firstPrefix.from).trim()) return false;
    // 仅在引用正文起点退一层：空白和隐藏的加粗等开标记不算正文，正文字符不能被吞掉。
    let visible = cursor > prefix.to ? state.sliceDoc(prefix.to, cursor) : "";
    for (const range of [...syntax.ranges].reverse()) {
      const from = Math.max(prefix.to, range.from), to = Math.min(cursor, range.to);
      if (from < to) visible = visible.slice(0, from - prefix.to) + visible.slice(to - prefix.to);
    }
    if (visible.trim()) return false;
    // 后续行直接去掉 > 仍会被 Markdown 视为上一段引用的懒延续。
    // 用仅保留外层前缀的空行结束当前层，才能真正降低显示层级；其它行原文不动。
    const separator = prefix.blockFrom < line.from ? state.sliceDoc(line.from, prefix.from) + "\n" : "";
    view.dispatch({
      changes: [
        ...(separator ? [{ from: line.from, insert: separator }] : []),
        { from: prefix.from, to: prefix.to }
      ],
      selection: { anchor: Math.max(prefix.from, cursor - (prefix.to - prefix.from)) + separator.length },
      annotations: [Transaction.userEvent.of("input.noteglow-quote"), isolateHistory.of("full")],
      scrollIntoView: true
    });
    return true;
  } }])), EditorState.changeFilter.of((transaction) => {
    if (!transaction.docChanged || !transaction.isUserEvent("delete") || !enabled(transaction.startState) || transaction.startState.selection.ranges.length !== 1 || !transaction.startState.selection.main.empty) return true;
    let allowed = true;
    // 普通 Backspace/Delete 不能无意切掉隐藏分隔符；明确选择或格式命令仍可移除格式。
    transaction.changes.iterChangedRanges((from, to) => transaction.startState.field(field).atomic.between(from, to, (start, end) => { if (from < end && to > start) allowed = false; }));
    return allowed;
  })];
}
