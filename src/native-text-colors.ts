import { EditorState, StateField, ChangeSet } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import { mapColorRanges, normalizeColor, replaceColor, mergeRanges, type ColorRange, type ColorProperty } from "./color-ranges.ts";
import { nativeTextBlocks, nativeTextDocumentShape, nativeTextMetadataRecords, nativeTextQuoteGap, restoreOwnedInline, formatMarkdownSelection, nativeSelectionFormatState, nativeTextFormatRanges, type PortableColorEdit } from "./markdown-colors.ts";

const MARKER = "<!-- noteglow-text-colors:", PREFIX = MARKER + "1 ";
const MAX_TEXT = 1_000_000, MAX_BLOCK = 200_000;
export interface NativeTextBlock {
  from: number; to: number; line: number; kind: string; structure: string; supported: boolean;
  html: Array<{ from: number; to: number }>;
  cells: Array<{ from: number; to: number }>; units: Array<{ from: number; to: number }>; source: string; eol: string;
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
interface TextMetadataRecord { from: number; to: number; commentFrom: number; source: string; ranges: ColorRange[]; raw: string }
/** 只认 AST 顶层独立、规范编码的记录；隐藏不依赖是否仍紧邻原段落。 */
export function nativeTextOwnedRecords(text: string): TextMetadataRecord[] {
  if (text.length > MAX_TEXT) return [];
  const records: TextMetadataRecord[] = [];
  for (const span of nativeTextMetadataRecords(text)) {
    const separator = /^(?:\r\n|\n)*/.exec(text.slice(span.from, span.to))![0];
    const commentFrom = span.from + separator.length, raw = text.slice(commentFrom, span.to);
    if (!raw.startsWith(PREFIX) || !raw.endsWith(" -->")) continue;
    try {
      const data = JSON.parse(raw.slice(PREFIX.length, -4));
      if (!data || Object.keys(data).sort().join() !== "ranges,source,version" || data.version !== 1 || typeof data.source !== "string" || encodeNativeTextMetadata(data.source, data.ranges) !== raw) continue;
      records.push({ ...span, commentFrom, source: data.source, ranges: data.ranges, raw });
    } catch { /* 损坏或未知版本保持可见，不把用户内容当成内部记录。 */ }
  }
  return records;
}

function moveTextRecord(text: string, block: NativeTextBlock, record: TextMetadataRecord): Array<{ from: number; to: number; insert: string }> {
  if (record.from <= block.to) return [];
  const insert = block.eol + block.eol + record.raw;
  const output = text.slice(0, block.to) + insert + text.slice(block.to, record.from) + text.slice(record.to);
  // 只移动内部记录：引用、列表紧凑性和所有用户文字必须保持相同 Markdown 语义。
  if (nativeTextDocumentShape(text) !== nativeTextDocumentShape(output)) return [];
  return [{ from: block.to, to: block.to, insert }, { from: record.from, to: record.to, insert: "" }];
}

/** 显式恢复仅看记录之前最近的正文块，并要求全文无重复快照；不搜索远处文字猜归属。 */
export function repairNativeTextMetadata(text: string): string {
  const records = nativeTextOwnedRecords(text), blocks = scanNativeText(text);
  const edits: Array<{ from: number; to: number; insert: string }> = [];
  for (const record of records) {
    const block = blocks.filter((item) => item.to <= record.from).at(-1);
    if (!block?.supported || block.status !== "none" || block.source !== record.source || !nativeTextQuoteGap(text, block.to, record.from)) continue;
    if (blocks.filter((item) => item.source === record.source).length !== 1 || records.filter((item) => item.source === record.source).length !== 1) continue;
    edits.push(...moveTextRecord(text, block, record));
  }
  let output = text;
  for (const edit of edits.sort((a, b) => b.from - a.from)) output = output.slice(0, edit.from) + edit.insert + output.slice(edit.to);
  return output;
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
      block.status = item.supported && data.source === source && !data.ranges.some((range: ColorRange) => item.html.some((html) => item.from + range.from < html.to && item.from + range.to > html.from)) ? "valid" : "stale";
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
  if (blocks.length !== 1 || !blocks[0].supported || blocks[0].html.some((range) => from < range.to && to > range.from) || from < blocks[0].from || to > blocks[0].to) throw new Error("请选择同一段落、标题、列表或同一张表内的正文；未知 HTML、引用和嵌套代码暂不支持。旧 HTML 请先执行恢复原生正文命令。");
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
interface TextSelection { from: number; to: number }
/** 源码连续选择按格子裁剪；宿主矩形选择则只接受该表内的精确内容范围，绝不补选矩形外文字。 */
function selectedTextRanges(block: NativeTextBlock, from: number, to: number, cells?: readonly TextSelection[]): TextSelection[] {
  const ranges = cells ? [...cells] : block.kind === "table" ? block.cells.map((cell) => ({ from: Math.max(from, cell.from), to: Math.min(to, cell.to) })).filter((range) => range.to > range.from) : [{ from, to }];
  if (!ranges.length || ranges.length > 10000 || (cells && block.kind !== "table")) throw new Error("所选单元格没有可格式化的文字，请勿只选择表格分隔符或空格子。");
  ranges.sort((a, b) => a.from - b.from);
  if (ranges.some((range, index) => !Number.isInteger(range.from) || !Number.isInteger(range.to) || range.from < from || range.to > to || range.from >= range.to || (index > 0 && ranges[index - 1].to > range.from) || (block.kind === "table" && !block.cells.some((cell) => range.from >= cell.from && range.to <= cell.to)))) throw new Error("表格选区已改变或跨越不同表格，请重新选择。");
  return ranges;
}
/** 整个连续选区先校验；仅跳过块间空白和该块已有的有效记录，引用/围栏/未知 HTML 不静默略过。 */
function selectedBlocks(text: string, from: number, to: number): NativeTextBlock[] {
  if (text.length > MAX_TEXT || !Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from >= to || to > text.length || !boundary(text, from) || !boundary(text, to)) throw new Error("正文选区无效或笔记过大。");
  const blocks = scanNativeText(text).filter((block) => from < block.to && to > block.from);
  if (!blocks.length) throw new Error("请选择支持的正文，不能只选择分隔符或颜色记录；旧 HTML 请先执行恢复原生正文命令。");
  let cursor = from;
  for (const block of blocks) {
    if (!block.supported || block.html.some((range) => from < range.to && to > range.from) || text.slice(cursor, Math.max(cursor, block.from)).trim()) throw new Error("选区包含不支持的引用、代码块或 HTML，原文未修改；旧 HTML 请先执行恢复原生正文命令。");
    if (block.status === "invalid" || block.status === "stale") throw new Error("正文颜色记录已过期或损坏，请先重置记录。");
    if (to > block.to && to < block.metadataTo) throw new Error("请勿只选择部分颜色记录。");
    cursor = Math.max(cursor, block.metadataTo);
  }
  if (text.slice(cursor, to).trim()) throw new Error("选区包含不支持的引用、代码块或 HTML，原文未修改；旧 HTML 请先执行恢复原生正文命令。");
  return blocks;
}

export function applyNativeTextColor(text: string, from: number, to: number, property?: ColorProperty, color?: string, cells?: readonly TextSelection[]): PortableColorEdit {
  const blocks = selectedBlocks(text, from, to);
  if (cells && blocks.length !== 1) throw new Error("表格矩形选区不能跨越不同块。");
  let output = text, end = to;
  for (const block of [...blocks].reverse()) {
    const edit = applyNativeTextColorBlock(output, Math.max(from, block.from), Math.min(to, block.to), property, color, cells);
    const delta = edit.text.length - output.length;
    // 颜色记录插入在块后；只有位于选区末端之前的记录才移动末端。
    if (block.to < to) end += delta;
    output = edit.text;
  }
  return { text: output, from, to: end };
}

export function formatNativeText(text: string, from: number, to: number, format: "bold" | "italic" | "code", applyOnly = false, cells?: readonly TextSelection[]): PortableColorEdit {
  const blocks = selectedBlocks(text, from, to);
  if (cells && blocks.length !== 1) throw new Error("表格矩形选区不能跨越不同块。");
  const selections = blocks.flatMap((block) => selectedTextRanges(block, Math.max(from, block.from), Math.min(to, block.to), cells));
  const batchApplyOnly = applyOnly || blocks.length > 1 && !nativeSelectionFormatState(text, selections, format).applied;
  let output = text, start = from, end = to, touched = false;
  for (const block of [...blocks].reverse()) {
    const left = Math.max(from, block.from), right = Math.min(to, block.to);
    if (format !== "code" && !nativeSelectionFormatState(text, [{ from: left, to: right }], format).eligible) continue;
    const edit = formatNativeTextBlock(output, left, right, format, batchApplyOnly, cells);
    end = touched ? end + edit.text.length - output.length : edit.to;
    start = edit.from; output = edit.text; touched = true;
  }
  if (!touched) throw new Error("选区没有可设置格式的正文。");
  return { text: output, from: start, to: end };
}
function applyNativeTextColorBlock(text: string, from: number, to: number, property?: ColorProperty, color?: string, cells?: readonly TextSelection[]): PortableColorEdit {
  const block = selectedBlock(text, from, to), selections = selectedTextRanges(block, from, to, cells);
  if (property && !normalizeColor(color ?? "")) throw new Error("请输入 #RGB 或 #RRGGBB。");
  const units = block.units.filter((unit) => selections.some((range) => unit.from < range.to && unit.to > range.from));
  if (!units.length || units.some((unit) => !selections.some((range) => unit.from >= range.from && unit.to <= range.to))) throw new Error("请选择完整文字，不能拆开实体或只选择格式标签。");
  let ranges = block.ranges;
  const intervals: Array<{ from: number; to: number }> = [];
  for (const unit of units) { const last = intervals[intervals.length - 1]; if (last && unit.from <= last.to) last.to = Math.max(last.to, unit.to); else intervals.push({ ...unit }); }
  for (const unit of intervals) ranges = replaceColor(ranges, unit.from - block.from, unit.to - block.from, property, color);
  return { text: writeRanges(text, block, ranges), from, to };
}
/** 格式只在本块原生 Markdown 上执行；携带颜色通过解析器的精确位置映射，绝不重建 HTML。 */
function formatNativeTextBlock(text: string, from: number, to: number, format: "bold" | "italic" | "code", applyOnly = false, cells?: readonly TextSelection[]): PortableColorEdit {
  const block = selectedBlock(text, from, to), selections = selectedTextRanges(block, from, to, cells).flatMap((range) => nativeTextFormatRanges(block.source).map((part) => ({ from: Math.max(range.from, part.from + block.from), to: Math.min(range.to, part.to + block.from) })).filter((part) => part.from < part.to)).map((range) => ({ from: range.from - block.from, to: range.to - block.from }));
  if (!selections.length) throw new Error("请选择正文，不要只选择容器标记。");
  const batch = selections.length > 1;
  if (format !== "code") {
    for (let index = selections.length - 1; index >= 0; index--) if (!nativeSelectionFormatState(block.source, [selections[index]], format).eligible) selections.splice(index, 1);
    if (!selections.length) throw new Error("选区没有可设置格式的正文。");
  }
  const batchApplyOnly = applyOnly || batch && !nativeSelectionFormatState(block.source, selections, format).applied;
  let result: PortableColorEdit = { text: block.source, ranges: block.ranges, from: from - block.from, to: to - block.from };
  let selectionTo = result.to;
  // 先在内存从后向前改各格，前方原 offset 不变；任一格拒绝则整体不写，最终只交给宿主一次事务。
  for (let index = selections.length - 1; index >= 0; index--) {
    const range = selections[index];
    const next = formatMarkdownSelection(result.text, range.from, range.to, format, result.ranges, true, batchApplyOnly);
    selectionTo = index === selections.length - 1 ? next.to : selectionTo + next.text.length - result.text.length;
    result = { ...next, to: selectionTo };
  }
  const parsed = nativeTextBlocks(result.text);
  if (parsed.length !== 1 || !parsed[0].supported || parsed[0].kind !== block.kind || parsed[0].from !== 0 || parsed[0].to !== result.text.length) throw new Error("格式修改将改变段落结构，原文已保留。");
  const replacement = result.text + ((result.ranges?.length ?? 0) ? block.eol + block.eol + encodeNativeTextMetadata(result.text, result.ranges!) : "");
  return { text: text.slice(0, block.from) + replacement + text.slice(block.metadataTo), from: block.from + result.from, to: block.from + result.to };
}
/** 仅原块结构保持完整时同步快照。分裂、合并、未知结构不猜测迁移，保留旧记录供重置。 */
export function nativeTextMetadataChanges(before: string, after: string, changes: ChangeSet, normalizationOnly = false): Array<{ from: number; to: number; insert: string }> {
  const next = scanNativeText(after), records = nativeTextOwnedRecords(after), edits: Array<{ from: number; to: number; insert: string }> = [];
  for (const old of scanNativeText(before)) {
    if (old.status !== "valid") continue;
    // Obsidian 聚焦单元格时可能整表重排 padding，且事务没有 input 标记；仅同一棵表格树可沿文字单元重映射。
    const normalized = old.kind === "table" ? next.find((item) => item.kind === "table" && item.from === changes.mapPos(old.from, -1) && item.to === changes.mapPos(old.to, 1) && item.supported) : undefined;
    if (normalized && normalized.source !== old.source && normalized.status === "stale" && after.slice(normalized.to, normalized.metadataTo) === before.slice(old.to, old.metadataTo) && nativeTextDocumentShape(normalized.source) === nativeTextDocumentShape(old.source) && old.cells.length === normalized.cells.length && old.cells.every((cell, index) => before.slice(cell.from, cell.to) === after.slice(normalized.cells[index].from, normalized.cells[index].to)) && old.units.length === normalized.units.length) {
      const ranges = old.units.flatMap((unit, index) => old.ranges.filter((range) => range.from <= unit.from - old.from && range.to >= unit.to - old.from).map((range) => ({ ...range, from: normalized.units[index].from - normalized.from, to: normalized.units[index].to - normalized.from })));
      edits.push({ from: normalized.commentFrom, to: normalized.metadataTo, insert: encodeNativeTextMetadata(normalized.source, mergeRanges(ranges)) });
      continue;
    }
    if (normalizationOnly) continue;
    // 原始关联已由事务证明，不做内容搜索；只在原块和原记录字节都完整时把插入的新块移到记录后。
    const original = next.find((item) => item.from === changes.mapPos(old.from, -1) && item.source === old.source && item.supported);
    const record = records.find((item) => item.commentFrom === changes.mapPos(old.commentFrom, 1) && item.raw === before.slice(old.commentFrom, old.metadataTo));
    let recordTouched = false;
    changes.iterChangedRanges((from, to) => { if (from < old.metadataTo && to > old.commentFrom || from >= old.commentFrom && from < old.metadataTo) recordTouched = true; });
    if (!recordTouched && original?.status === "none" && record && original.to < record.from) {
      const moved = moveTextRecord(after, original, record);
      if (moved.length) { edits.push(...moved); continue; }
    }
    let touched = false, unsafe = false;
    changes.iterChangedRanges((from, to) => { if (from > old.to && from < old.metadataTo || to > old.to && from < old.metadataTo) unsafe = true; if (from >= old.from && to <= old.to) touched = true; });
    if (unsafe || !touched) continue;
    const block = next.find((item) => item.from === changes.mapPos(old.from, -1) && item.to === changes.mapPos(old.to, 1) && item.kind === old.kind && item.structure === old.structure && item.supported);
    if (!block || block.status === "none" || after.slice(block.to, block.metadataTo) !== before.slice(old.to, old.metadataTo)) continue;
    const ranges = mapColorRanges(old.ranges.map((range) => ({ ...range, from: old.from + range.from, to: old.from + range.to })), (position, association) => changes.mapPos(position, association)).map((range) => ({ ...range, from: range.from - block.from, to: range.to - block.from }));
    if (!validRanges(ranges, block.source)) continue;
    edits.push({ from: block.commentFrom, to: block.metadataTo, insert: encodeNativeTextMetadata(block.source, ranges) });
  }
  return edits.sort((a, b) => a.from - b.from);
}
export const nativeTextColorTransactions = EditorState.transactionFilter.of((transaction) => {
  if (!transaction.docChanged) return transaction;
  const normalizationOnly = !(transaction.isUserEvent("input") || transaction.isUserEvent("delete") || transaction.isUserEvent("indent"));
  const before = transaction.startState.doc.toString(); if (!before.includes(MARKER)) return transaction;
  const changes = nativeTextMetadataChanges(before, transaction.newDoc.toString(), transaction.changes, normalizationOnly);
  return changes.length ? [transaction, { changes, sequential: true }] : transaction;
});
export function createNativeTextMetadataField(live: (state: EditorState) => boolean): StateField<DecorationSet> {
  const ranges = (state: EditorState) => nativeTextOwnedRecords(state.doc.toString()).map((record) => ({ ...record, metadataTo: record.to }));
  const decorations = (state: EditorState) => live(state) ? Decoration.set(ranges(state).map((block) => Decoration.replace({ block: true }).range(block.commentFrom, block.metadataTo)), true) : Decoration.none;
  return StateField.define({ create: decorations, update: (value, tr) => tr.docChanged || live(tr.state) !== live(tr.startState) ? decorations(tr.state) : value,
    provide: (field) => [EditorView.decorations.from(field), EditorView.atomicRanges.of((view) => view.state.field(field)), EditorState.changeFilter.of((tr) => {
      if (!tr.docChanged || !tr.isUserEvent("delete") || !live(tr.startState) || tr.startState.selection.ranges.length !== 1 || !tr.startState.selection.main.empty) return true;
      let allowed = true; const blocks = ranges(tr.startState);
      const text = tr.startState.doc.toString();
      // 记录后的首个换行维持独立 HTML 注释行；删除它会把下一段拼到注释结束符后。
      tr.changes.iterChangedRanges((from, to) => { if (blocks.some((block) => from < block.metadataTo + (/^(?:\r\n|\n)/.exec(text.slice(block.metadataTo))?.[0].length ?? 0) && to > block.from)) allowed = false; }); return allowed;
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

/** 保存核验只容忍表格排版空白变化；表外字节、单元格语法、可见文字及每个文字单元颜色必须完全一致。 */
export function isNativeTableNormalization(before: string, after: string): boolean {
  const signature = (text: string): string | null => {
    const tables = scanNativeText(text).filter((block) => block.kind === "table");
    if (!tables.length || tables.some((block) => !block.supported || !["none", "valid"].includes(block.status))) return null;
    const parts: unknown[] = []; let cursor = 0;
    for (const block of tables) {
      parts.push(text.slice(cursor, block.from), nativeTextDocumentShape(block.source), block.cells.map((cell) => text.slice(cell.from, cell.to)), block.units.map((unit) => block.ranges.filter((range) => range.from <= unit.from - block.from && range.to >= unit.to - block.from).map(({ property, color }) => [property, color])));
      cursor = block.metadataTo;
    }
    parts.push(text.slice(cursor)); return JSON.stringify(parts);
  };
  const expected = signature(before); return expected !== null && expected === signature(after);
}
