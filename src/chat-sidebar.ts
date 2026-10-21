import type { Workspace, WorkspaceLeaf } from "obsidian";

/** 自动打开仅展开原生侧栏，不调用会切换活动页的 revealLeaf；用户主动打开仍沿用原有行为。 */
export function createChatSidebar(workspace: Workspace, type: string, isUnloaded: () => boolean): { open(automatic?: boolean): Promise<void> } {
  let opening: Promise<WorkspaceLeaf | null> | null = null;
  const obtain = async (automatic: boolean): Promise<WorkspaceLeaf | null> => {
    if (isUnloaded()) return null;
    const existing = workspace.getLeavesOfType(type)[0];
    if (automatic) {
      const root = existing?.getRoot();
      // 恢复的中央页签或浮窗保持原位置；原侧栏由宿主复用并选中聊天 tab。
      if (existing && root !== workspace.rightSplit && root !== workspace.leftSplit) return existing;
      return workspace.ensureSideLeaf(type, root === workspace.leftSplit ? "left" : "right", { active: false, reveal: true });
    }
    if (existing) return existing;
    const leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf("split", "vertical");
    await leaf.setViewState({ type, active: true });
    return leaf;
  };
  return { async open(automatic = false): Promise<void> {
    if (isUnloaded()) return;
    // 启动恢复和手动点击共享初始化，避免同一时刻创建两个聊天页签。
    opening ??= obtain(automatic);
    const pending = opening;
    let leaf: WorkspaceLeaf | null;
    try { leaf = await pending; } finally { if (opening === pending) opening = null; }
    if (!leaf || isUnloaded() || !workspace.getLeavesOfType(type).includes(leaf)) return;
    if (!automatic) { await workspace.revealLeaf(leaf); return; }
    // 自动路径的显示已交由 ensureSideLeaf(active:false) 完成，不在异步返回后修改活动页。
  } };
}
