import { EditorState, StateField, ChangeSet } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import { mapColorRanges, normalizeColor, replaceColor, mergeRanges, type ColorRange, type ColorProperty } from "./color-ranges.ts";
import { nativeTextBlocks, nativeTextDocumentShape, nativeTextMetadataRecords, restoreOwnedInline, formatMarkdownSelection, type PortableColorEdit } from "./markdown-colors.ts";

const MARKER = "<!-- noteglow-text-colors:", PREFIX = MARKER + "1 ";
const MAX_TEXT = 1_000_000, MAX_BLOCK = 200_000;
export interface NativeTextBlock {
  from: number; to: number; line: number; kind: string; structure: string; supported: boolean;
  units: Array<{ from: number; to: number }>; source: string; eol: string;
  metadataFrom: number; metadataTo: number; commentFrom: number;
  status: "none" | "valid" | "stale" | "invalid"; ranges: ColorRange[];
}
function boundary(text: string, at: number): boolean {
  return !(at > 0 && at < text.length && (/[\uD800-\uDBFF]/.test(text[at - 1]) && /[\uDC00-\uDFFF]/.test(text[at]) || text[at - 1] === "\r" && text[at] === "\n"));
}
function validRanges(ranges: unknown, source: string): ranges is ColorRange[] {
  if (!Array.isArray(ranges) || ranges.length > 10000) return false;
  const ends = { foreground: 0, background: 0 };
  return ranges.every((range) => {
    if (!range || Object.keys(range).sort().join() !== "color,from,property,to" || !["foreground", "background"].includes(range.property) || !Number.isInteger(range.from) || !Number.isInteger(range.to) || range.from < 0 || range.from >= range.to || range.to > source.length || !boundary(source, range.from) || !boundary(source, range.to) || typeof range.color !== "string" || normalizeColor(range.color) !== range.color) return false;
    const property = range.property as ColorProperty;
    if (range.from < ends[property]) return false;
    ends[property] = range.to; return true;
  });
}
export function encodeNativeTextMetadata(source: string, ranges: readonly ColorRange[]): string {
  if (source.length > MAX_BLOCK || !validRanges(ranges, source)) throw new Error("正文颜色记录超限或范围无效。");
  return PREFIX + JSON.stringify({ version: 1, source, ranges }).replace(/[<>&-]/g, (value) => `\\u${value.charCodeAt(0).toString(16).padStart(4, "0")}`) + " -->";
}
const cache = new Map<string, NativeTextBlock[]>();
/** 两个新增换行只属于记录；完整顶层块之外插入，不改变列表内部紧凑性。 */
export function scanNativeText(text: string): NativeTextBlock[] {
  if (text.length > MAX_TEXT) return [];
  const cached = cache.get(text); if (cached) return cached;
  let parsed: ReturnType<typeof nativeTextBlocks>;
  try { parsed = nativeTextBlocks(text); } catch { return []; }
  const blocks = parsed.map((item): NativeTextBlock => {
    const source = text.slice(item.from, item.to), eol = source.includes("\r\n") || text.includes("\r\n") ? "\r\n" : "\n";
    const block: NativeTextBlock = { ...item, supported: item.supported && source.length <= MAX_BLOCK, source, eol, metadataFrom: item.to, metadataTo: item.to, commentFrom: item.to, status: "none", ranges: [] };
    const separator = /^(\r\n|\n)\1/.exec(text.slice(item.to));
    if (!separator || !text.startsWith(MARKER, item.to + separator[0].length)) return block;
    block.commentFrom = item.to + separator[0].length;
    const end = text.indexOf("\n", block.commentFrom), raw = text.slice(block.commentFrom, end < 0 ? text.length : end).replace(/\r$/, "");
    block.metadataTo = block.commentFrom + raw.length; block.status = "invalid";
    try {
      if (!raw.startsWith(PREFIX) || !raw.endsWith(" -->")) return block;
      const data = JSON.parse(raw.slice(PREFIX.length, -4));
      if (!data || Object.keys(data).sort().join() !== "ranges,source,version" || data.version !== 1 || typeof data.source !== "string" || encodeNativeTextMetadata(data.source, data.ranges) !== raw) return block;
      block.status = item.supported && data.source === source ? "valid" : "stale";
      if (block.status === "valid") block.ranges = data.ranges;
    } catch { /* 损坏记录保留，用户可通过重置命令清理。 */ }
    return block;
  });
  cache.set(text, blocks); while (cache.size > 2) cache.delete(cache.keys().next().value!);
  return blocks;
}
export function nativeTextColorRanges(text: string): ColorRange[] {
  return scanNativeText(text).filter((block) => block.status === "valid").flatMap((block) => block.ranges.map((range) => ({ ...range, from: range.from + block.from, to: range.to + block.from })));
}
function selectedBlock(text: string, from: number, to: number): NativeTextBlock {
  if (text.length > MAX_TEXT || from < 0 || from >= to || to > text.length || !boundary(text, from) || !boundary(text, to)) throw new Error("正文选区无效或笔记过大。");
  const blocks = scanNativeText(text).filter((block) => from < block.to && to > block.from);
  if (blocks.length !== 1 || !blocks[0].supported || from < blocks[0].from || to > blocks[0].to) throw new Error("请选择同一段落、标题或列表内的正文；未知 HTML、引用、表格和嵌套代码暂不支持。旧 HTML 请先执行恢复原生正文命令。");
  const block = blocks[0];
  if (block.status === "invalid" || block.status === "stale") throw new Error("正文颜色记录已过期或损坏，原文已保留；请执行“重置当前笔记的正文颜色记录”后重新着色。");
  return block;
}
function writeRanges(text: string, block: NativeTextBlock, ranges: ColorRange[]): string {
  const insert = ranges.length ? block.eol + block.eol + encodeNativeTextMetadata(block.source, mergeRanges(ranges)) : "";
  const output = text.slice(0, block.to) + insert + text.slice(block.metadataTo);
  if (output.length > MAX_TEXT) throw new Error("包含颜色记录后超过 100 万字符，未修改。");
  if (nativeTextDocumentShape(text) !== nativeTextDocumentShape(output)) throw new Error("颜色记录将改变列表或段落结构，原文已保留。");
  return output;
}
export function applyNativeTextColor(text: string, from: number, to: number, property?: ColorProperty, color?: string): PortableColorEdit {
  const block = selectedBlock(text, from, to);
  if (property && !normalizeColor(color ?? "")) throw new Error("请输入 #RGB 或 #RRGGBB。");
  const units = block.units.filter((unit) => unit.from < to && unit.to > from);
  if (!units.length || units.some((unit) => unit.from < from || unit.to > to)) throw new Error("请选择完整文字，不能拆开实体或只选择格式标签。");
  let ranges = block.ranges;
  const intervals: Array<{ from: number; to: number }> = [];
  for (const unit of units) { const last = intervals[intervals.length - 1]; if (last && unit.from <= last.to) last.to = Math.max(last.to, unit.to); else intervals.push({ ...unit }); }
  for (const unit of intervals) ranges = replaceColor(ranges, unit.from - block.from, unit.to - block.from, property, color);
  return { text: writeRanges(text, block, ranges), from, to };
}
/** 格式只在本块原生 Markdown 上执行；携带颜色通过解析器的精确位置映射，绝不重建 HTML。 */
export function formatNativeText(text: string, from: number, to: number, format: "bold" | "italic" | "code", applyOnly = false): PortableColorEdit {
  const block = selectedBlock(text, from, to);
  const result = formatMarkdownSelection(block.source, from - block.from, to - block.from, format, block.ranges, true, applyOnly);
  const parsed = nativeTextBlocks(result.text);
  if (parsed.length !== 1 || !parsed[0].supported || parsed[0].kind !== block.kind || parsed[0].from !== 0 || parsed[0].to !== result.text.length) throw new Error("格式修改将改变段落结构，原文已保留。");
  const replacement = result.text + ((result.ranges?.length ?? 0) ? block.eol + block.eol + encodeNativeTextMetadata(result.text, result.ranges!) : "");
  return { text: text.slice(0, block.from) + replacement + text.slice(block.metadataTo), from: block.from + result.from, to: block.from + result.to };
}
/** 仅原块结构保持完整时同步快照。分裂、合并、未知结构不猜测迁移，保留旧记录供重置。 */
export function nativeTextMetadataChanges(before: string, after: string, changes: ChangeSet): Array<{ from: number; to: number; insert: string }> {
  const next = scanNativeText(after), edits: Array<{ from: number; to: number; insert: string }> = [];
  for (const old of scanNativeText(before)) {
    if (old.status !== "valid") continue;
    let touched = false, unsafe = false;
    changes.iterChangedRanges((from, to) => { if (from > old.to && from < old.metadataTo || to > old.to && from < old.metadataTo) unsafe = true; if (from >= old.from && to <= old.to) touched = true; });
    if (unsafe || !touched) continue;
    const block = next.find((item) => item.from === changes.mapPos(old.from, -1) && item.to === changes.mapPos(old.to, 1) && item.kind === old.kind && item.structure === old.structure && item.supported);
    if (!block || block.status === "none" || after.slice(block.to, block.metadataTo) !== before.slice(old.to, old.metadataTo)) continue;
    const ranges = mapColorRanges(old.ranges.map((range) => ({ ...range, from: old.from + range.from, to: old.from + range.to })), (position, association) => changes.mapPos(position, association)).map((range) => ({ ...range, from: range.from - block.from, to: range.to - block.from }));
    if (!validRanges(ranges, block.source)) continue;
    edits.push({ from: block.commentFrom, to: block.metadataTo, insert: encodeNativeTextMetadata(block.source, ranges) });
  }
  return edits;
}
export const nativeTextColorTransactions = EditorState.transactionFilter.of((transaction) => {
  if (!transaction.docChanged || !(transaction.isUserEvent("input") || transaction.isUserEvent("delete") || transaction.isUserEvent("indent"))) return transaction;
  const before = transaction.startState.doc.toString(); if (!before.includes(MARKER)) return transaction;
  const changes = nativeTextMetadataChanges(before, transaction.newDoc.toString(), transaction.changes);
  return changes.length ? [transaction, { changes, sequential: true }] : transaction;
});
export function createNativeTextMetadataField(live: (state: EditorState) => boolean): StateField<DecorationSet> {
  const ranges = (state: EditorState) => scanNativeText(state.doc.toString()).filter((block) => block.status === "valid" || block.status === "stale");
  const decorations = (state: EditorState) => live(state) ? Decoration.set(ranges(state).map((block) => Decoration.replace({ block: true }).range(block.commentFrom, block.metadataTo)), true) : Decoration.none;
  return StateField.define({ create: decorations, update: (value, tr) => tr.docChanged || live(tr.state) !== live(tr.startState) ? decorations(tr.state) : value,
    provide: (field) => [EditorView.decorations.from(field), EditorView.atomicRanges.of((view) => view.state.field(field)), EditorState.changeFilter.of((tr) => {
      if (!tr.docChanged || !tr.isUserEvent("delete") || !live(tr.startState) || tr.startState.selection.ranges.length !== 1 || !tr.startState.selection.main.empty) return true;
      let allowed = true; const blocks = ranges(tr.startState);
      const text = tr.startState.doc.toString();
      // 记录后的首个换行维持独立 HTML 注释行；删除它会把下一段拼到注释结束符后。
      tr.changes.iterChangedRanges((from, to) => { if (blocks.some((block) => from < block.metadataTo + (/^(?:\r\n|\n)/.exec(text.slice(block.metadataTo))?.[0].length ?? 0) && to > block.to)) allowed = false; }); return allowed;
    })]
  });
}
/** 重置只清理当前笔记中独立的自有记录行，不触碰快照中的正文或其他 HTML。 */
export function resetNativeTextMetadata(text: string): string {
  let output = text;
  for (const record of nativeTextMetadataRecords(text).reverse()) output = output.slice(0, record.from) + output.slice(record.to);
  return output;
}
export function migrateOwnedTextToNative(text: string): { text: string; count: number; map(position: number): number } {
  const restored = restoreOwnedInline(text);
  if (!restored.count) return { text, count: 0, map: (position) => position };
  let output = restored.text;
  // 已有原生记录不能被旧 HTML 还原静默移位；必须先人工重置或分离旧结构。
  if (restored.count && text.includes(MARKER)) throw new Error("笔记同时包含旧 HTML 与正文颜色记录，请先备份并重置正文颜色记录后恢复。");
  for (const range of [...restored.ranges].sort((a, b) => b.from - a.from || b.to - a.to)) output = applyNativeTextColor(output, range.from, range.to, range.property, range.color).text;
  // 从后向前插入记录，只有前方块的记录会平移后面的光标；逐块按精确快照匹配位置。
  const blocks = scanNativeText(output).filter((block) => block.status === "valid");
  return { text: output, count: restored.count, map: (position) => { let at = restored.map(position); for (const block of blocks) if (block.to < at) at += block.metadataTo - block.to; return at; } };
}
