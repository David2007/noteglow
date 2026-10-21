import { App, PluginSettingTab, Setting } from "obsidian";
import type CodexWorkspacePlugin from "../main";
import type { SandboxMode } from "./types";

export class CodexSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: CodexWorkspacePlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName("常规设置").setHeading();

    new Setting(containerEl)
      .setName("Codex CLI 路径")
      .setDesc("留空或填 codex 会自动寻找；也可填完整可执行文件路径。")
      .addText((text) =>
        text
          .setPlaceholder("codex")
          .setValue(this.plugin.settings.codexPath)
          .onChange(async (value) => {
            this.plugin.settings.codexPath = value.trim() || "codex";
            await this.plugin.persistSettings();
          })
      );

    new Setting(containerEl)
      .setName("Vault 权限")
      .setDesc("只读只允许分析；工作区写入允许 Codex 整理和修改当前 Vault。")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("read-only", "只读")
          .addOption("workspace-write", "工作区写入")
          .setValue(this.plugin.settings.sandboxMode)
          .onChange(async (value) => {
            this.plugin.settings.sandboxMode = value as SandboxMode;
            await this.plugin.persistSettings();
          })
      );

    new Setting(containerEl)
      .setName("自动审核批准要求")
      .setDesc("工作区写入模式下交由 Codex 自动审核；只读模式仍固定使用 read-only 沙箱。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.approveForMe).onChange(async (value) => {
          this.plugin.settings.approveForMe = value;
          await this.plugin.persistSettings();
        })
      );

    new Setting(containerEl).setName("粘贴代码时自动格式化")
      .setDesc("普通代码块和 /code 内粘贴时识别 Go、Python、Java；已有颜色记录的块保留原文。")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.autoFormatCode).onChange(async (value) => {
        this.plugin.settings.autoFormatCode = value;
        await this.plugin.persistSettings();
      }));
    for (const [key, label, example] of [["gofmtPath", "gofmt 路径", "/usr/local/go/bin/gofmt"], ["blackPath", "Black 路径", "/opt/homebrew/bin/black"]] as const) {
      new Setting(containerEl).setName(label)
        .setDesc(`可选单个可执行文件路径，留空自动寻找。不支持命令参数；例如 ${example}。更改后下次粘贴生效，找不到工具保留原文。`)
        .addText((text) => text.setValue(this.plugin.settings[key]).setPlaceholder(example).onChange(async (value) => {
          this.plugin.settings[key] = value.trim();
          await this.plugin.persistSettings();
        }));
    }

    const security = containerEl.createDiv({ cls: "codex-notes-settings-note" });
    security.createEl("strong", { text: "安全边界" });
    security.createEl("p", {
      text: "此插件不保存 API Key，也不绕过 Codex 沙箱。对话与 session ID 只保存在此 Vault 的插件数据中。"
    });
  }
}
