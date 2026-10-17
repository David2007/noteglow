import { mkdir, readFile, writeFile, copyFile, access, realpath } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { splitLegacyDraft } from "../src/legacy-draft.ts";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vault = resolve(process.argv[2] || "");
if (!process.argv[2]) throw new Error("请指定 Vault 路径：npm run install:local -- /完整/Vault/路径 [旧草稿JSON]");
const settings = join(vault, ".obsidian");
await access(settings);
const target = join(settings, "plugins", "codex-notes");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backup = join(settings, "codex-notes-backups", stamp);
await mkdir(backup, { recursive: true });

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}
async function backupFile(relative) {
  const input = join(settings, relative);
  try {
    await access(input);
    const output = join(backup, relative);
    await mkdir(dirname(output), { recursive: true });
    await copyFile(input, output);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
}
async function saveJson(path, data) {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  const { rename } = await import("node:fs/promises");
  await rename(temporary, path);
}

for (const relative of ["community-plugins.json", "workspace.json", "hotkeys.json", "plugins/editing-toolbar/data.json", "plugins/codex-workspace/data.json", "plugins/codex-selection/data.json", "plugins/codex-notes/data.json", "plugins/codex-notes/note-colors.json", ...["main.js", "manifest.json", "styles.css", "LICENSE", "THIRD_PARTY_NOTICES.txt"].map((file) => `plugins/codex-notes/${file}`)]) await backupFile(relative);
const old = await readJson(join(settings, "plugins", "codex-workspace", "data.json"), null);
const selected = await readJson(join(settings, "plugins", "codex-selection", "data.json"), { model: "" });
const ownData = await readJson(join(target, "data.json"), null);
await mkdir(target, { recursive: true });
let importedCards = 0;

if (!ownData && old) {
  // 原对话/消息/threadId 原样复制；仅为自有草稿字段补默认值，迁移不改旧插件数据。
  const imported = structuredClone(old);
  for (const conversation of imported.conversations ?? []) {
    conversation.draftText = "";
    conversation.draftAttachments = [];
    conversation.model = typeof selected.model === "string" ? selected.model : "";
  }
  const active = imported.conversations?.find(({ id }) => id === imported.activeConversationId);
  if (active && process.argv[3]) {
    const savedDraft = await readJson(resolve(process.argv[3]), { text: "" });
    const parsed = splitLegacyDraft(savedDraft.text);
    active.draftText = parsed.draftText;
    active.draftAttachments = parsed.attachments;
    importedCards = parsed.attachments.length;
    await copyFile(resolve(process.argv[3]), join(backup, "unsent-draft.json"));
    for (const attachment of active.draftAttachments) {
      // 行号仅在 Vault 内唯一精确匹配时补充，长路径与同文多处不制造假来源。
      const candidate = resolve(vault, attachment.path);
      if (!candidate.startsWith(vault + sep)) continue;
      try {
        const actual = await realpath(candidate);
        if (!actual.startsWith(vault + sep)) continue;
        const note = await readFile(actual, "utf8");
        const offset = note.indexOf(attachment.content);
        if (offset >= 0 && note.indexOf(attachment.content, offset + 1) < 0) {
          attachment.startLine = note.slice(0, offset).split("\n").length;
          attachment.endLine = attachment.startLine + attachment.content.split("\n").length - 1;
        }
      } catch { /* 源文件不在本机时仍保留原文快照和路径。 */ }
    }
  }
  // 保留各用户已有 CLI 路径；本机找不到时由用户在设置中指定，不植入维护者的路径。
  await saveJson(join(target, "data.json"), imported);
}

for (const file of ["main.js", "manifest.json", "styles.css", "LICENSE", "THIRD_PARTY_NOTICES.txt"]) {
  await copyFile(join(source, file), join(target, file));
  const expected = createHash("sha256").update(await readFile(join(source, file))).digest("hex");
  const actual = createHash("sha256").update(await readFile(join(target, file))).digest("hex");
  if (expected !== actual) throw new Error(`部署校验失败：${file}`);
}
const enabled = await readJson(join(settings, "community-plugins.json"), []);
await saveJson(join(settings, "community-plugins.json"), [...enabled.filter((id) => !["codex-workspace", "codex-selection", "codex-notes"].includes(id)), "codex-notes"]);
const toolbarPath = join(settings, "plugins", "editing-toolbar", "data.json");
const toolbar = await readJson(toolbarPath, null);
if (toolbar) {
  const colorButtons = {
    "codex-notes:change-font-color": {
      picker: "codex-notes:pick-font-color", name: "更换字体颜色",
      icon: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="m7 16 5-12 5 12m-8-4h6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 21h18" stroke="var(--codex-notes-last-foreground, #c0392b)" stroke-width="3"/></svg>'
    },
    "codex-notes:change-background-color": {
      picker: "codex-notes:pick-background-color", name: "更换背景颜色",
      icon: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="m9 11 6-7 5 5-7 6-4-4Zm0 0-4 5 3 2 5-3" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M3 21h18" stroke="var(--codex-notes-last-background, #fff88f)" stroke-width="3"/></svg>'
    }
  };
  const pickerIcon = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path class="codex-notes-color-dropdown" d="m7 10 5 5 5-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const commands = {
    "codex-selection:add-selection-to-codex": "codex-notes:add-selection-to-codex",
    "editing-toolbar:toggle-bold": "codex-notes:toggle-bold",
    "editing-toolbar:toggle-italics": "codex-notes:toggle-italic",
    "editor:toggle-bold": "codex-notes:toggle-bold",
    "editor:toggle-italics": "codex-notes:toggle-italic",
    "editor:toggle-code": "codex-notes:toggle-code",
    "editing-toolbar:change-font-color": "codex-notes:change-font-color",
    "editing-toolbar:change-background-color": "codex-notes:change-background-color"
  };
  for (const value of Object.values(toolbar)) if (Array.isArray(value)) {
    for (const command of value) if (command?.id && commands[command.id]) command.id = commands[command.id];
  }
  // 复用已有工具栏命令：大按钮快速应用，小箭头打开调色；移除旧箭头再插入保证更新幂等。
  for (const key of ["menuCommands", "followingCommands", "topCommands", "fixedCommands", "mobileCommands"]) {
    if (!Array.isArray(toolbar[key])) continue;
    const existing = toolbar[key].filter((command) => !Object.values(colorButtons).some(({ picker }) => command?.id === picker));
    toolbar[key] = existing.flatMap((command) => {
      const color = colorButtons[command?.id];
      if (!color) return [command];
      return [{ ...command, icon: color.icon }, { id: color.picker, name: color.name, icon: pickerIcon }];
    });
  }
  // 只扩展已有选区工具栏，重复安装不重复追加；清除颜色由自有源码写回命令处理。
  for (const key of ["menuCommands", "followingCommands"]) {
    if (Array.isArray(toolbar[key]) && !toolbar[key].some(({ id }) => id === "codex-notes:clear-selection-colors")) {
      toolbar[key].push({ id: "codex-notes:clear-selection-colors", name: "清除颜色", icon: "eraser" });
    }
  }
  toolbar.cMenuNumRows = Math.max(toolbar.cMenuNumRows ?? 6, toolbar.followingCommands?.length ?? 0);
  await saveJson(toolbarPath, toolbar);
}
const hotkeysPath = join(settings, "hotkeys.json");
const hotkeys = await readJson(hotkeysPath, {});
if (hotkeys["codex-selection:add-selection-to-codex"] && !hotkeys["codex-notes:add-selection-to-codex"]) {
  hotkeys["codex-notes:add-selection-to-codex"] = hotkeys["codex-selection:add-selection-to-codex"];
}
// 格式快捷键和浮层共用兼容命令，避免原生加粗把 ** 插入颜色 span 内。
// 迁移原命令的自定义键；重复安装保留自有命令的当前设置，不覆盖其他快捷键。
for (const [native, own, defaults] of [
  ["editor:toggle-bold", "codex-notes:toggle-bold", [{ modifiers: ["Mod"], key: "B" }]],
  ["editor:toggle-italics", "codex-notes:toggle-italic", [{ modifiers: ["Mod"], key: "I" }]],
  ["editor:toggle-code", "codex-notes:toggle-code", [{ modifiers: ["Mod", "Shift"], key: "C" }]]
]) {
  if (!Object.hasOwn(hotkeys, own)) hotkeys[own] = Object.hasOwn(hotkeys, native) ? hotkeys[native] : defaults;
  hotkeys[native] = [];
}
await saveJson(hotkeysPath, hotkeys);
const workspacePath = join(settings, "workspace.json");
const workspace = await readJson(workspacePath, null);
function replaceView(value) {
  if (!value || typeof value !== "object") return;
  if (value.type === "codex-workspace-chat") value.type = "codex-notes-chat";
  for (const child of Object.values(value)) replaceView(child);
}
if (workspace) { replaceView(workspace); await saveJson(workspacePath, workspace); }
const manifest = await readJson(join(source, "manifest.json"));
console.log(JSON.stringify({ installed: target, version: manifest.version, importedConversations: ownData ? 0 : old?.conversations?.length ?? 0, importedCards, backup }, null, 2));
