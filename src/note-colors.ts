import { editorInfoField, editorLivePreviewField, MarkdownRenderChild, MarkdownView, Notice, normalizePath, Plugin, TFile, type Editor, type MarkdownPostProcessorContext } from "obsidian";
import { StateEffect } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { alignRenderedText, mapColorRanges, normalizeColor, parseLastColors, parseNoteColors, projectMarkdown, relocateColorRanges, type ColoredNote, type ColorProperty, type ColorRange, type NoteColorsData } from "./color-ranges";
import { applyMarkdownColor, formatMarkdownSelection, mapRenderedCodeAtPosition, mapRenderedCodeSelection, decodeOwnedCodeBlocks, type PortableColorEdit } from "./markdown-colors";
import { readCodeDomSelection } from "./rendered-code-selection";
import { createColorPicker } from "./color-picker";
import { applyNativeCodeColor, backupNativeCodeMigration, createNativeMetadataField, mapMigratedCodePosition, migrateOwnedCodeToNative, minimalTextChange, nativeCodeColorTransactions, paintNativeCodeElement, scanNativeCode } from "./native-code-colors";

const refreshColors = StateEffect.define<void>();
interface WriteChannel { queue: Promise<void> }
// Obsidian 重载插件会重建模块。进程内按 adapter/文件共用串行通道，下一实例先等旧实例收尾。
const writeChannelsKey = Symbol.for("codex-notes.note-colors.write-channels");
const sharedState = globalThis as unknown as Record<symbol, unknown>;
const writeChannels = (sharedState[writeChannelsKey] ??= new WeakMap<object, Map<string, WriteChannel>>()) as WeakMap<object, Map<string, WriteChannel>>;
const foregroundColors = ["#c0392b", "#d35400", "#8e6b00", "#1d7044", "#2167a8", "#7030a0", "#202020"];
const backgroundColors = ["#fff88f", "#ffd6d6", "#ffe1b3", "#d6edcd", "#cde6ff", "#e6d5ff", "#eeeeee"];
interface ColorSelection { path: string; text: string; from: number; to: number; editor: Editor; view: MarkdownView }
interface EditColorSnapshot extends ColoredNote { sequence: number; bytes: number }
const MAX_EDIT_SNAPSHOTS_PER_NOTE = 32;
const MAX_EDIT_SNAPSHOT_BYTES = 4 * 1024 * 1024;

export async function registerNoteColors(plugin: Plugin): Promise<void> {
  const colors = new NoteColorController(plugin);
  await colors.load();
  colors.register();
}

class NoteColorController {
  private data: NoteColorsData = { version: 1, notes: Object.create(null) as NoteColorsData["notes"] };
  private enabled = true;
  private disposed = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private revision = 0;
  private readonly readTickets = new Map<string, number>();
  private readonly editSnapshots = new Map<string, EditColorSnapshot[]>();
  private editSnapshotBytes = 0;
  private snapshotSequence = 0;
  private readonly channel: WriteChannel;
  private readonly editors = new Set<EditorView>();
  private readonly readers = new Set<ColoredSection>();
  private readonly filename: string;
  private lastColorStyle: HTMLStyleElement | null = null;
  private readonly preferenceSequence: Record<ColorProperty, number> = { foreground: 0, background: 0 };
  private readonly applyingPaths = new Set<string>();
  private readonly renderedCode = new WeakMap<HTMLElement, { path: string; text: string; from: number; to: number }>();
  private codeToolbar: HTMLElement | null = null;
  private colorPicker: { close(): void } | null = null;

  constructor(private readonly plugin: Plugin) {
    this.filename = normalizePath(`${plugin.manifest.dir ?? `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}`}/note-colors.json`);
    const adapter = plugin.app.vault.adapter;
    let files = writeChannels.get(adapter);
    if (!files) { files = new Map(); writeChannels.set(adapter, files); }
    let channel = files.get(this.filename);
    if (!channel) { channel = { queue: Promise.resolve() }; files.set(this.filename, channel); }
    this.channel = channel;
  }

  async load(): Promise<void> {
    try {
      // 等待中旧实例可能因失败追加纠正快照；通道稳定后再读，不能只等最初那一项。
      let pending = this.channel.queue;
      for (;;) {
        await pending.catch(() => undefined);
        if (pending === this.channel.queue) break;
        pending = this.channel.queue;
      }
      if (await this.plugin.app.vault.adapter.exists(this.filename)) this.data = parseNoteColors(JSON.parse(await this.plugin.app.vault.adapter.read(this.filename)));
      // 只核验已有颜色记录指向的文件，不扫描 Vault。外部修改不直接沿用旧 offset。
      for (const [path, note] of Object.entries(this.data.notes)) {
        const file = this.plugin.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) continue;
        // 重载时 autosave 可能尚未写入磁盘；公开编辑视图的完整正文优先。
        const openView = this.plugin.app.workspace.getLeavesOfType("markdown").map((leaf) => leaf.view).find((view): view is MarkdownView => view instanceof MarkdownView && view.file?.path === path);
        const text = openView ? openView.editor.getValue() : await this.plugin.app.vault.cachedRead(file);
        if (text !== note.text) { this.data.notes[path] = { text, ranges: relocateColorRanges(note, text) }; this.changed(); }
      }
    } catch (error) {
      this.enabled = false;
      new Notice(`无法读取颜色记录，已暂停颜色功能；不会覆盖现有数据。${errorText(error)}`, 10_000);
    }
  }

  register(): void {
    const plugin = this.plugin;
    const owner = this;
    plugin.registerEditorExtension(nativeCodeColorTransactions);
    plugin.registerEditorExtension(createNativeMetadataField((state) => state.field(editorLivePreviewField, false) === true));
    plugin.registerEditorExtension(ViewPlugin.fromClass(class {
      decorations: DecorationSet;
      constructor(readonly view: EditorView) { owner.editors.add(view); this.decorations = owner.decorations(view); }
      update(update: ViewUpdate): void {
        if (update.docChanged) { owner.hideCodeToolbar(); owner.closeColorPicker(); owner.scheduleRefresh(); }
        const path = editorPath(update.view);
        const previousPath = update.startState.field(editorInfoField, false)?.file?.path;
        if (update.docChanged && path && path === previousPath) owner.documentChanged(path, update.startState.doc.toString(), update.state.doc.toString(), (position, association) => update.changes.mapPos(position, association), update.transactions.some((transaction) => transaction.isUserEvent("undo") || transaction.isUserEvent("redo")));
        if (update.docChanged || path !== previousPath || update.transactions.some((transaction) => transaction.effects.some((effect) => effect.is(refreshColors)))) this.decorations = owner.decorations(update.view);
      }
      destroy(): void { owner.editors.delete(this.view); }
    }, { decorations: (instance) => instance.decorations }));

    plugin.registerMarkdownPostProcessor(async (el, context) => {
      if (!owner.enabled || owner.disposed) return;
      owner.bindRenderedCode(el, context);
      const file = plugin.app.vault.getAbstractFileByPath(context.sourcePath);
      if (!(file instanceof TFile)) return;
      if (owner.data.notes[context.sourcePath]) {
        try { await owner.readExternal(file); } catch { return; }
      }
      if (owner.disposed) return;
      const source = await plugin.app.vault.cachedRead(file);
      if (!owner.disposed) context.addChild(new ColoredSection(el, context, owner, source));
    }, 100);

    plugin.registerDomEvent(document, "selectionchange", () => owner.showCodeToolbar());
    plugin.registerDomEvent(document, "scroll", () => { owner.hideCodeToolbar(); owner.closeColorPicker(); }, true);
    plugin.registerDomEvent(window, "resize", () => { owner.hideCodeToolbar(); owner.closeColorPicker(); });
    plugin.registerDomEvent(document, "keydown", (event) => { if (event.key === "Escape") owner.hideCodeToolbar(); });
    plugin.registerEvent(plugin.app.workspace.on("active-leaf-change", () => { owner.hideCodeToolbar(); owner.closeColorPicker(); }));
    plugin.addCommand({ id: "restore-native-code-blocks", name: "恢复当前笔记的原生代码块", editorCallback: (_editor, info) => {
      if (!(info instanceof MarkdownView)) return;
      void owner.restoreNativeCode(info).catch((error: unknown) => new Notice(errorText(error), 10000));
    } });

    for (const [id, name, property, picker] of [
      ["change-font-color", "字体颜色", "foreground", false],
      ["change-background-color", "背景颜色", "background", false],
      ["pick-font-color", "更换字体颜色", "foreground", true],
      ["pick-background-color", "更换背景颜色", "background", true],
      ["clear-selection-colors", "清除选区颜色", undefined, false]
    ] as const) {
      plugin.addCommand({ id, name, editorCallback: (editor, info) => {
        if (!(info instanceof MarkdownView)) { new Notice("请在笔记编辑视图中选择文字。"); return; }
        const selection = owner.captureSelection(editor, info);
        if (!selection) return;
        if (property && picker) owner.openColorPicker(selection, property);
        else void owner.apply(selection, property, property ? owner.lastColor(property) : undefined).catch((error: unknown) => new Notice(errorText(error), 8000));
      } });
    }
    for (const [id, name, format, modifiers, key] of [
      ["toggle-bold", "加粗", "bold", ["Mod"], "B"],
      ["toggle-italic", "斜体", "italic", ["Mod"], "I"],
      ["toggle-code", "行内代码", "code", ["Mod", "Shift"], "C"]
    ] as const) {
      plugin.addCommand({ id, name, hotkeys: [{ modifiers: [...modifiers], key }], editorCallback: (editor, info) => {
        if (!(info instanceof MarkdownView)) { new Notice("请在笔记编辑视图中选择文字。"); return; }
        const selection = owner.captureSelection(editor, info);
        if (!selection) return;
        void owner.format(selection, format).catch((error: unknown) => new Notice(errorText(error), 8000));
      } });
    }
    plugin.registerEvent(plugin.app.vault.on("modify", (file) => {
      if (!(file instanceof TFile) || !this.data.notes[file.path] || this.disposed) return;
      void this.readExternal(file).then(() => {
        if (this.disposed) return;
        this.scheduleRefresh();
      }).catch(() => { /* 读取失败保持旧快照；渲染器拒绝不能核验的范围。 */ });
    }));
    plugin.registerEvent(plugin.app.vault.on("rename", (file, oldPath) => {
      if (this.disposed || !this.enabled) return;
      const moved: Array<[string, string]> = [];
      for (const path of Object.keys(this.data.notes)) if (path === oldPath || path.startsWith(`${oldPath}/`)) moved.push([path, file.path + path.slice(oldPath.length)]);
      for (const [from, to] of moved) {
        this.data.notes[to] = this.data.notes[from]; delete this.data.notes[from];
        const history = this.editSnapshots.get(from);
        if (history) { this.dropEditSnapshots(to); this.editSnapshots.set(to, history); this.editSnapshots.delete(from); }
      }
      if (moved.length) { this.changed(); this.scheduleSave(); this.scheduleRefresh(); }
    }));
    plugin.registerEvent(plugin.app.vault.on("delete", (file) => {
      if (this.disposed || !this.enabled) return;
      let removed = false;
      for (const path of Object.keys(this.data.notes)) if (path === file.path || path.startsWith(`${file.path}/`)) { delete this.data.notes[path]; this.dropEditSnapshots(path); removed = true; }
      if (removed) { this.changed(); this.scheduleSave(); this.scheduleRefresh(); }
    }));
    const style = document.createElement("style");
    style.dataset.codexNoteColors = plugin.manifest.id;
    style.textContent = ".codex-notes-color-foreground,.codex-notes-color-foreground *{color:var(--codex-note-foreground)!important}.codex-notes-color-background{background-color:var(--codex-note-background)!important;border-radius:2px}";
    document.head.appendChild(style);
    // 只通过可卸载 stylesheet 发布色条变量，不写 document/body 的持久 inline style。
    this.lastColorStyle = document.createElement("style");
    this.lastColorStyle.dataset.codexNoteLastColors = plugin.manifest.id;
    this.syncLastColorStyle();
    document.head.appendChild(this.lastColorStyle);
    plugin.register(() => {
      this.disposed = true;
      this.hideCodeToolbar(); this.closeColorPicker();
      if (this.saveTimer) clearTimeout(this.saveTimer);
      if (this.refreshTimer) clearTimeout(this.refreshTimer);
      for (const reader of this.readers) reader.unload();
      this.readers.clear(); this.editors.clear(); style.remove();
      this.lastColorStyle?.remove(); this.lastColorStyle = null;
      this.editSnapshots.clear(); this.editSnapshotBytes = 0;
      if (this.enabled && this.dirty) void this.save(true).catch((error: unknown) => new Notice(`关闭时保存颜色记录失败：${errorText(error)}`, 8000));
      // 未开始的普通旧写取消；最后快照沿共用队列收尾，新实例 load 等待它完成。
    });
  }

  private hideCodeToolbar(): void { this.codeToolbar?.remove(); this.codeToolbar = null; }

  private closeColorPicker(): void { this.colorPicker?.close(); this.colorPicker = null; }

  private openColorPicker(selection: ColorSelection, property: ColorProperty, anchor?: { left: number; top: number; bottom: number }): void {
    this.closeColorPicker(); this.hideCodeToolbar();
    if (!anchor) {
      const editor = Array.from(this.editors).find((item) => selection.view.containerEl.contains(item.dom) && editorPath(item) === selection.path && item.state.doc.toString() === selection.text);
      anchor = editor?.coordsAtPos(selection.to) ?? selection.view.containerEl.getBoundingClientRect();
    }
    this.colorPicker = createColorPicker({
      document: selection.view.containerEl.ownerDocument,
      anchor,
      label: property === "foreground" ? "字体颜色" : "背景颜色",
      colors: property === "foreground" ? foregroundColors : backgroundColors,
      initialColor: this.lastColor(property),
      apply: (color) => this.apply(selection, property, color),
      // 写入事务会关闭旧选区浮层；其后保存失败仍须提醒，不能吞掉失败。
      failedAfterClose: (error) => new Notice(errorText(error), 8000),
      cancelledByEscape: () => {
        if (selection.view.containerEl.isConnected && selection.view.file?.path === selection.path && selection.view.getMode() === "source" && this.plugin.app.workspace.getActiveViewOfType(MarkdownView) === selection.view) selection.view.editor.focus();
      },
      closed: () => { this.colorPicker = null; }
    });
  }

  /** section 快照在渲染时绑定；相同代码重复出现也只使用当前 section 的绝对位置。 */
  bindRenderedCode(el: HTMLElement, context: MarkdownPostProcessorContext): void {
    const blocks = el.matches('pre[data-codex-code="1"]') ? [el] : Array.from(el.querySelectorAll<HTMLElement>('pre[data-codex-code="1"]'));
    const section = context.getSectionInfo(el);
    if (!section) return;
    // 同一文件可同时打开阅读和编辑窗格；只绑定承载此 DOM 的编辑窗格。
    // 首次 postprocessor 尚未挂载时跳过，ColoredSection 挂载后的 refresh 会再次绑定。
    const view = this.plugin.app.workspace.getLeavesOfType("markdown").map((leaf) => leaf.view).find((item): item is MarkdownView => item instanceof MarkdownView && item.file?.path === context.sourcePath && item.containerEl.contains(el));
    if (!view || view.getMode() !== "source") return;
    const text = view.editor.getValue(), lines = text.split("\n");
    if (section.lineStart < 0 || section.lineEnd < section.lineStart || section.lineEnd >= lines.length) return;
    const from = lines.slice(0, section.lineStart).reduce((sum, line) => sum + line.length + 1, 0);
    const to = Math.min(text.length, lines.slice(0, section.lineEnd + 1).reduce((sum, line) => sum + line.length + 1, 0));
    const source = text.slice(from, to);
    if (section.text !== text && section.text !== source && section.text !== source.replace(/\n$/, "")) return;
    for (const block of blocks) this.renderedCode.set(block, { path: context.sourcePath, text, from, to });
  }

  private showCodeToolbar(): void {
    if (this.colorPicker || this.codeToolbar?.contains(document.activeElement)) return;
    this.hideCodeToolbar();
    if (!this.enabled || this.disposed) return;
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return;
    const range = selection.getRangeAt(0);
    const element = range.startContainer.nodeType === 1 ? range.startContainer as Element : range.startContainer.parentElement;
    const code = element?.closest("code"), pre = code?.parentElement;
    if (!code || !pre || !pre.matches('pre[data-codex-code="1"]')) return;
    const binding = this.renderedCode.get(pre);
    const view = this.plugin.app.workspace.getLeavesOfType("markdown").map((leaf) => leaf.view).find((item): item is MarkdownView => item instanceof MarkdownView && item.containerEl.contains(pre));
    if (!view || view.getMode() !== "source" || !view.file) return;
    const dom = readCodeDomSelection(code, range);
    if (!dom) return;
    let offsets: { from: number; to: number };
    const text = view.editor.getValue();
    try {
      if (binding && binding.path === view.file.path && binding.text === text) offsets = mapRenderedCodeSelection(text, binding.from, binding.to, dom.text, dom.from, dom.to);
      else {
        // Live Preview 的 HTML widget 可能不经过 Markdown postprocessor。
        // 只信任承载此 DOM 的 CM 编辑器及其源锚点，再核验整块解码文本，禁止按文本搜索。
        const editor = Array.from(this.editors).find((item) => item.dom.contains(pre) && editorPath(item) === view.file?.path && item.state.doc.toString() === text);
        if (!editor) return;
        const position = editor.posAtDOM(pre);
        offsets = mapRenderedCodeAtPosition(text, position, dom.text, dom.from, dom.to);
      }
    } catch { return; }
    const captured: ColorSelection = { path: view.file.path, text, ...offsets, editor: view.editor, view };
    const toolbar = document.createElement("div");
    toolbar.className = "codex-notes-code-toolbar";
    toolbar.setAttribute("role", "toolbar"); toolbar.setAttribute("aria-label", "NoteGlow 代码颜色");
    // 保留原生选区；每次点击仍由 writeMarkdown 校验全文快照，过期选区不会写入。
    toolbar.addEventListener("mousedown", (event) => event.preventDefault());
    for (const [label, property, picker] of [["字体色", "foreground", false], ["更换字体色", "foreground", true], ["背景色", "background", false], ["更换背景色", "background", true], ["清除颜色", undefined, false]] as const) {
      const button = document.createElement("button"); button.textContent = label; button.title = label; toolbar.appendChild(button);
      button.addEventListener("click", () => {
        const anchor = button.getBoundingClientRect();
        this.hideCodeToolbar();
        if (property && picker) this.openColorPicker(captured, property, anchor);
        else void this.apply(captured, property, property ? this.lastColor(property) : undefined).catch((error: unknown) => new Notice(errorText(error), 8000));
      });
    }
    document.body.appendChild(toolbar); this.codeToolbar = toolbar;
    const rect = range.getBoundingClientRect();
    toolbar.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - toolbar.offsetWidth - 8))}px`;
    toolbar.style.top = `${Math.max(8, rect.top - toolbar.offsetHeight - 8)}px`;
  }

  captureSelection(editor: Editor, view: MarkdownView): ColorSelection | null {
    if (!this.enabled || this.disposed) { new Notice("颜色功能暂不可用，请检查颜色记录。"); return null; }
    if (!view.file) { new Notice("请先打开一篇笔记。"); return null; }
    if (view.getMode() !== "source") { new Notice("请切换到编辑视图后选择文字。"); return null; }
    if (editor.listSelections().length !== 1) { new Notice("一次请选择一个连续选区，可连续添加不同颜色。"); return null; }
    const text = editor.getValue();
    const from = editor.posToOffset(editor.getCursor("from"));
    const to = editor.posToOffset(editor.getCursor("to"));
    if (from >= to) { new Notice("请先选中需要设置颜色的文字。"); return null; }
    return { path: view.file.path, text, from, to, editor, view };
  }

  async apply(selection: ColorSelection, property?: ColorProperty, color?: string): Promise<void> {
    await this.writeMarkdown(selection, () => applyNativeCodeColor(selection.text, selection.from, selection.to, property, color) ?? applyMarkdownColor(selection.text, selection.from, selection.to, property, color), property, color);
  }

  private async restoreNativeCode(view: MarkdownView): Promise<void> {
    if (!view.file || view.getMode() !== "source") throw new Error("请在当前笔记编辑视图中执行恢复。");
    const path = view.file.path, text = view.editor.getValue(), output = migrateOwnedCodeToNative(text);
    const from = view.editor.posToOffset(view.editor.getCursor("from")), to = view.editor.posToOffset(view.editor.getCursor("to"));
    if (output === text) { new Notice("当前笔记没有需要恢复的旧代码块。"); return; }
    const adapter = this.plugin.app.vault.adapter;
    const directory = this.filename.slice(0, this.filename.lastIndexOf("/")) + "/native-code-backups";
    const backup = await backupNativeCodeMigration(adapter, directory, `${Date.now()}-${crypto.randomUUID()}.md`, text, () => view.file?.path === path && view.editor.getValue() === text && view.containerEl.isConnected && !this.disposed);
    await this.writeMarkdown({ path, text, from, to, editor: view.editor, view }, () => ({ text: output, from: mapMigratedCodePosition(text, output, from), to: mapMigratedCodePosition(text, output, to) }));
    new Notice(`已恢复 ${decodeOwnedCodeBlocks(text).length} 个原生代码块，跳过 0 个；备份：${backup}`, 10000);
  }

  private async format(selection: ColorSelection, format: "bold" | "italic" | "code"): Promise<void> {
    await this.writeMarkdown(selection, () => formatMarkdownSelection(selection.text, selection.from, selection.to, format));
  }

  /** 颜色的事实来源是最终 Markdown。纯函数先完成所有核验，再进行一次可撤销编辑。 */
  private async writeMarkdown(selection: ColorSelection, createEdit: () => PortableColorEdit, property?: ColorProperty, color?: string): Promise<void> {
    if (this.disposed || !this.enabled) throw new Error("颜色功能暂不可用。");
    if (selection.view.file?.path !== selection.path) throw new Error("选区来源已改变，请回到原笔记重新选择文字。");
    const views = this.plugin.app.workspace.getLeavesOfType("markdown").map((leaf) => leaf.view).filter((view): view is MarkdownView => view instanceof MarkdownView);
    const sources = views.filter((view) => view.file?.path === selection.path);
    if (!sources.length) throw new Error(`原笔记编辑视图已关闭（当前 ${views.length} 个 Markdown 视图），请重新打开原笔记。`);
    // Modal/命令面板可能刷新 view 包装对象，只按公开路径及完整正文核验来源，不依赖对象身份。
    const current = sources.find((view) => view === selection.view && view.containerEl.isConnected && view.editor === selection.editor && view.editor.getValue() === selection.text) ?? sources.find((view) => view.editor.getValue() === selection.text);
    if (!current) throw new Error(`笔记内容已改变（选色时 ${selection.text.length} 字符，当前 ${sources[0].editor.getValue().length} 字符），请重新选择文字。`);
    if (property && !normalizeColor(color ?? "")) throw new Error("请输入 #RGB 或 #RRGGBB，例如 #fff88f。");
    if (this.data.notes[selection.path]?.ranges.length) throw new Error("这篇笔记还有旧版颜色，请先完成便携颜色迁移，再重新选择文字；原文未修改。");
    if (this.applyingPaths.has(selection.path)) throw new Error("此笔记正在保存，请稍后重新应用。");
    const edit = createEdit();
    this.applyingPaths.add(selection.path);
    try {
      if (current.file?.path !== selection.path || current.editor.getValue() !== selection.text) throw new Error("笔记或选区来源已改变，未应用颜色。");
      if (edit.text !== selection.text) {
        const change = minimalTextChange(selection.text, edit.text);
        current.editor.transaction({
          changes: [{ from: textPosition(selection.text, change.from), to: textPosition(selection.text, change.to), text: change.insert }],
          selection: { from: textPosition(edit.text, edit.from), to: textPosition(edit.text, edit.to) }
        }, "codex-notes-format");
      } else {
        current.editor.setSelection(textPosition(edit.text, edit.from), textPosition(edit.text, edit.to));
      }
      // 浮层按钮会取得焦点；归还编辑器后，紧接着的原生 Undo/快捷键才能作用于此次事务。
      current.editor.focus();
      // 调用公开保存 API，并直接读磁盘验证；编辑事务成功不代表文件已保存。
      await current.save();
      const saved = await this.plugin.app.vault.adapter.read(selection.path);
      if (saved !== edit.text || current.file?.path !== selection.path || current.editor.getValue() !== edit.text) {
        throw new Error("正文在保存核验期间发生变化，请确认当前内容并保存；不会回滚或覆盖后续编辑。");
      }
      if (property) {
        if (this.disposed) throw new Error("正文已保存，但插件已关闭，颜色偏好未更新。");
        await this.rememberColor(property, color!);
      }
    } finally {
      this.applyingPaths.delete(selection.path);
    }
  }

  private async rememberColor(property: ColorProperty, color: string): Promise<void> {
    const previousColor = this.lastColor(property);
    const sequence = ++this.preferenceSequence[property];
    this.data.lastColors = { ...parseLastColors(this.data.lastColors), [property]: normalizeColor(color)! };
    this.changed();
    try { await this.save(); }
    catch (error) {
      // 偏好写入失败不能撤销已保存的 Markdown，也不能覆盖后续同属性的新选择。
      if (this.preferenceSequence[property] === sequence) {
        this.data.lastColors = { ...parseLastColors(this.data.lastColors), [property]: previousColor };
        this.changed(); this.syncLastColorStyle();
        await this.save(true).catch((saveError: unknown) => new Notice(`恢复颜色偏好失败：${errorText(saveError)}`, 8000));
      }
      throw new Error(`正文已保存，但上次颜色偏好保存失败：${errorText(error)}`);
    }
    if (!this.disposed) this.syncLastColorStyle();
  }

  lastColor(property: ColorProperty): string { return parseLastColors(this.data.lastColors)[property]; }

  private syncLastColorStyle(): void {
    if (!this.lastColorStyle) return;
    const colors = parseLastColors(this.data.lastColors);
    this.lastColorStyle.textContent = `:root{--codex-notes-last-foreground:${colors.foreground};--codex-notes-last-background:${colors.background}}button:has(.codex-notes-color-dropdown){width:16px!important;min-width:16px!important;padding-left:0!important;padding-right:0!important}button:has(.codex-notes-color-dropdown) svg{width:12px;height:16px}`;
  }

  decorations(view: EditorView): DecorationSet {
    if (!this.enabled || this.disposed) return Decoration.none;
    const path = editorPath(view);
    const note = path ? this.data.notes[path] : undefined;
    const text = view.state.doc.toString();
    const ranges = note ? (note.text === text ? [...note.ranges] : relocateColorRanges(note, text)) : [];
    if (text.includes("<!-- noteglow-code-colors:")) for (const block of scanNativeCode(text)) if (block.status === "valid") {
      ranges.push(...block.ranges.map((range) => ({ ...range, from: block.codeFrom + range.from, to: block.codeFrom + range.to })));
    }
    return Decoration.set(ranges.filter(({ from, to }) => from >= 0 && from < to && to <= text.length).map((range) => Decoration.mark({ class: colorClass(range.property), attributes: { style: colorStyle(range.property, range.color) } }).range(range.from, range.to)), true);
  }

  documentChanged(path: string, before: string, text: string, mapPos: (position: number, association: number) => number, undoOrRedo = false): void {
    if (!this.enabled || this.disposed) return;
    const note = this.data.notes[path];
    if (!note) return;
    // 同一笔记的多个窗格会同步同一事务；只映射一次，避免后到窗格覆盖完整撤销快照。
    if (note.text === text) return;
    const ranges = note.text === before ? note.ranges : relocateColorRanges(note, before);
    this.rememberEditSnapshot(path, { text: before, ranges });
    // 删除把范围压成零长度后，只有真正的 CM undo/redo 能从精确正文快照恢复。
    // 普通输入和外部改文绝不借用历史，避免同样的文字被重新输入时错误恢复旧颜色。
    const snapshot = undoOrRedo ? this.editSnapshots.get(path)?.find((item) => item.text === text) : undefined;
    this.data.notes[path] = { text, ranges: snapshot ? snapshot.ranges.map((range) => ({ ...range })) : mapColorRanges(ranges, mapPos) };
    this.rememberEditSnapshot(path, this.data.notes[path]);
    this.changed();
    this.scheduleSave(); this.scheduleRefresh();
  }

  private rememberEditSnapshot(path: string, note: ColoredNote): void {
    const bytes = note.text.length * 2 + note.ranges.length * 64;
    if (bytes > MAX_EDIT_SNAPSHOT_BYTES) return;
    const history = this.editSnapshots.get(path) ?? [];
    const existing = history.findIndex((item) => item.text === note.text);
    if (existing >= 0) this.editSnapshotBytes -= history.splice(existing, 1)[0].bytes;
    const snapshot: EditColorSnapshot = { text: note.text, ranges: note.ranges.map((range) => ({ ...range })), bytes, sequence: ++this.snapshotSequence };
    history.push(snapshot); this.editSnapshotBytes += bytes; this.editSnapshots.set(path, history);
    while (history.length > MAX_EDIT_SNAPSHOTS_PER_NOTE) this.editSnapshotBytes -= history.shift()!.bytes;
    while (this.editSnapshotBytes > MAX_EDIT_SNAPSHOT_BYTES) {
      let oldestPath: string | undefined;
      let oldestSequence = Infinity;
      for (const [candidatePath, snapshots] of this.editSnapshots) {
        if (snapshots[0]?.sequence < oldestSequence) { oldestPath = candidatePath; oldestSequence = snapshots[0].sequence; }
      }
      if (!oldestPath) break;
      const snapshots = this.editSnapshots.get(oldestPath)!;
      this.editSnapshotBytes -= snapshots.shift()!.bytes;
      if (!snapshots.length) this.editSnapshots.delete(oldestPath);
    }
  }

  private dropEditSnapshots(path: string): void {
    for (const snapshot of this.editSnapshots.get(path) ?? []) this.editSnapshotBytes -= snapshot.bytes;
    this.editSnapshots.delete(path);
  }

  private async readExternal(file: TFile): Promise<void> {
    const path = file.path;
    const ticket = (this.readTickets.get(path) ?? 0) + 1;
    this.readTickets.set(path, ticket);
    const text = await this.plugin.app.vault.cachedRead(file);
    if (this.disposed || file.path !== path || this.readTickets.get(path) !== ticket) return;
    // autosave 的磁盘快照可能落后于 CM，活动编辑器的正文才是当前 offset 的权威。
    for (const editor of this.editors) if (editorPath(editor) === path && editor.state.doc.toString() !== text) return;
    this.externalChanged(path, text);
  }

  private externalChanged(path: string, text: string): void {
    if (!this.enabled || this.disposed) return;
    const note = this.data.notes[path];
    if (!note || note.text === text) return;
    this.data.notes[path] = { text, ranges: relocateColorRanges(note, text) };
    this.changed();
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { this.saveTimer = null; void this.save().catch((error: unknown) => new Notice(`颜色记录保存失败：${errorText(error)}`, 8000)); }, 250);
  }

  private changed(): void { this.dirty = true; this.revision++; }

  private save(finalSnapshot = false): Promise<void> {
    const snapshot = JSON.stringify(this.data);
    const revision = this.revision;
    const operation = this.channel.queue.catch(() => undefined).then(async () => {
      if ((this.disposed && !finalSnapshot) || !this.enabled) return;
      await this.plugin.app.vault.adapter.write(this.filename, snapshot);
      if (this.revision === revision) this.dirty = false;
    });
    this.channel.queue = operation;
    return operation;
  }

  private scheduleRefresh(): void {
    if (this.disposed || this.refreshTimer) return;
    // 不在 CM update 回调中 dispatch，避免事务重入。
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      if (this.disposed) return;
      for (const editor of this.editors) editor.dispatch({ effects: refreshColors.of(undefined) });
      for (const reader of this.readers) reader.refresh();
    }, 0);
  }

  attachReader(reader: ColoredSection): void { this.readers.add(reader); }
  detachReader(reader: ColoredSection): void { this.readers.delete(reader); }

  renderReading(el: HTMLElement, context: MarkdownPostProcessorContext, renderedSource: string): void {
    el.dataset.codexNoteColorStatus = "inactive";
    if (!this.enabled || this.disposed) return;
    const view = this.plugin.app.workspace.getLeavesOfType("markdown").map((leaf) => leaf.view).find((item): item is MarkdownView => item instanceof MarkdownView && item.file?.path === context.sourcePath && item.containerEl.contains(el));
    const text = view?.getMode() === "source" ? view.editor.getValue() : renderedSource;
    const blocks = text.includes("<!-- noteglow-code-colors:") ? scanNativeCode(text) : [];
    const codeElements = el.matches("code") ? [el] : Array.from(el.querySelectorAll<HTMLElement>("pre > code"));
    for (const code of codeElements) {
      if (code.parentElement?.matches('pre[data-codex-code="1"]')) continue;
      const info = context.getSectionInfo(code);
      if (!info || info.text !== text) continue;
      const candidates = blocks.filter((block) => block.line === info.lineStart && block.status === "valid");
      if (candidates.length === 1) paintNativeCodeElement(code, candidates[0]);
    }
    const note = this.data.notes[context.sourcePath];
    const section = context.getSectionInfo(el);
    if (!note) { el.dataset.codexNoteColorStatus = "no-colors"; return; }
    if (!section) { el.dataset.codexNoteColorStatus = "no-source-section"; return; }
    const lines = note.text.split("\n");
    if (section.lineStart < 0 || section.lineEnd >= lines.length || section.lineEnd < section.lineStart) { el.dataset.codexNoteColorStatus = "invalid-section-bounds"; return; }
    const start = lines.slice(0, section.lineStart).reduce((sum, line) => sum + line.length + 1, 0);
    const end = Math.min(note.text.length, lines.slice(0, section.lineEnd + 1).reduce((sum, line) => sum + line.length + 1, 0));
    const source = note.text.slice(start, end);
    // 通常是全文；只含 section 的渲染器也必须与快照精确一致。
    if (section.text !== note.text && section.text !== source && section.text !== source.replace(/\n$/, "")) { el.dataset.codexNoteColorStatus = "source-snapshot-mismatch"; return; }
    const ranges = note.ranges.filter((range) => range.from < end && range.to > start);
    if (!ranges.length) { el.dataset.codexNoteColorStatus = "no-section-colors"; return; }
    const nodes: Text[] = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!(node instanceof Text) || node.parentElement?.closest("button,input,textarea,svg,script,style,.copy-code-button,.code-block-flair,.list-bullet,.collapse-indicator,.heading-collapse-indicator,.math")) continue;
      nodes.push(node);
    }
    const rendered = nodes.map((node) => node.data).join("");
    const projection = projectMarkdown(source, start);
    const alignment = alignRenderedText(projection, rendered);
    if (!alignment) { el.dataset.codexNoteColorStatus = `projection-mismatch:${projection.text.length}/${rendered.length}`; return; }
    el.dataset.codexNoteColorStatus = "applied";
    let cursor = 0;
    for (const node of nodes) {
      const text = node.data;
      const pieces: Array<{ text: string; foreground?: string; background?: string }> = [];
      for (let i = 0; i < text.length; i++) {
        const offset = alignment[cursor + i];
        const colors = offset === null ? {} : colorAt(ranges, offset);
        const previous = pieces[pieces.length - 1];
        if (previous && previous.foreground === colors.foreground && previous.background === colors.background) previous.text += text[i];
        else pieces.push({ text: text[i], ...colors });
      }
      cursor += text.length;
      if (!pieces.some((piece) => piece.foreground || piece.background)) continue;
      const fragment = document.createDocumentFragment();
      for (const piece of pieces) {
        if (!piece.foreground && !piece.background) { fragment.appendChild(document.createTextNode(piece.text)); continue; }
        const span = document.createElement("span");
        span.dataset.codexNoteColor = "true";
        span.textContent = piece.text;
        if (piece.foreground) { span.classList.add(colorClass("foreground")); span.style.setProperty("--codex-note-foreground", piece.foreground); }
        if (piece.background) { span.classList.add(colorClass("background")); span.style.setProperty("--codex-note-background", piece.background); }
        fragment.appendChild(span);
      }
      node.replaceWith(fragment);
    }
  }
}

class ColoredSection extends MarkdownRenderChild {
  private colorObserver: MutationObserver | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private warningTimer: ReturnType<typeof setTimeout> | null = null;
  private lastWarning = "";
  private stopped = false;
  constructor(el: HTMLElement, private readonly context: MarkdownPostProcessorContext, private readonly owner: NoteColorController, private readonly source: string) { super(el); }
  onload(): void {
    this.stopped = false;
    this.colorObserver = new MutationObserver(() => {
      if (this.stopped || this.refreshTimer || !this.hasCode()) return;
      this.refreshTimer = setTimeout(() => { this.refreshTimer = null; this.refresh(); }, 0);
    });
    this.owner.attachReader(this);
    this.refresh();
    // 首轮 postprocessor 的节点可能尚未挂到阅读 section；挂载后做一次有界复核。
    this.settleTimer = setTimeout(() => { this.settleTimer = null; this.refresh(); }, 100);
  }
  onunload(): void {
    this.stopped = true;
    this.colorObserver?.disconnect();
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (this.settleTimer) clearTimeout(this.settleTimer);
    if (this.warningTimer) clearTimeout(this.warningTimer);
    this.owner.detachReader(this);
    this.clear();
  }
  clear(): void {
    for (const span of Array.from(this.containerEl.querySelectorAll<HTMLElement>("span[data-codex-note-color]"))) span.replaceWith(...Array.from(span.childNodes));
    this.containerEl.normalize();
  }
  refresh(): void {
    if (this.stopped) return;
    // Prism 等异步重写 code 的 DOM 会擦掉颜色层。重做严格投影，但自身写入不触发递归。
    this.colorObserver?.disconnect();
    this.clear();
    this.owner.bindRenderedCode(this.containerEl, this.context);
    try { this.owner.renderReading(this.containerEl, this.context, this.source); }
    finally { this.colorObserver?.observe(this.containerEl, { childList: true, characterData: true, subtree: true }); }
    if (this.warningTimer) clearTimeout(this.warningTimer);
    const status = this.containerEl.dataset.codexNoteColorStatus ?? "unknown";
    if (this.hasCode() && /mismatch|bounds|no-source/.test(status) && status !== this.lastWarning) {
      this.warningTimer = setTimeout(() => {
        this.warningTimer = null;
        if (this.stopped || this.containerEl.dataset.codexNoteColorStatus !== status) return;
        this.lastWarning = status;
        new Notice(`代码颜色暂未定位（${status}），为保护代码原文未进行模糊着色。`, 7000);
      }, 700);
    }
  }
  private hasCode(): boolean { return this.containerEl.matches("pre,code") || Boolean(this.containerEl.querySelector("pre,code")); }
}

function editorPath(view: EditorView): string | undefined { return view.state.field(editorInfoField, false)?.file?.path; }
function textPosition(text: string, offset: number): { line: number; ch: number } {
  const before = text.slice(0, offset);
  return { line: before.split("\n").length - 1, ch: offset - before.lastIndexOf("\n") - 1 };
}
function colorClass(property: ColorProperty): string { return `codex-notes-color-${property}`; }
function colorStyle(property: ColorProperty, color: string): string { return `--codex-note-${property}:${color}`; }
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function colorAt(ranges: readonly ColorRange[], position: number): { foreground?: string; background?: string } {
  const result: { foreground?: string; background?: string } = {};
  for (const range of ranges) if (range.from <= position && range.to > position) result[range.property] = range.color;
  return result;
}
