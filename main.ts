import { FileSystemAdapter, MarkdownView, normalizePath, Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { CodexChatView, CODEX_VIEW_TYPE } from "./src/chat-view";
import { CodexClient } from "./src/codex-client";
import type { CodexProgressEvent } from "./src/codex-events";
import { ConversationRepository, loadPluginSettings } from "./src/conversation-store";
import { exportConversationMarkdown, safeExportBasename } from "./src/conversation-utils";
import { CodexSettingTab } from "./src/settings-tab";
import type { ChatMessage, Conversation, PluginSettings } from "./src/types";
import { randomUUID } from "node:crypto";
import { type ContextAttachment, validateAttachments } from "./src/context";
import { readModels, type CodexModel } from "./src/models";
import { registerNoteColors } from "./src/note-colors";

export default class CodexWorkspacePlugin extends Plugin {
  declare settings: PluginSettings;
  readonly codex = new CodexClient();
  private conversations!: ConversationRepository;
  private lastMarkdownView: MarkdownView | null = null;
  private saveQueue: Promise<void> = Promise.resolve();
  private openingSelection = false;
  private unloaded = false;

  async onload(): Promise<void> {
    await this.loadSettings();

    const activeMarkdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeMarkdownView?.file) {
      this.lastMarkdownView = activeMarkdownView;
    }
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => this.rememberMarkdownView(leaf))
    );

    this.registerView(
      CODEX_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new CodexChatView(leaf, this)
    );

    this.addRibbonIcon("bot", "打开 Codex 笔记助手", () => void this.activateView());
    this.addCommand({
      id: "open-codex-chat",
      name: "打开 Codex 对话",
      callback: () => void this.activateView()
    });
    this.addCommand({
      id: "new-codex-chat",
      name: "开始新的 Codex 对话",
      callback: async () => {
        try {
          await this.activateView();
          const chat = this.app.workspace.getLeavesOfType(CODEX_VIEW_TYPE)[0]?.view;
          if (chat instanceof CodexChatView) await chat.newConversation();
        } catch (error) { new Notice(error instanceof Error ? error.message : "无法新建对话。"); }
      }
    });
    this.addCommand({
      id: "add-selection-to-codex", name: "添加选区到 Codex", icon: "bot",
      hotkeys: [{ modifiers: ["Mod", "Alt"], key: "C" }],
      checkCallback: (checking) => {
        const view = this.getContextMarkdownView();
        const available = Boolean(view?.file && view.editor.getSelection().trim());
        if (!checking && available) void this.addSelection(view!);
        return available;
      }
    });
    this.registerEvent(this.app.workspace.on("editor-menu", (menu, editor, view) => {
      if (!(view instanceof MarkdownView) || !view.file || !editor.getSelection().trim()) return;
      menu.addItem((item) => item.setTitle("添加选区到 Codex").setIcon("bot")
        .onClick(() => void this.addSelection(view)));
    }));
    this.addSettingTab(new CodexSettingTab(this.app, this));
    // 便携颜色按 Markdown 结构写入自有 HTML；旧旁路颜色由离线工具备份并迁移。
    await registerNoteColors(this);
  }

  onunload(): void {
    // 先关闭旧实例写入入口，取消回调不能覆盖重新启用后的新实例草稿。
    this.unloaded = true;
    this.codex.stop();
  }

  getContextMarkdownView(): MarkdownView | null {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView?.file) {
      this.lastMarkdownView = activeView;
      return activeView;
    }

    if (this.lastMarkdownView?.file) return this.lastMarkdownView;

    const fallback = this.app.workspace
      .getLeavesOfType("markdown")
      .map((leaf) => leaf.view)
      .find((view): view is MarkdownView => view instanceof MarkdownView && view.file !== null);
    this.lastMarkdownView = fallback ?? null;
    return this.lastMarkdownView;
  }

  get activeConversation(): Conversation {
    return this.conversations.active;
  }

  get allConversations(): readonly Conversation[] {
    return this.settings.conversations;
  }

  async refreshViews(except?: CodexChatView): Promise<void> {
    if (this.unloaded) return;
    // 请求完成后同步新打开的侧栏；旧视图关闭时的回调仍能解锁新视图。
    await Promise.all(this.app.workspace.getLeavesOfType(CODEX_VIEW_TYPE).map(async (leaf) => {
      if (leaf.view instanceof CodexChatView && leaf.view !== except) await leaf.view.refreshFromPlugin();
    }));
  }

  makeAttachment(kind: ContextAttachment["kind"], source?: MarkdownView): ContextAttachment | null {
    const view = source ?? this.getContextMarkdownView();
    if (!view?.file) { new Notice("请先打开一篇 Markdown 笔记。"); return null; }
    const attachment: ContextAttachment = {
      id: randomUUID(), kind, path: view.file.path,
      content: kind === "selection" ? view.editor.getSelection() : view.editor.getValue()
    };
    if (kind === "selection") {
      const from = view.editor.getCursor("from");
      const to = view.editor.getCursor("to");
      attachment.startLine = from.line + 1;
      attachment.endLine = to.ch === 0 && to.line > from.line ? to.line : to.line + 1;
    }
    const error = validateAttachments([attachment]);
    if (error) { new Notice(error); return null; }
    return attachment;
  }

  private async addSelection(view: MarkdownView): Promise<void> {
    if (this.codex.running || this.openingSelection) { new Notice("请等待当前操作完成。"); return; }
    // 在打开侧栏前捕获原文和行号，之后的焦点变化不会改变本次引用。
    const attachment = this.makeAttachment("selection", view);
    if (!attachment) return;
    this.openingSelection = true;
    try {
      await this.activateView();
      const chat = this.app.workspace.getLeavesOfType(CODEX_VIEW_TYPE)[0]?.view;
      if (!(chat instanceof CodexChatView)) throw new Error("无法打开 Codex 笔记助手。");
      await chat.addAttachment(attachment);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "添加选区失败。");
    } finally { this.openingSelection = false; }
  }

  async updateDraft(text: string, attachments: ContextAttachment[], conversationId = this.activeConversation.id): Promise<void> {
    const conversation = this.requireConversation(conversationId);
    const error = validateAttachments(attachments);
    if (error) throw new Error(error);
    // 内存保留最新草稿；落盘失败不回滚较新的输入，调用方提示并允许再次保存。
    conversation.draftText = text;
    conversation.draftAttachments = attachments.map((attachment) => ({ ...attachment }));
    await this.persistSettings();
  }

  getModels(): CodexModel[] { return readModels(); }

  async setModel(model: string): Promise<void> {
    if (this.codex.running) throw new Error("请等待当前请求完成后再切换模型。");
    if (model && !this.getModels().some(({ slug }) => slug === model)) throw new Error("当前 Codex 模型目录没有这个模型。");
    const conversation = this.activeConversation;
    const previous = conversation.model;
    conversation.model = model;
    try { await this.persistSettings(); } catch (error) { conversation.model = previous; throw error; }
  }

  async selectConversation(id: string): Promise<Conversation> {
    if (this.codex.running) throw new Error("请等待当前请求完成后再切换对话。");
    const conversation = this.conversations.select(id);
    await this.persistSettings();
    return conversation;
  }

  async renameConversation(id: string, title: string): Promise<Conversation> {
    const conversation = this.conversations.rename(id, title);
    await this.persistSettings();
    return conversation;
  }

  async setConversationArchived(id: string, archived: boolean): Promise<Conversation> {
    if (this.codex.running) throw new Error("请求执行期间不能归档对话。");
    const conversation = this.conversations.setArchived(id, archived);
    await this.persistSettings();
    return conversation;
  }

  async deleteConversation(id: string): Promise<void> {
    if (this.codex.running) throw new Error("请求执行期间不能删除对话。");
    this.conversations.delete(id);
    await this.persistSettings();
  }

  async exportConversation(id: string): Promise<string> {
    const conversation = this.settings.conversations.find((item) => item.id === id);
    if (!conversation) throw new Error("找不到指定的对话。");
    const folder = "Codex exports";
    if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
    const base = safeExportBasename(conversation.title);
    let path = normalizePath(`${folder}/${base}.md`);
    let suffix = 2;
    while (this.app.vault.getAbstractFileByPath(path)) {
      path = normalizePath(`${folder}/${base} ${suffix}.md`);
      suffix += 1;
    }
    await this.app.vault.create(path, exportConversationMarkdown(conversation));
    return path;
  }

  async activateView(): Promise<void> {
    const workspace = this.app.workspace;
    let leaf = workspace.getLeavesOfType(CODEX_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf("split", "vertical");
      await leaf.setViewState({ type: CODEX_VIEW_TYPE, active: true });
    }
    await workspace.revealLeaf(leaf);
  }

  async sendToCodex(
    prompt: string,
    onStatus: (status: string) => void,
    onProgress: (event: CodexProgressEvent) => void,
    conversationId = this.activeConversation.id
  ): Promise<string> {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      throw new Error("Codex CLI 仅支持使用本机文件系统的 Obsidian Vault。");
    }

    // 绑定发送开始时的对话，异步结果不借用后续变化的 activeConversation。
    const conversation = this.requireConversation(conversationId);
    return await this.codex.send(prompt, adapter.getBasePath(), {
      codexPath: this.settings.codexPath,
      sandboxMode: this.settings.sandboxMode,
      approveForMe: this.settings.approveForMe,
      sessionId: conversation.threadId,
      model: conversation.model
    }, {
      onThreadId: (threadId) => {
        // 卸载后可能仍收到已缓冲的 stdout；旧实例不能再更新或保存对话。
        if (this.unloaded) return;
        if (conversation.threadId !== threadId) {
          conversation.threadId = threadId;
          conversation.updatedAt = Date.now();
          void this.persistSettings().catch((error) => {
            if (!this.unloaded) new Notice(`保存 Codex 会话失败：${String(error)}`);
          });
        }
      },
      onStatus,
      onProgress
    });
  }

  async startNewChat(): Promise<Conversation> {
    if (this.codex.running) throw new Error("请等待当前请求完成后再新建对话。");
    const conversation = this.conversations.create();
    await this.persistSettings();
    new Notice("已开始新的 Codex 对话。", 3000);
    return conversation;
  }

  createMessage(role: ChatMessage["role"], text: string): ChatMessage {
    return {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      role,
      text,
      createdAt: Date.now()
    };
  }

  appendMessage(message: ChatMessage, conversationId = this.activeConversation.id): Conversation {
    if (conversationId === this.activeConversation.id) return this.conversations.appendMessage(message);
    const conversation = this.requireConversation(conversationId);
    conversation.messages.push(message);
    conversation.updatedAt = Date.now();
    return conversation;
  }

  async persistSettings(): Promise<void> {
    if (this.unloaded) throw new Error("插件已卸载，当前草稿使用此前保存的快照。");
    // 每次冻结状态后排队保存；后发草稿不会被更慢的旧 saveData 覆盖。
    const snapshot: PluginSettings = JSON.parse(JSON.stringify(this.settings)) as PluginSettings;
    const pending = this.saveQueue.catch(() => undefined).then(() => {
      if (this.unloaded) throw new Error("插件已卸载，停止旧实例的排队写入。");
      return this.saveData(snapshot);
    });
    this.saveQueue = pending;
    await pending;
  }

  private requireConversation(id: string): Conversation {
    const conversation = this.settings.conversations.find((item) => item.id === id);
    if (!conversation) throw new Error("找不到指定的对话。");
    return conversation;
  }

  private async loadSettings(): Promise<void> {
    const loaded = loadPluginSettings(await this.loadData());
    this.settings = loaded.settings;
    this.conversations = new ConversationRepository(this.settings);
    if (loaded.migratedLegacy || loaded.recoveredRecords > 0) {
      await this.persistSettings();
      if (loaded.recoveredRecords > 0) {
        new Notice(`已跳过 ${loaded.recoveredRecords} 条无法识别的旧对话数据。`, 8000);
      }
    }
  }

  private rememberMarkdownView(leaf: WorkspaceLeaf | null): void {
    if (leaf?.view instanceof MarkdownView && leaf.view.file) {
      this.lastMarkdownView = leaf.view;
    }
  }
}
