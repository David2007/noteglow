import { fromMarkdown } from "mdast-util-from-markdown";
import { EditorState, StateField, type ChangeSet } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import { mapColorRanges, normalizeColor, replaceColor, type ColorProperty, type ColorRange } from "./color-ranges.ts";
import { decodeOwnedCodeBlocks, frontmatterEnd, markdownProtectedRanges } from "./markdown-colors.ts";

const PREFIX = "<!-- noteglow-code-colors:1 ";
const MARKER = "<!-- noteglow-code-colors:";
const MAX_TEXT = 1_000_000, MAX_CODE = 200_000, MAX_RANGES = 10_000;
export interface NativeCodeBlock {
  from: number; to: number; codeFrom: number; codeTo: number; code: string; opening: string; closing: string;
  line: number; supported: boolean; eol: string; ranges: ColorRange[];
  status: "none" | "valid" | "invalid" | "stale";
  metadataFrom: number; metadataTo: number; commentFrom: number; addedSeparator: boolean;
}
export interface NativeColorEdit { text: string; from: number; to: number }
interface SourceEdit { from: number; to: number; insert: string }
interface BackupAdapter { exists(path: string): Promise<boolean>; mkdir(path: string): Promise<void>; write(path: string, text: string): Promise<void>; read(path: string): Promise<string> }
// 同一文档的多个阅读 section 共用精确快照；最多保留两篇，避免每个 section 重复解析全文。
const scanCache = new Map<string, NativeCodeBlock[]>();

function boundary(text: string, offset: number): boolean {
  return !(offset > 0 && offset < text.length && ((/[\uD800-\uDBFF]/.test(text[offset - 1]) && /[\uDC00-\uDFFF]/.test(text[offset])) || (text[offset - 1] === "\r" && text[offset] === "\n")));
}
function validRanges(value: unknown, code: string): value is ColorRange[] {
  if (!Array.isArray(value) || value.length > MAX_RANGES) return false;
  const ends = { foreground: 0, background: 0 };
  for (const range of value) {
    if (!range || Object.keys(range).sort().join() !== "color,from,property,to" || (range.property !== "foreground" && range.property !== "background") || !Number.isInteger(range.from) || !Number.isInteger(range.to) || range.from < 0 || range.from >= range.to || range.to > code.length || !boundary(code, range.from) || !boundary(code, range.to) || typeof range.color !== "string" || normalizeColor(range.color) !== range.color) return false;
    const property: ColorProperty = range.property;
    if (range.from < ends[property]) return false;
    ends[property] = range.to;
  }
  return true;
}

/** 元数据只认紧邻的下一行；快照不一致时保持原文，但不显示或猜测恢复颜色。 */
export function scanNativeCode(text: string): NativeCodeBlock[] {
  const cached = scanCache.get(text);
  if (cached) return cached;
  const blocks = scanNativeCodeUncached(text);
  if (text.length <= MAX_TEXT) {
    scanCache.set(text, blocks);
    while (scanCache.size > 2) scanCache.delete(scanCache.keys().next().value!);
  }
  return blocks;
}

function scanNativeCodeUncached(text: string): NativeCodeBlock[] {
  if (text.length > MAX_TEXT) return [];
  const yamlEnd = frontmatterEnd(text);
  const ast = fromMarkdown(yamlEnd ? text.slice(0, yamlEnd).replace(/[^\r\n]/g, " ") + text.slice(yamlEnd) : text), blocks: NativeCodeBlock[] = [];
  let protectedRegions: Array<{ from: number; to: number }>;
  try { protectedRegions = markdownProtectedRanges(text); }
  catch { protectedRegions = [{ from: 0, to: text.length }]; }
  const visit = (node: typeof ast | typeof ast.children[number], depth: number): void => {
    if (node.type === "code" && node.position) {
      const from = node.position.start.offset!, to = node.position.end.offset!;
      const raw = text.slice(from, to), opening = /^(`{3,}|~{3,})([^\r\n]*)(\r\n|\n|\r)/.exec(raw);
      const lastLine = Math.max(raw.lastIndexOf("\n"), raw.lastIndexOf("\r")) + 1;
      const closing = raw.slice(lastLine), marker = opening?.[1];
      const supported = depth === 1 && node.position.start.column === 1 && !protectedRegions.some((range) => from < range.to && to > range.from) && Boolean(opening && new RegExp(`^ {0,3}${marker![0]}{${marker!.length},}[ \\t]*$`).test(closing));
      const codeFrom = from + (opening?.[0].length ?? 0), codeTo = from + lastLine;
      const code = supported ? text.slice(codeFrom, codeTo) : "";
      const eol = opening?.[3] ?? "\n", afterEol = /^(?:\r\n|\n|\r)/.exec(text.slice(to))?.[0] ?? "";
      const commentFrom = to + afterEol.length;
      const block: NativeCodeBlock = { from, to, codeFrom, codeTo, code, opening: opening?.[0] ?? "", closing, line: node.position.start.line - 1, supported: supported && code.length <= MAX_CODE, eol, ranges: [], status: "none", metadataFrom: commentFrom, metadataTo: commentFrom, commentFrom, addedSeparator: false };
      if (afterEol && text.startsWith(MARKER, commentFrom)) {
        const rest = text.slice(commentFrom), lineEnd = rest.search(/[\r\n]/), length = lineEnd < 0 ? rest.length : lineEnd;
        const rawMetadata = rest.slice(0, length), trailing = /^(?:\r\n|\n|\r)/.exec(rest.slice(length))?.[0] ?? "";
        block.metadataTo = commentFrom + length + trailing.length; block.status = "invalid";
        if (rawMetadata.startsWith(PREFIX) && rawMetadata.endsWith(" -->") && rawMetadata.length <= MAX_CODE * 8) {
          try {
            const data = JSON.parse(rawMetadata.slice(PREFIX.length, -4));
            if (data && Object.keys(data).sort().join() === "addedSeparator,code,ranges,version" && data.version === 1 && typeof data.code === "string" && data.code.length <= MAX_CODE && typeof data.addedSeparator === "boolean" && validRanges(data.ranges, data.code) && encodeNativeCodeMetadata(data.code, data.ranges, data.addedSeparator) === rawMetadata) {
              block.addedSeparator = data.addedSeparator; block.metadataFrom = data.addedSeparator ? to : commentFrom;
              block.status = block.supported && data.code === code ? "valid" : "stale";
              if (block.status === "valid") block.ranges = data.ranges;
            }
          } catch { /* 损坏记录保持原文，绝不重建。 */ }
        }
      }
      blocks.push(block);
    }
    if ("children" in node) for (const child of node.children) visit(child as typeof ast.children[number], depth + 1);
  };
  visit(ast, 0); return blocks;
}

export function encodeNativeCodeMetadata(code: string, ranges: readonly ColorRange[], addedSeparator = false): string {
  if (code.length > MAX_CODE || !validRanges(ranges, code)) throw new Error("代码颜色记录超限或范围无效。");
  // 所有 HTML 元字符及连字符转成 JSON 转义，代码中的 --> 无法终止注释。
  const json = JSON.stringify({ version: 1, code, ranges, addedSeparator }).replace(/[<>&-]/g, (value) => `\\u${value.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return PREFIX + json + " -->";
}

export function applyNativeCodeColor(text: string, from: number, to: number, property?: ColorProperty, color?: string): NativeColorEdit | null {
  if (text.length > MAX_TEXT) throw new Error("笔记超过 100 万字符，未改动正文。");
  const blocks = scanNativeCode(text);
  if (blocks.some((block) => block.status !== "none" && from < block.metadataTo && to > block.commentFrom)) throw new Error("颜色元数据不能作为正文修改，请选择代码文字。");
  const touched = blocks.filter((block) => from < block.to && to > block.from);
  if (!touched.length) return null;
  const block = touched[0];
  if (touched.length !== 1 || !block.supported || from < block.codeFrom || to > block.codeTo || from >= to) throw new Error("目前只支持单个顶层、无缩进且已闭合的原生代码块正文；不能跨代码块或正文选择。");
  if (!boundary(text, from) || !boundary(text, to)) throw new Error("选区不能拆开 emoji 或 CRLF。");
  if (block.status === "invalid" || block.status === "stale") throw new Error("代码颜色记录损坏或已过期，原记录已保留；请核对后移除记录再着色。");
  if (property && !normalizeColor(color ?? "")) throw new Error("请输入 #RGB 或 #RRGGBB。");
  const ranges = replaceColor(block.ranges, from - block.codeFrom, to - block.codeFrom, property, color);
  const exists = block.status === "valid";
  if (!ranges.length && !exists) return { text, from, to };
  const added = exists ? block.addedSeparator : block.commentFrom === block.to;
  // EOF 围栏着色时补过换行；若后来追加正文，清色仍须保留分隔，不能把正文接到关闭围栏上。
  const insert = ranges.length ? (added ? block.eol : "") + encodeNativeCodeMetadata(block.code, ranges, added) + block.eol : added && block.metadataTo < text.length ? block.eol : "";
  const start = exists ? block.metadataFrom : block.commentFrom, end = exists ? block.metadataTo : start;
  const output = text.slice(0, start) + insert + text.slice(end);
  if (output.length > MAX_TEXT) throw new Error("包含颜色记录后超过 100 万字符，未改动正文。");
  return { text: output, from, to };
}

/** 调用方必须先备份并核验当前快照；使用长于正文所有反引号串的安全围栏。 */
export function migrateOwnedCodeToNative(text: string): string {
  const blocks = decodeOwnedCodeBlocks(text);
  let output = text;
  for (const block of [...blocks].reverse()) {
    const fence = "`".repeat(Math.max(3, ...Array.from(block.code.matchAll(/`+/g), (match) => match[0].length + 1)));
    const eol = block.code.includes("\r\n") ? "\r\n" : "\n";
    const metadata = block.ranges.length ? eol + encodeNativeCodeMetadata(block.code, block.ranges) : "";
    const replacement = fence + block.lang + eol + block.code + fence + metadata;
    output = output.slice(0, block.from) + replacement + output.slice(block.to);
  }
  if (output.length > MAX_TEXT) throw new Error("迁移后的笔记超过 100 万字符，未改动正文。");
  return output;
}

/** 迁移时按原 HTML 字符位置映射到新围栏正文；标签内光标落在邻近代码字符。 */
export function mapMigratedCodePosition(before: string, after: string, offset: number): number {
  const blocks = decodeOwnedCodeBlocks(before), native = scanNativeCode(after);
  let shift = 0;
  for (const block of blocks) {
    const converted = native.find((item) => item.from === block.from + shift);
    if (!converted) throw new Error("迁移代码位置无法核验。");
    if (offset < block.from) return offset + shift;
    if (offset <= block.to) {
      const index = block.positions.findIndex((unit) => unit.to > offset);
      return converted.codeFrom + (index < 0 ? block.code.length : index);
    }
    // 只计替换生成的部分；原块后的物理换行仍来自原文。
    const replacementEnd = converted.status === "valid" ? converted.metadataTo - (/\r\n$|\n$|\r$/.exec(after.slice(converted.commentFrom, converted.metadataTo))?.[0].length ?? 0) : converted.to;
    shift += replacementEnd - converted.from - (block.to - block.from);
  }
  return offset + shift;
}

/** 备份读回成功且来源仍一致才允许调用方写编辑器；失败保留备份，不反向覆盖笔记。 */
export async function backupNativeCodeMigration(adapter: BackupAdapter, directory: string, name: string, source: string, isCurrent: () => boolean): Promise<string> {
  if (!isCurrent()) throw new Error("迁移来源已改变，未修改笔记。");
  if (!/^[a-zA-Z0-9-]+\.md$/.test(name) || source.length > MAX_TEXT) throw new Error("迁移备份参数无效。");
  if (!await adapter.exists(directory)) await adapter.mkdir(directory);
  const backup = `${directory}/${name}`;
  if (await adapter.exists(backup)) throw new Error("备份路径已存在，请重试。");
  await adapter.write(backup, source);
  if (await adapter.read(backup) !== source) throw new Error("代码迁移备份读回不一致，未修改笔记。");
  if (!isCurrent()) throw new Error("备份期间笔记发生变化，未迁移。备份已保留。");
  return backup;
}

/** 最小单区间替换；两侧不能把 surrogate pair 或 CRLF 切成半个字符。 */
export function minimalTextChange(before: string, after: string): SourceEdit {
  let from = 0;
  while (from < before.length && from < after.length && before[from] === after[from]) from++;
  while (from > 0 && (!boundary(before, from) || !boundary(after, from))) from--;
  let oldEnd = before.length, newEnd = after.length;
  while (oldEnd > from && newEnd > from && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd--; newEnd--; }
  while (oldEnd < before.length && (!boundary(before, oldEnd) || !boundary(after, newEnd))) { oldEnd++; newEnd++; }
  return { from, to: oldEnd, insert: after.slice(from, newEnd) };
}

/** 只映射已验证的原块，且必须保持围栏及元数据原样。外部无事务编辑绝不猜测对齐。 */
export function nativeMetadataChanges(before: string, after: string, changes: ChangeSet): SourceEdit[] {
  const oldBlocks = scanNativeCode(before), newBlocks = scanNativeCode(after), output: SourceEdit[] = [];
  for (const old of oldBlocks) {
    if (old.status !== "valid") continue;
    let codeChanged = false, unsafe = false;
    changes.iterChangedRanges((from, to) => {
      if (from <= old.metadataTo && to >= old.metadataFrom) unsafe = true;
      if (from < old.codeFrom && to > old.from || from < old.to && to > old.codeTo) unsafe = true;
      if (from >= old.codeFrom && to <= old.codeTo) codeChanged = true;
    });
    if (unsafe || !codeChanged) continue;
    const block = newBlocks.find((item) => item.from === changes.mapPos(old.from, 1));
    if (!block?.supported || block.opening !== old.opening || block.closing !== old.closing || block.codeFrom !== changes.mapPos(old.codeFrom, -1) || block.codeTo !== changes.mapPos(old.codeTo, 1)) continue;
    const from = changes.mapPos(old.metadataFrom, 1), to = changes.mapPos(old.metadataTo, -1);
    if (after.slice(from, to) !== before.slice(old.metadataFrom, old.metadataTo)) continue;
    const ranges = mapColorRanges(old.ranges.map((range) => ({ ...range, from: range.from + old.codeFrom, to: range.to + old.codeFrom })), (position, association) => changes.mapPos(position, association)).map((range) => ({ ...range, from: range.from - block.codeFrom, to: range.to - block.codeFrom }));
    if (!validRanges(ranges, block.code)) continue;
    output.push({ from, to, insert: (old.addedSeparator ? old.eol : "") + encodeNativeCodeMetadata(block.code, ranges, old.addedSeparator) + (/\r\n$|\n$|\r$/.exec(before.slice(old.commentFrom, old.metadataTo))?.[0] ?? "") });
  }
  return output;
}

export const nativeCodeColorTransactions = EditorState.transactionFilter.of((transaction) => {
  if (!transaction.docChanged || !(transaction.isUserEvent("input") || transaction.isUserEvent("delete") || transaction.isUserEvent("indent")) || transaction.isUserEvent("undo") || transaction.isUserEvent("redo")) return transaction;
  const before = transaction.startState.doc.toString();
  if (!before.includes(MARKER)) return transaction;
  const changes = nativeMetadataChanges(before, transaction.newDoc.toString(), transaction.changes);
  return changes.length ? [transaction, { changes, sequential: true }] : transaction;
});

/** 只隐藏可核验的独立元数据行；过期快照仍可隐藏，损坏/未知记录保留源码供处理。 */
export function nativeMetadataHiddenRanges(text: string): Array<{ from: number; to: number }> {
  if (!text.includes(MARKER)) return [];
  return scanNativeCode(text).filter((block) => block.supported && (block.status === "valid" || block.status === "stale") && block.commentFrom < block.metadataTo).map((block) => ({ from: block.commentFrom, to: block.metadataTo }));
}

/** 块级替换必须通过 StateField 直接提供；不替换围栏或原生代码编辑器。 */
export function createNativeMetadataField(isLivePreview: (state: EditorState) => boolean): StateField<DecorationSet> {
  const decorations = (state: EditorState): DecorationSet => isLivePreview(state)
    ? Decoration.set(nativeMetadataHiddenRanges(state.doc.toString()).map((range) => Decoration.replace({ block: true }).range(range.from, range.to)), true)
    : Decoration.none;
  return StateField.define<DecorationSet>({
    create: decorations,
    update(value, transaction) {
      return transaction.docChanged || isLivePreview(transaction.startState) !== isLivePreview(transaction.state) ? decorations(transaction.state) : value;
    },
    provide: (field) => [
      EditorView.decorations.from(field),
      // 光标按原生原子区间跳过注释，切到源码模式后区间立即撤销。
      EditorView.atomicRanges.of((view) => view.state.field(field)),
      EditorState.changeFilter.of((transaction) => {
        // changeFilter 先于所有 transactionFilter，只检查用户原始删除，避免误拦截颜色快照的合法同步更新。
        const state = transaction.startState;
        if (!transaction.docChanged || !transaction.isUserEvent("delete") || !isLivePreview(state) || state.selection.ranges.length !== 1 || !state.selection.main.empty) return true;
        const protectedBlocks = scanNativeCode(state.doc.toString()).filter((block) => block.supported && (block.status === "valid" || block.status === "stale"));
        let touchesMetadata = false;
        transaction.changes.iterChangedRanges((from, to) => {
          if (protectedBlocks.some((block) => from < block.metadataTo && to > block.to)) touchesMetadata = true;
        });
        // 原子跳转会扩大 Backspace/Delete 的范围；普通单光标删除不能因此吞掉隐藏记录或分隔符。
        // 显式非空选区删除与源码模式保持原生行为，用户仍可主动删除整块。
        return !touchesMetadata;
      })
    ]
  });
}

/** Prism 的 span 可任意分割文字；只有整块文字及原始 section 行号一致才覆盖颜色。 */
export function paintNativeCodeElement(code: HTMLElement, block: NativeCodeBlock): boolean {
  if (block.status !== "valid" || !block.ranges.length || (code.textContent ?? "") !== block.code.replace(/\r\n|\r/g, "\n")) return false;
  const offsets: number[] = [];
  let visible = 0;
  for (let i = 0; i < block.code.length; i++) {
    offsets[i] = visible++;
    if (block.code[i] === "\r" && block.code[i + 1] === "\n") offsets[++i] = visible - 1;
  }
  offsets[block.code.length] = visible;
  // 一次边界排序和线性 DOM 遍历，避免每个字符扫描全部颜色范围。
  const events = block.ranges.flatMap((range) => [
    { at: offsets[range.from], property: range.property, color: range.color, end: false },
    { at: offsets[range.to], property: range.property, color: "", end: true }
  ]).sort((left, right) => left.at - right.at || Number(right.end) - Number(left.end));
  const active: Partial<Record<ColorProperty, string>> = {};
  const walker = code.ownerDocument.createTreeWalker(code, 4), nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
  let cursor = 0, eventIndex = 0;
  for (const node of nodes) {
    const fragment = code.ownerDocument.createDocumentFragment();
    let index = 0;
    while (index < node.data.length) {
      while (eventIndex < events.length && events[eventIndex].at <= cursor + index) {
        const event = events[eventIndex++];
        if (event.end) delete active[event.property]; else active[event.property] = event.color;
      }
      const end = Math.min(node.data.length, (events[eventIndex]?.at ?? Infinity) - cursor);
      const text = node.data.slice(index, end);
      if (!active.foreground && !active.background) fragment.appendChild(code.ownerDocument.createTextNode(text));
      else {
        const span = code.ownerDocument.createElement("span"); span.dataset.codexNoteColor = "native"; span.textContent = text;
        for (const property of ["foreground", "background"] as const) if (active[property]) { span.classList.add(`codex-notes-color-${property}`); span.style.setProperty(`--codex-note-${property}`, active[property]!); }
        fragment.appendChild(span);
      }
      index = end;
    }
    cursor += node.data.length; node.replaceWith(fragment);
  }
  return true;
}
