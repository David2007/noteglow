import { Component, ItemView, MarkdownRenderer, Modal, Notice, setIcon, WorkspaceLeaf } from "obsidian";
import type CodexWorkspacePlugin from "../main";
import type { CodexProgressEvent } from "./codex-events";
import { searchConversations } from "./conversation-utils";
import { buildPromptWithContext, type ContextAttachment, validateAttachments } from "./context";
import type { ChatMessage } from "./types";
import { MAX_IMAGES, MAX_IMAGE_BYTES, MAX_IMAGE_TOTAL_BYTES, inspectImage, validateImages, type ImageAttachment } from "./image-attachments";
import type { PreparedImages } from "./image-store";

export const CODEX_VIEW_TYPE = "codex-notes-chat";
// CLI 退出到消息落盘完成之间仍属于同一次发送，重开侧栏不能提前编辑或发送。
const pendingSubmissions = new WeakSet<CodexWorkspacePlugin>();

export class CodexChatView extends ItemView {
  private messagesEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendButton!: HTMLButtonElement;
  private stopButton!: HTMLButtonElement;
  private statusEl!: HTMLElement;
  private progressEl!: HTMLElement;
  private contextEl!: HTMLElement;
  private conversationSelect!: HTMLSelectElement;
  private modelSelect!: HTMLSelectElement;
  private attachments: ContextAttachment[] = [];
  private images: ImageAttachment[] = [];
  private imageInput!: HTMLInputElement;
  private imagePickerConversationId = "";
  private composerConversationId = "";
  private busy = false;
  private submitting = false;
  private cancelRequested = false;
  private transitioning = false;
  private closed = false;
  private modelCatalogErrorShown = false;
  private messageRenderer: Component | undefined;
  private actionButtons: HTMLButtonElement[] = [];

  constructor(leaf: WorkspaceLeaf, private readonly plugin: CodexWorkspacePlugin) { super(leaf); }
  getViewType(): string { return CODEX_VIEW_TYPE; }
  getDisplayText(): string { return "NoteGlow"; }
  getIcon(): string { return "bot"; }

  async onOpen(): Promise<void> {
    this.closed = false;
    this.render();
    await this.refreshFromPlugin();
  }

  async onClose(): Promise<void> {
    this.closed = true;
    this.cancelRequested = true;
    // 关闭侧栏取消属于这个插件的单次执行；尚未启动的发送通过 closed 检查终止。
    if (this.plugin.codex.running) this.plugin.codex.stop();
    if (this.messageRenderer) { this.removeChild(this.messageRenderer); this.messageRenderer = undefined; }
    try { await this.flushDraft(); } catch (error) { this.showError(error); }
  }

  private render(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("codex-notes-view");
    const header = root.createDiv({ cls: "codex-notes-header" });
    const title = header.createDiv({ cls: "codex-notes-title" });
    setIcon(title.createSpan(), "bot");
    title.createSpan({ text: "NoteGlow" });
    this.conversationSelect = header.createEl("select", { cls: "codex-notes-conversation-select", attr: { "aria-label": "切换对话" } });
    this.registerDomEvent(this.conversationSelect, "change", () => this.runAction(() => this.switchConversation()));
    this.actionButtons = [];
    this.actionButtons.push(this.iconButton(header, "messages-square", "管理对话", () => this.runAction(() => this.openManager())));
    this.actionButtons.push(this.iconButton(header, "square-pen", "新建对话", () => this.runAction(() => this.startNewChat())));
    this.statusEl = root.createDiv({ cls: "codex-notes-status" });
    this.progressEl = root.createDiv({ cls: "codex-notes-progress" });
    this.progressEl.hidden = true;
    this.messagesEl = root.createDiv({ cls: "codex-notes-messages" });
    const composer = root.createDiv({ cls: "codex-notes-composer" });
    this.contextEl = composer.createDiv({ cls: "codex-notes-attachments", attr: { "aria-label": "待发送的引用" } });
    this.inputEl = composer.createEl("textarea", { cls: "codex-notes-input", attr: { placeholder: "请输入问题，引用内容会随消息一起发送…", rows: "2", "aria-label": "输入给 Codex 的问题" } });
    this.registerDomEvent(this.inputEl, "input", () => {
      this.resizeInput();
      void this.flushDraft().catch((error: unknown) => this.showError(error));
    });
    this.registerDomEvent(this.inputEl, "keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        this.runAction(() => this.submit());
      }
    });
    // 图片是独立附件，不把本地文件路径或 base64 塞进用户问题。文字粘贴继续沿用原生输入。
    this.registerDomEvent(this.inputEl, "paste", (event) => {
      const files = Array.from(event.clipboardData?.files ?? []).filter((file) => file.type.startsWith("image/"));
      if (!files.length) return;
      event.preventDefault();
      this.runAction(() => this.importImages(files, this.composerConversationId));
    });
    this.registerDomEvent(composer, "dragover", (event) => {
      if (event.dataTransfer?.types.includes("Files")) { event.preventDefault(); event.stopPropagation(); }
    });
    this.registerDomEvent(composer, "drop", (event) => {
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (!files.length) return;
      event.preventDefault(); event.stopPropagation();
      this.runAction(() => this.importImages(files, this.composerConversationId));
    });
    this.imageInput = composer.createEl("input", { type: "file", attr: { accept: "image/png,image/jpeg,image/webp", multiple: "", "aria-label": "选择图片文件" } });
    this.imageInput.hidden = true;
    this.registerDomEvent(this.imageInput, "change", () => {
      const files = Array.from(this.imageInput.files ?? []);
      const conversationId = this.imagePickerConversationId;
      this.imageInput.value = "";
      if (files.length) this.runAction(() => this.importImages(files, conversationId));
    });
    const actions = composer.createDiv({ cls: "codex-notes-actions" });
    this.actionButtons.push(this.iconButton(actions, "image-plus", "添加图片（也可粘贴或拖入）", () => {
      if (this.isLocked()) return;
      this.imagePickerConversationId = this.composerConversationId;
      this.imageInput.click();
    }));
    this.actionButtons.push(this.iconButton(actions, "text-select", "附加选中文字", () => this.attachContext("selection")));
    this.actionButtons.push(this.iconButton(actions, "file-plus-2", "附加当前笔记", () => this.attachContext("active-note")));
    this.modelSelect = actions.createEl("select", { cls: "codex-notes-model-select", attr: { "aria-label": "选择 Codex 模型" } });
    this.registerDomEvent(this.modelSelect, "change", () => this.runAction(() => this.changeModel()));
    this.stopButton = actions.createEl("button", { text: "停止", cls: "mod-warning" });
    this.stopButton.hidden = true;
    this.registerDomEvent(this.stopButton, "click", () => {
      this.cancelRequested = true;
      this.plugin.codex.stop();
      this.stopButton.disabled = true;
      this.setStatus("正在停止，草稿将保留…");
    });
    this.sendButton = actions.createEl("button", { text: "发送", cls: "mod-cta" });
    this.registerDomEvent(this.sendButton, "click", () => this.runAction(() => this.submit()));
  }

  private iconButton(parent: HTMLElement, icon: string, label: string, action: () => void): HTMLButtonElement {
    const button = parent.createEl("button", { cls: "clickable-icon codex-notes-icon-button", attr: { "aria-label": label, title: label } });
    setIcon(button, icon);
    this.registerDomEvent(button, "click", action);
    return button;
  }

  // 草稿归属于捕获时的对话；异步保存不能把旧输入写入刚切换的新对话。
  private async flushDraft(): Promise<void> {
    if (!this.inputEl || !this.composerConversationId) return;
    await this.plugin.updateDraft(this.inputEl.value, this.attachments.map((item) => ({ ...item })), this.composerConversationId, this.images.map((image) => ({ ...image })));
  }

  public restoreComposer(): void {
    if (!this.inputEl || this.closed) return;
    const conversation = this.plugin.activeConversation;
    this.composerConversationId = conversation.id;
    this.inputEl.value = conversation.draftText;
    this.attachments = conversation.draftAttachments.map((item) => ({ ...item }));
    this.images = (conversation.draftImages ?? []).map((image) => ({ ...image }));
    this.renderConversationOptions();
    this.renderModelOptions();
    this.renderAttachments(this.contextEl, this.attachments, true, this.images);
    this.resizeInput();
    this.setStatus(conversation.threadId ? "已连接既有对话" : "准备就绪");
    this.setBusy(this.busy);
  }

  public async refreshFromPlugin(): Promise<void> {
    if (this.closed || this.submitting || this.transitioning) return;
    try {
      this.busy = this.plugin.codex.running || pendingSubmissions.has(this.plugin);
      this.restoreComposer();
      await this.renderMessages();
      if (this.busy) this.setStatus("正在执行、停止或保存结果，请稍候…");
    } catch (error) { this.showError(error); }
  }

  public async newConversation(): Promise<void> { await this.startNewChat(); }

  public async addAttachment(attachment: ContextAttachment): Promise<void> {
    if (this.isLocked()) { new Notice("请等待当前操作完成后再添加引用。"); return; }
    const error = validateAttachments([...this.attachments, attachment]);
    if (error) { new Notice(error, 6000); return; }
    this.attachments.push({ ...attachment });
    this.renderAttachments(this.contextEl, this.attachments, true, this.images);
    try { await this.flushDraft(); } catch (error) { this.showError(error); }
    this.inputEl.focus();
  }

  private attachContext(kind: ContextAttachment["kind"]): void {
    if (this.isLocked()) return;
    const attachment = this.plugin.makeAttachment(kind);
    if (attachment) void this.addAttachment(attachment);
  }

  private async importImages(files: readonly File[], conversationId: string): Promise<void> {
    if (this.isLocked()) throw new Error("请等待当前操作完成后再添加图片。");
    if (conversationId !== this.composerConversationId) throw new Error("对话已切换，请在当前对话重新选择图片。");
    if (this.images.length + files.length > MAX_IMAGES) throw new Error("每条消息最多添加 4 张图片。");
    if (files.some((file) => !file.size || file.size > MAX_IMAGE_BYTES)) throw new Error("图片为空或超过单张 10 MiB 限制。");
    if (this.images.reduce((total, image) => total + image.size, 0) + files.reduce((total, file) => total + file.size, 0) > MAX_IMAGE_TOTAL_BYTES) throw new Error("图片合计超过 20 MiB，请分次添加。");
    // 首个 await 前锁定；文件选择/粘贴的异步结果只能归属原对话，关闭视图也不能串入新草稿。
    this.transitioning = true;
    this.setBusy(false);
    try {
      const contents: { file: File; bytes: Uint8Array }[] = [];
      for (const file of files) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        inspectImage(bytes);
        contents.push({ file, bytes });
      }
      const imported: ImageAttachment[] = [];
      for (const { file, bytes } of contents) imported.push(await this.plugin.images.add(file.name, bytes));
      if (this.closed || conversationId !== this.composerConversationId) return;
      const error = validateImages([...this.images, ...imported]);
      if (error) throw new Error(error);
      this.images.push(...imported);
      this.renderAttachments(this.contextEl, this.attachments, true, this.images);
      await this.flushDraft();
    } finally {
      this.transitioning = false;
      this.setBusy(false);
      if (!this.closed) this.inputEl.focus();
    }
  }

  private renderAttachments(container: HTMLElement, attachments: ContextAttachment[], removable: boolean, images: readonly ImageAttachment[] = []): void {
    container.empty();
    container.hidden = attachments.length === 0 && images.length === 0;
    for (const attachment of attachments) {
      const card = container.createDiv({ cls: "codex-notes-attachment" });
      const label = attachmentLabel(attachment);
      const preview = card.createEl("button", { text: label, cls: "codex-notes-attachment-label", attr: { title: `查看引用：${attachment.path}`, "aria-label": `查看引用 ${label}` } });
      preview.addEventListener("click", () => new AttachmentPreviewModal(this.plugin, attachment).open());
      if (removable) {
        const remove = card.createEl("button", { cls: "clickable-icon codex-notes-attachment-remove", attr: { "aria-label": `移除引用 ${label}`, title: "移除引用" } });
        setIcon(remove, "x");
        remove.disabled = this.isLocked();
        remove.addEventListener("click", () => {
          if (this.isLocked()) return;
          this.attachments = this.attachments.filter((item) => item.id !== attachment.id);
          this.renderAttachments(this.contextEl, this.attachments, true, this.images);
          void this.flushDraft().catch((error: unknown) => this.showError(error));
        });
      }
    }
    for (const image of images) {
      const card = container.createDiv({ cls: "codex-notes-attachment codex-notes-image-attachment" });
      const preview = card.createEl("button", { cls: "codex-notes-attachment-label codex-notes-image-label", attr: { "aria-label": `预览图片 ${image.name}`, title: `${image.name} · ${image.width}×${image.height}` } });
      if (removable) {
        const thumbnail = preview.createEl("img", { cls: "codex-notes-image-thumbnail", attr: { alt: image.name, loading: "lazy", decoding: "async" } });
        void setImageSource(this.plugin, thumbnail, image);
      } else setIcon(preview.createSpan(), "image");
      preview.createSpan({ text: image.name });
      preview.addEventListener("click", () => new ImagePreviewModal(this.plugin, image).open());
      if (removable) {
        const remove = card.createEl("button", { cls: "clickable-icon codex-notes-attachment-remove", attr: { "aria-label": `移除图片 ${image.name}`, title: "移除图片" } });
        setIcon(remove, "x"); remove.disabled = this.isLocked();
        remove.addEventListener("click", () => {
          if (this.isLocked()) return;
          this.images = this.images.filter(({ id }) => id !== image.id);
          this.renderAttachments(this.contextEl, this.attachments, true, this.images);
          void this.flushDraft().catch((error: unknown) => this.showError(error));
        });
      }
    }
  }

  private async renderMessages(): Promise<void> {
    // Markdown 渲染器可能注册链接和插件监听器，切换对话时卸载旧组件。
    if (this.messageRenderer) this.removeChild(this.messageRenderer);
    this.messageRenderer = this.addChild(new Component());
    this.messagesEl.empty();
    const messages = this.plugin.activeConversation.messages;
    if (!messages.length) {
      const empty = this.messagesEl.createDiv({ cls: "codex-notes-empty" });
      setIcon(empty.createDiv({ cls: "codex-notes-empty-icon" }), "sparkles");
      empty.createEl("h3", { text: "在 Obsidian 中与 Codex 协作" });
      empty.createEl("p", { text: "选中文字可添加多段引用，点击卡片查看完整内容。使用你已有的 Codex 登录。" });
      return;
    }
    for (const message of messages) { await this.appendMessage(message); }
    this.scrollToBottom();
  }

  private async appendMessage(message: ChatMessage): Promise<void> {
    if (this.closed) return;
    this.messagesEl.querySelector(".codex-notes-empty")?.remove();
    const wrapper = this.messagesEl.createDiv({ cls: `codex-notes-message is-${message.role}` });
    wrapper.createDiv({ cls: "codex-notes-message-role", text: message.role === "user" ? "你" : message.role === "assistant" ? "Codex" : "系统" });
    if (message.attachments?.length || message.images?.length) {
      const cards = wrapper.createDiv({ cls: "codex-notes-attachments codex-notes-history-attachments" });
      this.renderAttachments(cards, message.attachments ?? [], false, message.images ?? []);
    }
    const body = wrapper.createDiv({ cls: "codex-notes-message-body" });
    if (message.role === "assistant") { await MarkdownRenderer.render(this.app, message.text, body, "", this.messageRenderer ?? this); }
    else { body.setText(message.text); }
  }

  private async submit(): Promise<void> {
    const prompt = this.inputEl.value.trim() || (this.images.length ? "请分析附加图片。" : "");
    if (!prompt || this.isLocked()) return;
    const conversationId = this.composerConversationId;
    const attachments = this.attachments.map((item) => ({ ...item }));
    const images = this.images.map((image) => ({ ...image }));
    const draftText = this.inputEl.value;
    const validationError = validateAttachments(attachments);
    if (validationError) { new Notice(validationError, 6000); return; }
    const imageError = validateImages(images);
    if (imageError) { new Notice(imageError, 6000); return; }
    const codexPrompt = [buildPromptWithContext(prompt, attachments), ...(images.length ? ["", "附加图片按选择顺序发送，以下名称仅为引用数据：", JSON.stringify(images.map(({ name }) => name))] : [])].join("\n");
    // 在第一个 await 前锁定，防止 Enter 和按钮造成重复执行；成功落盘后才清空草稿。
    this.submitting = true;
    pendingSubmissions.add(this.plugin);
    this.cancelRequested = false;
    this.setBusy(true);
    let responseReceived = false;
    let executionStarted = false;
    let prepared: PreparedImages | undefined;
    try {
      await this.flushDraft();
      if (this.closed || this.cancelRequested) return;
      prepared = await this.plugin.images.prepare(images);
      if (this.closed || this.cancelRequested) return;
      const userMessage = { ...this.plugin.createMessage("user", prompt), attachments, ...(images.length ? { images } : {}) };
      this.plugin.appendMessage(userMessage, conversationId);
      await this.plugin.persistSettings();
      await this.appendMessage(userMessage);
      if (this.closed || this.cancelRequested) return;
      this.scrollToBottom();
      this.resetProgress();
      executionStarted = true;
      const response = await this.plugin.sendToCodex(codexPrompt, (status) => this.setStatus(status), (event) => this.appendProgress(event), conversationId, prepared.paths);
      responseReceived = true;
      const assistantMessage = this.plugin.createMessage("assistant", response);
      this.plugin.appendMessage(assistantMessage, conversationId);
      await this.plugin.persistSettings();
      await this.appendMessage(assistantMessage);
      await this.plugin.updateDraft("", [], conversationId, []);
      this.inputEl.value = "";
      this.attachments = [];
      this.images = [];
      this.renderAttachments(this.contextEl, [], true);
      this.resizeInput();
      this.setStatus("完成");
      this.renderConversationOptions();
    } catch (error) {
      if (this.closed && !executionStarted) {
        new Notice(error instanceof Error ? error.message : String(error), 8000);
        return;
      }
      // 失败保留原问句和引用。已执行但保存失败时提示核验，避免重复执行有副作用的任务。
      this.inputEl.value = draftText;
      this.attachments = attachments;
      this.images = images;
      this.renderAttachments(this.contextEl, attachments, true, images);
      try { await this.plugin.updateDraft(draftText, attachments, conversationId, images); } catch { /* 保留内存输入，禁止清空。 */ }
      const detail = error instanceof Error ? error.message : String(error);
      const message = responseReceived ? `Codex 已返回结果，但保存失败。草稿已保留，请核对结果后再决定是否重发。\n${detail}` : `执行失败或已停止，草稿和引用已保留。\n${detail}`;
      const systemMessage = this.plugin.createMessage("system", message);
      this.plugin.appendMessage(systemMessage, conversationId);
      try { await this.plugin.persistSettings(); } catch { /* 保存故障不能吞掉原始执行错误。 */ }
      await this.appendMessage(systemMessage);
      this.setStatus(responseReceived ? "结果保存失败" : "执行失败或已停止");
      new Notice(message, 8000);
    } finally {
      try { await prepared?.dispose(); } catch { new Notice("本次图片临时副本清理失败；原图片与对话仍保留。", 8000); }
      this.submitting = false;
      pendingSubmissions.delete(this.plugin);
      this.setBusy(false);
      if (this.cancelRequested && !executionStarted) this.setStatus("已停止，草稿已保留");
      this.scrollToBottom();
      if (!this.closed) this.inputEl.focus();
      // 旧视图在停止回调返回前可能已关闭，新视图仍需恢复草稿、消息及按钮状态。
      try { await this.plugin.refreshViews(this); } catch (error) { this.showError(error); }
    }
  }

  private async startNewChat(): Promise<void> {
    await this.transition(async () => { await this.plugin.startNewChat(); });
  }

  private async switchConversation(): Promise<void> {
    const id = this.conversationSelect.value;
    await this.transition(async () => { await this.plugin.selectConversation(id); });
  }

  private async transition(action: () => Promise<void>): Promise<void> {
    if (this.isLocked()) {
      this.conversationSelect.value = this.plugin.activeConversation.id;
      new Notice("请先等待当前操作完成。");
      return;
    }
    this.transitioning = true;
    this.setBusy(false);
    try {
      await this.flushDraft();
      await action();
      await this.refreshConversation();
    } catch (error) {
      this.showError(error);
      // 存储失败时主进程可能已选中新对话，恢复真实归属，避免显示与发送目标分离。
      if (this.composerConversationId !== this.plugin.activeConversation.id) {
        try { await this.refreshConversation(); } catch (refreshError) { this.showError(refreshError); }
      }
      else this.renderConversationOptions();
    }
    finally { this.transitioning = false; this.setBusy(false); }
  }

  private async refreshConversation(): Promise<void> {
    this.resetProgress();
    this.restoreComposer();
    await this.renderMessages();
    this.inputEl.focus();
  }

  private async openManager(): Promise<void> {
    if (this.isLocked()) { new Notice("请先等待当前操作完成。"); return; }
    this.transitioning = true;
    this.setBusy(false);
    try {
      await this.flushDraft();
      new ConversationManagerModal(this.plugin, async () => {
        this.transitioning = true;
        this.setBusy(false);
        await this.flushDraft();
      }, async () => {
        try { await this.refreshConversation(); }
        finally { this.transitioning = false; this.setBusy(false); }
      }, () => this.isLocked()).open();
    } catch (error) { this.showError(error); }
    finally { this.transitioning = false; this.setBusy(false); }
  }

  private renderConversationOptions(): void {
    this.conversationSelect.empty();
    for (const conversation of this.plugin.allConversations.filter(({ archived }) => !archived)) {
      const option = this.conversationSelect.createEl("option", { text: conversation.title, value: conversation.id });
      option.selected = conversation.id === this.plugin.activeConversation.id;
    }
  }

  private renderModelOptions(): void {
    this.modelSelect.empty();
    this.modelSelect.createEl("option", { text: "Codex 默认", value: "" });
    try {
      for (const model of this.plugin.getModels()) { this.modelSelect.createEl("option", { text: model.displayName, value: model.slug }); }
      this.modelCatalogErrorShown = false;
    } catch (error) {
      if (!this.modelCatalogErrorShown) {
        new Notice(`无法读取模型目录，将保留已选模型或 Codex 默认。${error instanceof Error ? error.message : String(error)}`, 8000);
        this.modelCatalogErrorShown = true;
      }
    }
    const model = this.plugin.activeConversation.model;
    if (model && !Array.from(this.modelSelect.options).some((option) => option.value === model)) {
      this.modelSelect.createEl("option", { text: `${model}（已保存）`, value: model });
    }
    this.modelSelect.value = model;
  }

  private async changeModel(): Promise<void> {
    if (this.isLocked()) { this.renderModelOptions(); return; }
    const model = this.modelSelect.value;
    this.transitioning = true;
    this.setBusy(false);
    try { await this.flushDraft(); await this.plugin.setModel(model); }
    catch (error) { this.showError(error); }
    finally { this.renderModelOptions(); this.transitioning = false; this.setBusy(false); }
  }

  private isLocked(): boolean { return this.closed || this.busy || this.transitioning || this.plugin.codex.running || pendingSubmissions.has(this.plugin); }
  private runAction(action: () => Promise<void>): void { void action().catch((error: unknown) => this.showError(error)); }
  private setBusy(busy: boolean): void {
    this.busy = busy;
    if (this.closed) return;
    const locked = this.isLocked();
    this.sendButton.disabled = locked;
    this.inputEl.disabled = locked;
    this.modelSelect.disabled = locked;
    this.conversationSelect.disabled = locked;
    for (const button of this.actionButtons) button.disabled = locked;
    for (const button of Array.from(this.contextEl.querySelectorAll<HTMLButtonElement>(".codex-notes-attachment-remove"))) button.disabled = locked;
    this.stopButton.hidden = !(busy || this.plugin.codex.running || pendingSubmissions.has(this.plugin));
    this.stopButton.disabled = false;
  }
  private resizeInput(): void { this.inputEl.style.height = "72px"; this.inputEl.style.height = `${Math.min(140, Math.max(72, this.inputEl.scrollHeight))}px`; }
  private setStatus(text: string): void { if (!this.closed) this.statusEl.setText(text); }
  private showError(error: unknown): void { const text = error instanceof Error ? error.message : String(error); this.setStatus("保存或操作失败，当前输入已保留"); new Notice(text, 8000); }
  private resetProgress(): void { this.progressEl.empty(); this.progressEl.hidden = true; }
  private appendProgress(event: CodexProgressEvent): void {
    if (this.closed) return;
    this.progressEl.hidden = false;
    const row = this.progressEl.createDiv({ cls: `codex-notes-progress-row is-${event.state}` });
    setIcon(row.createSpan({ cls: "codex-notes-progress-icon" }), eventIcon(event));
    row.createSpan({ text: event.label });
    while (this.progressEl.childElementCount > 8) this.progressEl.firstElementChild?.remove();
  }
  private scrollToBottom(): void { if (!this.closed) this.messagesEl.scrollTop = this.messagesEl.scrollHeight; }
}

async function setImageSource(plugin: CodexWorkspacePlugin, element: HTMLImageElement, image: ImageAttachment): Promise<void> {
  try {
    const path = await plugin.images.resourcePath(image);
    if (element.isConnected) element.src = plugin.app.vault.adapter.getResourcePath(path);
  } catch { if (element.isConnected) { element.alt = `图片不可用：${image.name}`; element.title = "图片缓存缺失或内容已变化，请重新添加。"; } }
}

class ImagePreviewModal extends Modal {
  constructor(private readonly plugin: CodexWorkspacePlugin, private readonly image: ImageAttachment) { super(plugin.app); }
  onOpen(): void {
    this.setTitle(this.image.name);
    this.contentEl.addClass("codex-notes-image-preview");
    this.contentEl.createDiv({ cls: "codex-notes-preview-meta", text: `${this.image.width}×${this.image.height} · ${(this.image.size / 1024).toFixed(0)} KiB` });
    const preview = this.contentEl.createEl("img", { attr: { alt: this.image.name, decoding: "async" } });
    void setImageSource(this.plugin, preview, this.image);
  }
  onClose(): void { this.contentEl.empty(); }
}

class AttachmentPreviewModal extends Modal {
  constructor(plugin: CodexWorkspacePlugin, private readonly attachment: ContextAttachment) { super(plugin.app); }
  onOpen(): void {
    this.setTitle("引用原文");
    this.contentEl.addClass("codex-notes-preview");
    this.contentEl.createDiv({ cls: "codex-notes-preview-path", text: this.attachment.path });
    this.contentEl.createDiv({ cls: "codex-notes-preview-meta", text: `${this.attachment.kind === "selection" ? "选中文字" : "完整笔记"}${this.attachment.startLine ? ` · 第 ${this.attachment.startLine}–${this.attachment.endLine ?? this.attachment.startLine} 行` : ""} · ${this.attachment.content.length.toLocaleString()} 字符` });
    this.contentEl.createEl("pre", { text: this.attachment.content });
  }
  onClose(): void { this.contentEl.empty(); }
}

class ConversationManagerModal extends Modal {
  private query = "";
  private pending = false;
  constructor(private readonly plugin: CodexWorkspacePlugin, private readonly beforeChange: () => Promise<void>, private readonly onChange: () => Promise<void>, private readonly isBusy: () => boolean) { super(plugin.app); }
  onOpen(): void { this.setTitle("管理对话"); this.renderBody(); }
  onClose(): void { this.contentEl.empty(); }
  private renderBody(): void {
    this.contentEl.empty();
    const search = this.contentEl.createEl("input", { type: "search", value: this.query, placeholder: "搜索对话标题…", attr: { "aria-label": "搜索对话" } });
    search.addEventListener("input", () => { this.query = search.value; this.renderList(); });
    this.contentEl.createDiv({ cls: "codex-notes-conversation-list" });
    this.renderList();
    search.focus();
  }
  private renderList(): void {
    const list = this.contentEl.querySelector<HTMLElement>(".codex-notes-conversation-list");
    if (!list) return;
    list.empty();
    const conversations = searchConversations(this.plugin.allConversations, this.query);
    if (!conversations.length) list.createDiv({ cls: "codex-notes-conversation-empty", text: "没有匹配的对话。" });
    for (const conversation of conversations) this.renderRow(list, conversation.id);
  }
  private async mutate(action: () => Promise<void>): Promise<void> {
    if (this.pending || this.isBusy()) { new Notice("请等待当前操作完成。"); return; }
    this.pending = true;
    try { await this.beforeChange(); await action(); await this.onChange(); this.renderList(); }
    catch (error) {
      new Notice(error instanceof Error ? error.message : String(error), 8000);
      // 归档、删除或切换可能已改变内存状态，落盘失败也必须刷新真实对话归属。
      try { await this.onChange(); this.renderList(); }
      catch (refreshError) { new Notice(refreshError instanceof Error ? refreshError.message : String(refreshError), 8000); }
    }
    finally { this.pending = false; }
  }
  private renderRow(list: HTMLElement, id: string): void {
    const conversation = this.plugin.allConversations.find((item) => item.id === id);
    if (!conversation) return;
    const row = list.createDiv({ cls: "codex-notes-conversation-row" });
    if (id === this.plugin.activeConversation.id) row.addClass("is-active");
    const details = row.createDiv({ cls: "codex-notes-conversation-details" });
    const title = details.createEl("input", { type: "text", value: conversation.title, attr: { "aria-label": `重命名 ${conversation.title}`, maxlength: "80" } });
    title.addEventListener("change", () => void this.mutate(async () => { await this.plugin.renameConversation(id, title.value); }));
    details.createDiv({ cls: "codex-notes-conversation-meta", text: `${conversation.messages.length} 条消息 · ${conversation.archived ? "已归档" : "使用中"}` });
    const actions = row.createDiv({ cls: "codex-notes-conversation-row-actions" });
    if (!conversation.archived && id !== this.plugin.activeConversation.id) this.iconButton(actions, "message-circle", "切换至此对话", () => this.mutate(async () => { await this.plugin.selectConversation(id); }));
    this.iconButton(actions, conversation.archived ? "archive-restore" : "archive", conversation.archived ? "恢复" : "归档", () => this.mutate(async () => { await this.plugin.setConversationArchived(id, !conversation.archived); }));
    this.iconButton(actions, "file-down", "导出 Markdown", async () => {
      try { const path = await this.plugin.exportConversation(id); new Notice(`已导出至 ${path}`, 5000); }
      catch (error) { new Notice(error instanceof Error ? error.message : String(error), 8000); }
    });
    this.iconButton(actions, "trash-2", "删除", async () => {
      if (this.pending || this.isBusy()) { new Notice("请等待当前操作完成。"); return; }
      new DeleteConversationModal(this.plugin, id, () => this.mutate(async () => { await this.plugin.deleteConversation(id); })).open();
    });
  }
  private iconButton(parent: HTMLElement, icon: string, label: string, action: () => Promise<void>): void {
    const button = parent.createEl("button", { cls: "clickable-icon", attr: { "aria-label": label, title: label } });
    setIcon(button, icon);
    button.addEventListener("click", () => void action().catch((error: unknown) => new Notice(error instanceof Error ? error.message : String(error), 8000)));
  }
}

class DeleteConversationModal extends Modal {
  constructor(private readonly plugin: CodexWorkspacePlugin, private readonly conversationId: string, private readonly onDelete: () => Promise<void>) { super(plugin.app); }
  onOpen(): void {
    const title = this.plugin.allConversations.find((item) => item.id === this.conversationId)?.title ?? "此对话";
    this.setTitle(`删除“${title}”？`);
    this.contentEl.createEl("p", { text: "将删除当前 Vault 保存的消息、草稿和 thread 引用。不会删除 Codex 服务端的账号记录。此操作不可撤销。" });
    const actions = this.contentEl.createDiv({ cls: "codex-notes-confirm-actions" });
    actions.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
    const confirm = actions.createEl("button", { text: "删除", cls: "mod-warning" });
    confirm.addEventListener("click", () => {
      confirm.disabled = true;
      void this.onDelete().then(() => this.close()).catch((error: unknown) => {
        confirm.disabled = false;
        new Notice(error instanceof Error ? error.message : String(error), 8000);
      });
    });
  }
  onClose(): void { this.contentEl.empty(); }
}

function attachmentLabel(attachment: ContextAttachment): string {
  const filename = attachment.path.split("/").pop() ?? attachment.path;
  const lines = attachment.startLine ? `:${attachment.startLine}${attachment.endLine && attachment.endLine !== attachment.startLine ? `–${attachment.endLine}` : ""}` : "";
  return `${filename}${lines}`;
}
function eventIcon(event: CodexProgressEvent): string {
  if (event.state === "error") return "circle-x";
  if (event.state === "success") return "circle-check";
  if (event.kind === "command") return "terminal";
  if (event.kind === "file") return "file-pen-line";
  if (event.kind === "tool") return "wrench";
  return "loader-circle";
}
