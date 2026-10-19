import { MarkdownView, type Plugin } from 'obsidian';
import { createOutlinePanel } from './note-outline-panel';

/** 标题由 Obsidian 缓存解析（排除围栏等非标题）；每个 MarkdownView 独立管理目录与滚动。 */
export function registerNoteOutline(plugin: Plugin): void {
  const panels = new Map<MarkdownView, { refresh(resetSelection?: boolean): void; destroy(): void }>();
  let stopped = false;
  const sync = (): void => {
    if (stopped) return;
    const views = new Set(plugin.app.workspace.getLeavesOfType('markdown')
      .map(leaf => leaf.view).filter((view): view is MarkdownView => view instanceof MarkdownView && !!view.file));
    for (const [view, panel] of panels) if (!views.has(view)) { panel.destroy(); panels.delete(view); }
    for (const view of views) {
      if (!panels.has(view)) {
        const host = view.contentEl;
        const ownerWindow = host.ownerDocument.defaultView!;
        let selectedLine: number | undefined;
        let selectedFile = view.file, selectedMode = view.getMode();
        const panel = createOutlinePanel(host, line => {
          selectedLine = line;
          // 使用当前模式的源码行滚动接口，保留阅读模式，避免同名锚点歧义。
          view.currentMode.applyScroll(line);
          if (view.getMode() === 'source') view.editor.setCursor({ line, ch: 0 });
        });
        let timer: number | undefined;
        const currentLine = (): number => selectedLine ?? view.currentMode.getScroll();
        const refresh = (resetSelection = false): void => {
          const file = view.file;
          if (!file) return;
          if (resetSelection || selectedFile !== file || selectedMode !== view.getMode()) selectedLine = undefined;
          selectedFile = file; selectedMode = view.getMode();
          panel.setHeadings(file.path, (plugin.app.metadataCache.getFileCache(file)?.headings ?? [])
            .map(heading => ({ text: heading.heading, level: heading.level, line: heading.position.start.line })));
          panel.setActiveLine(currentLine());
        };
        const scroll = (event: Event): void => {
          // 目录内部滚动不能反过来刷新正文当前位置。
          if ((event.target as Element | null)?.closest?.('.noteglow-outline')) return;
          if (timer !== undefined) return;
          timer = ownerWindow.setTimeout(() => { timer = undefined; panel.setActiveLine(currentLine()); }, 50);
        };
        // applyScroll 后宿主可能返回标题之前的小数行；显式点击的标题在程序滚动期间保持选中。
        // 捕获文档级输入，原生侧栏、搜索和快捷键导航也会释放选择；仅下一次本窗格滚动才更新高亮。
        const resumeTracking = (event: Event): void => {
          if ((event.target as Element | null)?.closest?.('.noteglow-outline')) return;
          selectedLine = undefined;
        };
        const inputEvents = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;
        for (const name of inputEvents) host.ownerDocument.addEventListener(name, resumeTracking, true);
        host.addEventListener('scroll', scroll, true);
        panels.set(view, { refresh, destroy: () => {
          host.removeEventListener('scroll', scroll, true);
          for (const name of inputEvents) host.ownerDocument.removeEventListener(name, resumeTracking, true);
          if (timer !== undefined) ownerWindow.clearTimeout(timer);
          panel.destroy();
        } });
      }
      panels.get(view)!.refresh();
    }
  };
  plugin.registerEvent(plugin.app.workspace.on('layout-change', sync));
  plugin.registerEvent(plugin.app.workspace.on('file-open', sync));
  plugin.registerEvent(plugin.app.metadataCache.on('changed', file => {
    for (const [view, panel] of panels) if (view.file === file) panel.refresh(true);
  }));
  plugin.app.workspace.onLayoutReady(sync);
  plugin.register(() => { stopped = true; for (const panel of panels.values()) panel.destroy(); panels.clear(); });
}
