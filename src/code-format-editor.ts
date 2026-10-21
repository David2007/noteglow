import { Transaction, type Extension } from "@codemirror/state";
import { isolateHistory } from "@codemirror/commands";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { scanNativeCode } from "./native-code-colors.ts";
import { findFormatTarget, formattedEdit } from "./code-format.ts";
import { formatCode, type FormatterSettings, type FormatResult } from "./code-formatters.ts";

export interface CodeFormatOptions {
  settings(): FormatterSettings & { autoFormatCode: boolean };
  path(view: EditorView): string | null;
  format?: typeof formatCode;
  report?(result: FormatResult["status"] | "skipped"): void;
}

/** 每个视图独立持有一次格式化任务；任何后续编辑、选区或焦点变化都取消旧快照。 */
export function codeFormatExtension(options: CodeFormatOptions): Extension {
  return ViewPlugin.fromClass(class {
    view: EditorView;
    pending: AbortController | null = null;
    destroyed = false;
    constructor(view: EditorView) { this.view = view; }
    update(update: ViewUpdate): void {
      if (update.docChanged || update.selectionSet || update.focusChanged) this.cancel();
      if (!update.transactions.some((transaction) => transaction.isUserEvent("input.paste"))) return;
      const view = this.view, state = view.state, settings = options.settings();
      if (!settings.autoFormatCode || state.readOnly || view.composing || !view.hasFocus || state.selection.ranges.length !== 1 || !state.selection.main.empty) return;
      let from = Infinity, to = -1, oldFrom = Infinity, oldTo = -1;
      update.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
        oldFrom = Math.min(oldFrom, fromA); oldTo = Math.max(oldTo, toA);
        from = Math.min(from, fromB); to = Math.max(to, toB);
      });
      // 替换跨块选区后可能恰好剩一个合法块，因此前后快照都必须证明同一正文边界。
      const original = scanNativeCode(update.startState.doc.toString()).find((block) => block.supported && block.status === "none" && oldFrom >= block.codeFrom && oldTo <= block.codeTo);
      if (!original) { options.report?.("skipped"); return; }
      const target = findFormatTarget(state.doc.toString(), from, to), path = options.path(view);
      if (!target || !path || target.block.from !== update.changes.mapPos(original.from, 1) || target.block.opening !== original.opening || target.block.codeTo !== update.changes.mapPos(original.codeTo, 1)) { options.report?.("skipped"); return; }
      const controller = new AbortController(); this.pending = controller;
      // 离开 ViewPlugin.update 后再处理结果，禁止在 CM 更新中重入 dispatch。
      void Promise.resolve().then(() => (options.format ?? formatCode)(target.language, target.block.code, settings, controller.signal)).then((result) => {
        if (this.destroyed || controller.signal.aborted || this.pending !== controller) return;
        this.pending = null;
        if (view.state.doc !== state.doc || !view.state.selection.eq(state.selection) || view.state.readOnly || !view.hasFocus || view.composing || options.path(view) !== path || !options.settings().autoFormatCode) return;
        options.report?.(result.status);
        if (result.status !== "formatted") return;
        const edit = formattedEdit(target, result.code);
        if (!edit) return;
        view.dispatch({ changes: { from: edit.from, to: edit.to, insert: edit.insert }, selection: { anchor: edit.cursor }, annotations: [Transaction.userEvent.of("input.noteglow-format"), isolateHistory.of("full")] });
      }).catch(() => { if (!controller.signal.aborted) options.report?.("invalid"); });
    }
    cancel(): void { this.pending?.abort(); this.pending = null; }
    destroy(): void { this.destroyed = true; this.cancel(); }
  }, { eventHandlers: { blur() { this.cancel(); } } });
}
