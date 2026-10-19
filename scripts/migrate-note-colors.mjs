import { readFile, writeFile, mkdir, rename, realpath, stat } from "node:fs/promises";
import { resolve, join, dirname, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import { migrateMarkdownColors } from "../src/markdown-colors.ts";
import { migrateOwnedCodeToNative } from "../src/native-code-colors.ts";
import { migrateOwnedTextToNative } from "../src/native-text-colors.ts";
import { parseNoteColors } from "../src/color-ranges.ts";

// 默认仅生成计划；--apply 只适用于已退出 Obsidian 的本地 Vault。
// .md 与 sidecar 没有跨文件原子事务，顺序必须是备份、写正文、读回、移除旧范围。
const args = process.argv.slice(2);
if (!args[0] || args.some((arg, i) => i > 0 && arg !== "--apply")) {
  throw new Error("用法：node --experimental-strip-types scripts/migrate-note-colors.mjs /完整/Vault/路径 [--apply]；执行前退出 Obsidian。");
}
const vault = await realpath(resolve(args[0]));
const apply = args.includes("--apply");
const sidecar = join(vault, ".obsidian/plugins/codex-notes/note-colors.json");
const sidecarBytes = await readFile(sidecar);
const original = JSON.parse(sidecarBytes.toString("utf8"));
const validated = parseNoteColors(original);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const plans = [];
const filenames = new Set();

// 先核验全部记录并在内存生成候选；任何一篇不确定就拒绝本轮，不迁移半个预检集。
for (const [path, note] of Object.entries(validated.notes)) {
  const filename = resolve(vault, path);
  if (!path.endsWith(".md") || path !== relative(vault, filename).split(sep).join("/") || path.includes("\\") || !filename.startsWith(vault + sep) || await realpath(filename) !== filename || filenames.has(filename)) {
    throw new Error(`迁移路径不合法或包含符号链接：${path}`);
  }
  filenames.add(filename);
  const result = migrateMarkdownColors(note.text, note.ranges);
  const before = await readFile(filename);
  const snapshot = Buffer.from(note.text);
  const legacyAfter = Buffer.from(result.text);
  const after = Buffer.from(migrateOwnedTextToNative(migrateOwnedCodeToNative(result.text)).text);
  // 兼容上一版已写 HTML、尚未提交 sidecar 的中断；仅接受快照、旧精确 HTML 或最终原生结果。
  // 其他修改绝不猜 offset 或覆盖，避免把用户在失败后的新编辑当成迁移中间态。
  if (!before.equals(snapshot) && !before.equals(legacyAfter) && !before.equals(after)) throw new Error(`正文既不等于颜色快照，也不等于可证明的迁移结果，未写入任何文件：${path}`);
  plans.push({ path, filename, before, snapshot, after, recovered: !before.equals(snapshot), mode: (await stat(filename)).mode & 0o777 });
}
const summary = plans.map(({ path, before, snapshot, after, recovered }) => ({ path, beforeSha256: hash(snapshot), observedSha256: hash(before), afterSha256: hash(after), changed: !before.equals(after), recovered }));
if (!apply) {
  console.log(JSON.stringify({ mode: "dry-run", vault, notes: summary, instruction: "核对后退出 Obsidian，再追加 --apply。" }, null, 2));
} else if (!plans.length) {
  console.log(JSON.stringify({ mode: "apply", vault, notes: [], message: "没有待迁移记录。" }, null, 2));
} else {
  if (!(await readFile(sidecar)).equals(sidecarBytes)) throw new Error("颜色记录在预检期间改变，已停止迁移。");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = join(vault, ".obsidian/codex-notes-backups", `portable-colors-${stamp}`);
  await mkdir(backup, { recursive: false });
  await writeFile(join(backup, "note-colors.json"), sidecarBytes, { mode: 0o600, flag: "wx" });
  // 全部原文备份先落盘；报告只有哈希，不包含笔记正文。
  for (const plan of plans) {
    const saved = resolve(backup, "notes", plan.path);
    if (!saved.startsWith(join(backup, "notes") + sep)) throw new Error(`备份路径越界：${plan.path}`);
    await mkdir(dirname(saved), { recursive: true });
    await writeFile(saved, plan.before, { mode: 0o600, flag: "wx" });
    if (plan.recovered) {
      const snapshot = resolve(backup, "source-snapshots", plan.path);
      if (!snapshot.startsWith(join(backup, "source-snapshots") + sep)) throw new Error(`快照路径越界：${plan.path}`);
      await mkdir(dirname(snapshot), { recursive: true });
      await writeFile(snapshot, plan.snapshot, { mode: 0o600, flag: "wx" });
    }
  }
  const report = { mode: "apply", vault, backup, notes: [] };
  await writeFile(join(backup, "migration.json"), JSON.stringify({ ...report, plan: summary }, null, 2), { mode: 0o600 });
  let expectedSidecar = sidecarBytes;
  for (const plan of plans) {
    if (!(await readFile(plan.filename)).equals(plan.before)) throw new Error(`备份后正文发生改变，已停止：${plan.path}`);
    if (!(await readFile(sidecar)).equals(expectedSidecar)) throw new Error("颜色记录被其他进程修改，已停止迁移。");
    if (!plan.before.equals(plan.after)) {
      const temporary = `${plan.filename}.codex-colors-${stamp}.tmp`;
      await writeFile(temporary, plan.after, { mode: plan.mode, flag: "wx" });
      if (!(await readFile(plan.filename)).equals(plan.before)) throw new Error(`写入前正文发生改变，已停止：${plan.path}`);
      await rename(temporary, plan.filename);
    }
    if (!(await readFile(plan.filename)).equals(plan.after)) throw new Error(`正文写入后核验失败，旧颜色记录保留：${plan.path}`);
    // 每篇核验后独立记录完成状态，失败不能提前移除其他篇的旧范围。
    delete original.notes[plan.path];
    const next = Buffer.from(JSON.stringify(original, null, 2) + "\n");
    const temporary = `${sidecar}.migration-${stamp}.tmp`;
    await writeFile(temporary, next, { mode: 0o600 });
    if (!(await readFile(sidecar)).equals(expectedSidecar)) throw new Error("提交记录前检测到并发修改，旧记录未覆盖。");
    await rename(temporary, sidecar);
    if (!(await readFile(sidecar)).equals(next)) throw new Error("迁移记录写入后核验失败，请保留备份并停止重试。");
    expectedSidecar = next;
    report.notes.push(summary.find(({ path }) => path === plan.path));
    await writeFile(join(backup, "migration.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  }
  console.log(JSON.stringify(report, null, 2));
}
