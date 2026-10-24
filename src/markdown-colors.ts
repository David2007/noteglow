import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
import { EntityDecoder, DecodingMode, htmlDecodeTree } from "entities/decode";
import { mergeRanges, normalizeColor, replaceColor, type ColorProperty, type ColorRange } from "./color-ranges.ts";

export interface PortableColorEdit { text: string; from: number; to: number; ranges?: ColorRange[] }
type Format = "bold" | "italic" | "code";
type Styles = Partial<Record<ColorProperty, string>>;
interface Unit { from: number; to: number; value: string }
interface Pair { from: number; to: number; resultFrom: number; resultTo: number }
interface Edit { from: number; to: number; text: string; pairs?: Pair[]; boundaries?: Map<number, number>; strict?: boolean }
interface Mapped { text: string; map(position: number, side: -1 | 1): number }
interface MdNode { type: string; value?: string; children?: MdNode[]; position?: { start: { offset?: number; line: number; column: number }; end: { offset?: number; line: number; column: number } }; lang?: string | null; meta?: string | null; [key: string]: unknown }
type HtmlNode = DefaultTreeAdapterMap["node"];
type HtmlElement = DefaultTreeAdapterMap["element"];
interface Owned { node: HtmlElement; from: number; to: number; code: boolean; block: boolean }
interface FlatHtml { units: Unit[]; styles: Styles[]; boundaries: Map<number, number> }
interface Decoded { text: string; colors: ColorRange[]; map(position: number, side: -1 | 1): number }
interface Leaf { from: number; to: number; value: string; units: Unit[]; styles: Styles[]; code: boolean; block: boolean; owned: boolean; lang?: string; physicalSuffix?: string; boundaries?: Map<number, number> }
interface Model { ast: MdNode; leaves: Leaf[]; unknownHtml: Array<{ from: number; to: number }>; protected: Array<{ from: number; to: number; kind: string }> }
const MAX_CHARS = 1_000_000;
const MAX_RANGES = 10_000;

/** 仅导出可无损迁移的顶层自有块；未知属性、内容和缺少末尾换行均拒绝。 */
export function decodeOwnedCodeBlocks(text: string): Array<{ from: number; to: number; code: string; lang: string; ranges: ColorRange[]; positions: Array<{ from: number; to: number }> }> {
  if (text.length > MAX_CHARS) throw new Error("笔记过大，无法安全迁移。");
  const ast = parseMarkdown(text), owned = parseOwned(text, ast).owned.filter((item) => item.code && item.block);
  const protectedRegions = markdownProtectedRanges(text);
  return owned.map((item) => {
    if (protectedRegions.some((range) => item.from < range.to && item.to > range.from)) throw new Error("代码块位于受保护的扩展语法中，未迁移。");
    const top = ast.children?.filter((node) => node.type === "html" && position(node).from <= item.from && position(node).to >= item.to) ?? [];
    if (top.length !== 1 || text.slice(position(top[0]).from, item.from).trim() || text.slice(item.to, position(top[0]).to).trim() || /[^\r\n]/.test(text.slice(text.lastIndexOf("\n", item.from - 1) + 1, item.from))) throw new Error("只支持独立顶层 HTML 代码块迁移，请先分离嵌套或同行内容。");
    const flat = flattenHtml(text, item), code = flat.units.map((unit) => unit.value).join("");
    if (!code.endsWith("\n") || code.includes("\r") && /\r(?!\n)/.test(code)) throw new Error("旧代码缺少末尾换行或使用单独 CR，无法无损恢复围栏。");
    const node = item.node.childNodes.find((child): child is HtmlElement => isElement(child) && child.tagName === "code")!;
    const lang = attr(node, "data-codex-lang") ?? attr(node, "class")?.replace(/^language-/, "") ?? "";
    if (/[\s`~<>]/.test(lang) || attr(node, "class") && attr(node, "class") !== `language-${lang}`) throw new Error("代码语言属性无法安全迁移。");
    for (const element of [item.node, node]) {
      const style = attr(element, "style");
      if (style && style !== (element === item.node ? "white-space:pre;overflow-x:auto" : "display:block;white-space:pre;padding:0;background:transparent;font-family:monospace")) throw new Error("代码容器含未知样式，未迁移。");
    }
    return { from: item.from, to: item.to, code, lang, ranges: styleRanges(flat.styles), positions: flat.units.map(({ from, to }) => ({ from, to })) };
  });
}

/** Live Preview HTML widget 没有 postprocessor section 时，以 CM 提供的源锚点定位。 */
export function mapRenderedCodeAtPosition(text: string, position: number, rendered: string, from: number, to: number): { from: number; to: number } {
  if (!Number.isInteger(position) || position < 0 || position > text.length) throw new Error("代码源锚点无效。");
  const ast = parseMarkdown(text);
  const blocks = parseOwned(text, ast).owned.filter((item) => item.code && item.block);
  const islands = blocks.filter((item) => item.from <= position && position <= item.to);
  if (islands.length !== 1) throw new Error("代码源锚点不在唯一代码块内。");
  // CM 对同一个 HTML widget 内的多个 DOM 子块可能返回相同边界。
  // 即使代码文字相同，也不能用整块文字相等推断块身份；源 HTML token 必须只有一个自有 pre。
  const tokens: Array<{ from: number; to: number }> = [];
  walkMd(ast, (node) => {
    if (node.type !== "html") return;
    const bounds = node.position;
    const start = bounds?.start.offset, end = bounds?.end.offset;
    if (start !== undefined && end !== undefined && start <= islands[0].from && end >= islands[0].to) tokens.push({ from: start, to: end });
  });
  if (tokens.length !== 1 || blocks.filter((item) => item.from >= tokens[0].from && item.to <= tokens[0].to).length !== 1) throw new Error("同一 HTML 渲染区域包含多个代码块，无法确认选区来源。");
  return mapRenderedCodeSelection(text, islands[0].from, islands[0].to, rendered, from, to);
}

/** 渲染选区仅在精确 section 内唯一的自有代码块上定位，绝不按首次文字匹配写回。 */
export function mapRenderedCodeSelection(text: string, sectionFrom: number, sectionTo: number, rendered: string, from: number, to: number): { from: number; to: number } {
  checkSelection(rendered, from, to);
  if (!Number.isInteger(sectionFrom) || !Number.isInteger(sectionTo) || sectionFrom < 0 || sectionTo > text.length || sectionFrom >= sectionTo) throw new Error("代码来源范围无效。");
  const islands = parseOwned(text, parseMarkdown(text)).owned.filter((item) => item.code && item.block && item.from >= sectionFrom && item.to <= sectionTo);
  if (islands.length !== 1) throw new Error("代码来源不唯一，请重新选择代码块。");
  const flat = flattenHtml(text, islands[0]);
  if (flat.units.map((unit) => unit.value).join("") !== rendered) throw new Error("代码显示与来源不一致，请重新选择。");
  const start = flat.units[from], end = flat.units[to - 1];
  if (!start || !end || (from > 0 && flat.units[from - 1].from === start.from) || (to < flat.units.length && flat.units[to].to === end.to)) throw new Error("选区不能拆开实体或 emoji。");
  return { from: start.from, to: end.to };
}

/** 只重建文本叶节点；容器、列表号、格式标记和链接目的地址继续使用原始源码。 */
export function applyMarkdownColor(text: string, from: number, to: number, property?: ColorProperty, color?: string, legacyRanges: readonly ColorRange[] = []): PortableColorEdit {
  checkSelection(text, from, to);
  if (property && !normalizeColor(color ?? "")) throw new Error("颜色须为 #RGB 或 #RRGGBB。");
  const decoded = decodeOwnedColors(text);
  const model = buildModel(decoded.text, [...decoded.colors, ...mapRanges(legacyRanges, decoded.map)]);
  const selection = { from: decoded.map(from, 1), to: decoded.map(to, -1) };
  rejectUnknown(model, selection.from, selection.to);
  let touched = false;
  for (const leaf of model.leaves) {
    const coverage = coveredUnits(leaf, selection.from, selection.to);
    if (!coverage) continue;
    touched = true;
    const ranges = replaceColor(styleRanges(leaf.styles), coverage.from, coverage.to, property, color);
    leaf.styles = stylesFromRanges(leaf.value.length, ranges);
  }
  if (!touched) throw new Error("选区没有可着色的正文；请选择文字，不要只选择格式标签。");
  return finish(decoded.text, model, selection.from, selection.to, true);
}

/** 迁移只接受调用方已核验的精确快照；所有原 offset 一次映射，避免逐次替换造成漂移。 */
export function migrateMarkdownColors(text: string, ranges: readonly ColorRange[]): PortableColorEdit {
  if (!ranges.length) return { text, from: 0, to: 0 };
  if (ranges.length > MAX_RANGES) throw new Error("颜色范围过多，未执行迁移。");
  for (const range of ranges) { checkSelection(text, range.from, range.to); if (!normalizeColor(range.color)) throw new Error("旧颜色数据无效。"); }
  const decoded = decodeOwnedColors(text);
  const mapped = mapRanges(ranges, decoded.map);
  const model = buildModel(decoded.text, decoded.colors);
  for (const range of mapped) {
    rejectUnknown(model, range.from, range.to);
    let touched = false;
    for (const leaf of model.leaves) {
      const coverage = coveredUnits(leaf, range.from, range.to);
      if (!coverage) continue;
      touched = true;
      leaf.styles = stylesFromRanges(leaf.value.length, replaceColor(styleRanges(leaf.styles), coverage.from, coverage.to, range.property, range.color));
    }
    if (!touched) throw new Error("旧颜色范围未定位到正文，已停止迁移。");
  }
  return finish(decoded.text, model, Math.min(...mapped.map((range) => range.from)), Math.max(...mapped.map((range) => range.to)), true);
}

/** 先在内存去掉自有颜色壳，格式标记写到壳外；只有最终文档交给一次编辑事务。 */
export function formatMarkdownSelection(text: string, from: number, to: number, format: Format, legacyRanges: readonly ColorRange[] = [], native = false, applyOnly = false): PortableColorEdit {
  checkSelection(text, from, to);
  const decoded = decodeOwnedColors(text);
  let start = decoded.map(from, 1), end = decoded.map(to, -1);
  const colors = [...decoded.colors, ...mapRanges(legacyRanges, decoded.map)];
  const model = buildModel(decoded.text, colors);
  rejectUnknown(model, start, end);
  const selected = model.leaves.filter((leaf) => coveredUnits(leaf, start, end));
  if (!selected.length) throw new Error("请选择可设置格式的正文。");
  if (selected.some((leaf) => leaf.code && leaf.block)) throw new Error("代码块中的字面格式符不参与加粗或斜体；请在正文中设置格式。");
  const tableCell = findTableCell(model.ast, start, end);
  if (format !== "code" && selected.some((leaf) => leaf.code) && !tableCell) throw new Error("行内代码不能直接切换加粗或斜体，请先取消代码格式。");
  const edits: Edit[] = [];
  if (format === "code") {
    if (selected.length !== 1) throw new Error("代码格式目前仅支持单个连续文本叶节点。");
    const leaf = selected[0];
    const coverage = coveredUnits(leaf, start, end)!;
    const value = leaf.value.slice(coverage.from, coverage.to);
    if (/[\r\n]/.test(value)) throw new Error("多行内容请使用代码块，未改动正文。");
    if (applyOnly && leaf.code) return { text, from, to, ranges: [...legacyRanges] };
    if (leaf.code && (coverage.from !== 0 || coverage.to !== leaf.value.length)) throw new Error("取消代码格式时请选择完整的行内代码。");
    const sourceUnits = leaf.units.slice(coverage.from, coverage.to);
    let replacement: { text: string; pairs: Pair[] };
    if (leaf.code) replacement = literalMarkdown(value, sourceUnits);
    else {
      const delimiter = "`".repeat(Math.max(0, ...Array.from(value.matchAll(/`+/g), (match) => match[0].length)) + 1);
      const padding = value.startsWith("`") || value.endsWith("`") || (value.startsWith(" ") && value.endsWith(" ") && value.trim()) ? " " : "";
      const prefix = delimiter + padding;
      let body = "";
      const pairs = sourceUnits.map((unit, i) => {
        const resultFrom = prefix.length + body.length;
        // GFM 表格即使在行内代码里也需要转义管道；映射包含转义符，清色/取消代码不拆开它。
        body += tableCell && value[i] === "|" ? "\\|" : value[i];
        return { from: unit.from, to: unit.to, resultFrom, resultTo: prefix.length + body.length };
      });
      replacement = { text: prefix + body + padding + delimiter, pairs };
    }
    const editFrom = leaf.code ? leaf.from : sourceUnits[0].from;
    const editTo = leaf.code ? leaf.to : sourceUnits[sourceUnits.length - 1].to;
    edits.push({ from: editFrom, to: editTo, ...replacement });
    // 自有 HTML code 的颜色只在该岛内，转正文时补入映射后的全局颜色。
    const local = styleRanges(leaf.styles).map((range) => ({ ...range, from: leaf.units[range.from].from, to: leaf.units[range.to - 1].to }));
    if (leaf.owned) colors.push(...local);
    start = editFrom; end = editTo;
  } else {
    const paragraph = tableCell ?? findParagraph(model.ast, start, end);
    if (!paragraph) throw new Error("加粗或斜体目前仅支持同一段落内的连续选区。");
    // 全行选择时排除列表/标题/引用的外部前缀，不能把容器标记放进格式符。
    const pFrom = position(paragraph).from, pTo = position(paragraph).to;
    start = Math.max(start, pFrom); end = Math.min(end, pTo);
    const wanted = format === "bold" ? "strong" : "emphasis";
    // 单元格混选保留行内代码，按代码边界分段；空白留在格式符外，确保 Markdown 能解析。
    const spans: Array<{ from: number; to: number }> = [];
    let cursor = start;
    for (const leaf of tableCell ? selected.filter((leaf) => leaf.code) : []) {
      spans.push({ from: cursor, to: Math.min(end, leaf.from) }); cursor = Math.max(cursor, leaf.to);
    }
    spans.push({ from: cursor, to: end });
    // 已有整段格式可能跨过代码；完整选中时直接移除外层，不在未闭合的祖先标记内拼接。
    const enclosing = tableCell && selected.some((leaf) => leaf.code) ? findExactFormat(paragraph, start, end, wanted) : null;
    if (enclosing?.children?.length) {
      if (applyOnly) return { text, from, to, ranges: [...legacyRanges] };
      const bounds = position(enclosing);
      edits.push({ from: bounds.from, to: position(enclosing.children[0]).from, text: "" }, { from: position(enclosing.children.at(-1)!).to, to: bounds.to, text: "" });
      spans.length = 0;
    }
    for (const span of spans) {
      let partFrom = span.from, partTo = span.to;
      if (tableCell) {
        // 以可见文字定位分段，避免把跨代码的 strong/emphasis 起止标记拆进不同片段。
        const units = selected.filter((leaf) => !leaf.code).flatMap((leaf) => leaf.units).filter((unit) => unit.from >= partFrom && unit.to <= partTo);
        while (units.length && /^\s+$/.test(units[0].value)) units.shift();
        while (units.length && /^\s+$/.test(units.at(-1)!.value)) units.pop();
        if (!units.length) continue;
        partFrom = units[0].from; partTo = units.at(-1)!.to;
      }
      if (partFrom >= partTo) continue;
      // 重复格式只补加，不把已有格式切掉；部分选中同一格式容器也保持原样。
      if (applyOnly) {
        let alreadyApplied = false;
        walkMd(paragraph, (node) => {
          const bounds = position(node);
          if (node.type === wanted && bounds.from <= partFrom && bounds.to >= partTo) alreadyApplied = true;
        });
        if (alreadyApplied) continue;
      }
      const wrapper = findExactFormat(paragraph, partFrom, partTo, wanted);
      if (wrapper?.children?.length) {
        const bounds = position(wrapper);
        const innerFrom = position(wrapper.children[0]).from;
        const innerTo = position(wrapper.children[wrapper.children.length - 1]).to;
        edits.push({ from: bounds.from, to: innerFrom, text: "" }, { from: innerTo, to: bounds.to, text: "" });
        if (!tableCell) { start = innerFrom; end = innerTo; }
      } else {
        const delimiter = format === "bold" ? "**" : "*";
        edits.push({ from: partFrom, to: partFrom, text: delimiter }, { from: partTo, to: partTo, text: delimiter });
      }
    }
  }
  const changed = editText(decoded.text, edits);
  const next = buildModel(changed.text, mapRanges(colors, changed.map));
  const result = native ? { text: changed.text, from: changed.map(start, 1), to: changed.map(end, -1), ranges: mapRanges(colors, changed.map) } : finish(changed.text, next, changed.map(start, 1), changed.map(end, -1), false);
  if (containerSignature(model.ast) !== containerSignature(next.ast) || visibleSignature(model) !== visibleSignature(next)) throw new Error("格式操作将改变正文结构或代码文字，已停止。");
  return result;
}

function parseMarkdown(text: string): MdNode {
  if (text.length > MAX_CHARS) throw new Error("当前文档超过 100 万字符，未执行同步改色。");
  // YAML 不参与正文解析。等长遮罩保留 CR/LF 与 UTF16 offset，也避免 micromark 吞掉 BOM 后位置整体偏移。
  const yamlEnd = frontmatterEnd(text);
  const source = yamlEnd ? text.slice(0, yamlEnd).replace(/[^\r\n]/g, " ") + text.slice(yamlEnd) : text;
  return fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }) as unknown as MdNode;
}
function position(node: MdNode): { from: number; to: number } {
  const from = node.position?.start.offset, to = node.position?.end.offset;
  if (from === undefined || to === undefined) throw new Error("Markdown 节点缺少真实源码位置。");
  return { from, to };
}
function walkMd(node: MdNode, action: (node: MdNode) => void): void { action(node); for (const child of node.children ?? []) walkMd(child, action); }
function isElement(node: HtmlNode): node is HtmlElement { return "tagName" in node; }
function attr(node: HtmlElement, name: string): string | undefined { return node.attrs.find((item) => item.name === name)?.value; }
function parseOwned(text: string, ast: MdNode): { owned: Owned[]; unknown: Array<{ from: number; to: number }> } {
  const html: Array<{ from: number; to: number }> = [], code: Array<{ from: number; to: number }> = [];
  walkMd(ast, (node) => { if (node.type === "html") html.push(position(node)); if (node.type === "code" || node.type === "inlineCode") code.push(position(node)); });
  const fragment = parseFragment(text, { sourceCodeLocationInfo: true });
  const owned: Owned[] = [], unknown: Array<{ from: number; to: number }> = [];
  const visit = (node: HtmlNode, insideCode = false, insideOwned = false, unknownParent = false): void => {
    if (isElement(node)) {
      const location = node.sourceCodeLocation;
      if (location) {
        const from = location.startOffset, to = location.endOffset;
        if (code.some((range) => range.from <= from && range.to >= to)) return;
        const actualHtml = html.some((range) => range.from <= from && from < range.to);
        const ownedColor = node.tagName === "span" && attr(node, "data-codex-color") === "1";
        const ownedCode = (node.tagName === "pre" || node.tagName === "code") && attr(node, "data-codex-code") === "1";
        if ((ownedColor || ownedCode) && actualHtml) {
          if (unknownParent) throw new Error("插件颜色嵌在未知 HTML 容器中，未改动正文。");
          if (!location.startTag || !location.endTag) throw new Error("插件颜色标签不完整，请先恢复标签。");
          if (!insideCode && !insideOwned) owned.push({ node, from, to, code: ownedCode, block: node.tagName === "pre" });
          insideOwned = true;
          if (ownedCode) insideCode = true;
        } else if (actualHtml && !insideOwned) { unknown.push({ from, to }); unknownParent = true; }
      }
    }
    if ("childNodes" in node) for (const child of node.childNodes) visit(child, insideCode, insideOwned, unknownParent);
  };
  visit(fragment);
  // parse5 对未知或被自动闭合的 HTML 可能没有完整元素位置，Mdast html token 仍需受保护。
  for (const token of html) if (!owned.some((item) => item.from <= token.from && item.to >= token.to)) unknown.push(token);
  return { owned: owned.sort((a, b) => a.from - b.from), unknown };
}
function parseStyles(node: HtmlElement): Styles {
  const output: Styles = {};
  for (const declaration of (attr(node, "style") ?? "").split(";")) {
    if (!declaration.trim()) continue;
    const colon = declaration.indexOf(":");
    const name = declaration.slice(0, colon).trim().toLowerCase(), value = declaration.slice(colon + 1).trim();
    const color = normalizeColor(value);
    if ((name !== "color" && name !== "background-color") || !color) throw new Error("插件颜色标签包含未知样式，未改动正文。");
    output[name === "color" ? "foreground" : "background"] = color;
  }
  return output;
}
function flattenHtml(text: string, item: Owned): FlatHtml {
  const units: Unit[] = [], styles: Styles[] = [], boundaries = new Map<number, number>();
  const visit = (node: HtmlNode, inherited: Styles, root = false): void => {
    const location = node.sourceCodeLocation;
    if (location) boundaries.set(location.startOffset, units.length);
    if (node.nodeName === "#text" && "value" in node) {
      if (!location) throw new Error("HTML 文字缺少源码位置。");
      const mapped = lexText(text.slice(location.startOffset, location.endOffset), location.startOffset, false);
      if (mapped.map((unit) => unit.value).join("") !== node.value) throw new Error("HTML 实体或换行无法精确映射。");
      for (const unit of mapped) { units.push(unit); styles.push({ ...inherited }); }
    } else if (isElement(node)) {
      const color = node.tagName === "span" && attr(node, "data-codex-color") === "1";
      const code = item.code && (root || node.tagName === "code");
      if (!color && !code) throw new Error("插件颜色区域含未知 HTML 子结构，未改动正文。");
      const allowed = color ? new Set(["data-codex-color", "style"]) : new Set(["data-codex-code", "class", "style", "data-codex-lang"]);
      if (node.attrs.some((attribute) => !allowed.has(attribute.name))) throw new Error("插件 HTML 含未知属性，未改动正文。");
      if (!location || !("startTag" in location) || !location.startTag || !location.endTag) throw new Error("插件 HTML 标签未闭合。");
      const current = color ? { ...inherited, ...parseStyles(node) } : inherited;
      boundaries.set(location.startTag.endOffset, units.length);
      // pre 边界换行属于 HTML 排版，不属于代码正文；仅允许空白及唯一 code。
      if (root && item.code && item.block) {
        const code = node.childNodes.filter((child) => isElement(child) && child.tagName === "code");
        if (code.length !== 1 || node.childNodes.some((child) => child !== code[0] && !(child.nodeName === "#text" && "value" in child && /^[\t\n\r\f ]*$/.test(child.value)))) throw new Error("插件代码容器结构不完整。");
        visit(code[0], current);
      } else for (const child of node.childNodes) visit(child, current);
      boundaries.set(location.endTag.startOffset, units.length);
    } else if ("childNodes" in node) for (const child of node.childNodes) visit(child, inherited);
    else throw new Error("插件颜色区域含无法确认的 HTML 内容。");
    if (location) boundaries.set(location.endOffset, units.length);
  };
  visit(item.node, {}, true);
  return { units, styles, boundaries };
}

function decodeOwnedColors(text: string): Decoded {
  const ast = parseMarkdown(text), { owned } = parseOwned(text, ast);
  const edits: Edit[] = [], carriers: Array<{ edit: Edit; ranges: ColorRange[] }> = [];
  for (const item of owned.filter((part) => !part.code)) {
    const flat = flattenHtml(text, item);
    if (flat.units.some((unit) => /[\r\n]/.test(unit.value))) throw new Error("跨物理行的插件 span 暂不支持安全修改。");
    const encoded = literalMarkdown(flat.units.map((unit) => unit.value).join(""), flat.units);
    const boundaries = new Map<number, number>();
    const logicalBoundary = (index: number): number => index >= encoded.pairs.length ? encoded.text.length : encoded.pairs[index].resultFrom;
    for (const [from, index] of flat.boundaries) boundaries.set(from, logicalBoundary(index));
    const edit: Edit = { from: item.from, to: item.to, ...encoded, boundaries, strict: true };
    const ranges = styleRanges(flat.styles).map((range) => ({ ...range, from: logicalBoundary(range.from), to: range.to ? encoded.pairs[range.to - 1].resultTo : 0 }));
    edits.push(edit); carriers.push({ edit, ranges });
  }
  const changed = editText(text, edits);
  const ranges: ColorRange[] = [];
  for (const carrier of carriers) {
    const start = changed.map(carrier.edit.from, -1);
    ranges.push(...carrier.ranges.map((range) => ({ ...range, from: start + range.from, to: start + range.to })));
  }
  return { text: changed.text, colors: mergeRanges(ranges), map: changed.map };
}

function buildModel(text: string, colors: readonly ColorRange[]): Model {
  const ast = parseMarkdown(text), html = parseOwned(text, ast), leaves: Leaf[] = [];
  const codeIslands = html.owned.filter((item) => item.code);
  for (const island of codeIslands) {
    const flat = flattenHtml(text, island);
    const code = island.block ? island.node.childNodes.find((node): node is HtmlElement => isElement(node) && node.tagName === "code") : island.node;
    if (!code) throw new Error("插件代码容器结构不完整。");
    const lang = attr(code, "data-codex-lang") ?? attr(code, "class")?.replace(/^language-/, "");
    leaves.push({ from: island.from, to: island.to, value: flat.units.map((unit) => unit.value).join(""), units: flat.units, styles: flat.styles, code: true, block: island.block, owned: true, lang, boundaries: flat.boundaries });
  }
  const tables: Array<{ from: number; to: number }> = [];
  walkMd(ast, (node) => { if (node.type === "table") tables.push(position(node)); });
  walkMd(ast, (node) => {
    const bounds = position(node);
    if (codeIslands.some((island) => island.from <= bounds.from && island.to >= bounds.to)) return;
    if (node.type !== "text" && node.type !== "inlineCode" && node.type !== "code") return;
    let units: Unit[];
    let physicalSuffix = "";
    if (node.type === "text") units = markdownTextUnits(text, node);
    else if (node.type === "inlineCode") units = inlineCodeUnits(text, node, tables.some((table) => bounds.from >= table.from && bounds.to <= table.to));
    else {
      units = blockCodeUnits(text, node);
      if (!/^(`{3,}|~{3,})/.test(text.slice(bounds.from, bounds.to))) {
        // 缩进代码的 node.end 不含末尾物理换行；该换行既属于代码，也承担块后的分隔。
        physicalSuffix = /^(?:\r\n|\r|\n)/.exec(text.slice(bounds.to))?.[0] ?? "";
        for (let i = 0; i < physicalSuffix.length; i++) units.push({ from: bounds.to + i, to: bounds.to + i + 1, value: physicalSuffix[i] });
        bounds.to += physicalSuffix.length;
      }
    }
    leaves.push({ ...bounds, value: units.map((unit) => unit.value).join(""), units, styles: stylesForUnits(units, colors), code: node.type !== "text", block: node.type === "code", owned: false, lang: node.lang ?? undefined, physicalSuffix });
  });
  leaves.sort((a, b) => a.from - b.from);
  for (let i = 1; i < leaves.length; i++) if (leaves[i - 1].to > leaves[i].from) throw new Error("文本节点位置交叠，未改动正文。");
  return { ast, leaves, unknownHtml: html.unknown, protected: protectedExtensions(text, leaves.filter((leaf) => leaf.code), leaves.filter((leaf) => !leaf.code)) };
}

function lexText(raw: string, base: number, markdown: boolean): Unit[] {
  const units: Unit[] = [];
  const add = (value: string, from: number, to: number): void => { for (let i = 0; i < value.length; i++) units.push({ from: base + from, to: base + to, value: value[i] }); };
  let emitted = "";
  const decoder = new EntityDecoder(htmlDecodeTree, (point) => { emitted += String.fromCodePoint(point); });
  for (let i = 0; i < raw.length;) {
    if (raw[i] === "&") {
      emitted = ""; decoder.startEntity(markdown ? DecodingMode.Strict : DecodingMode.Legacy);
      let length = decoder.write(raw, i + 1); if (length < 0) length = decoder.end();
      if (length > 0 && emitted) { add(emitted, i, i + length); i += length; continue; }
    }
    if (markdown && raw[i] === "\\" && /[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]/.test(raw[i + 1] ?? "")) { add(raw[i + 1], i, i + 2); i += 2; continue; }
    if (raw[i] === "\r") { const width = raw[i + 1] === "\n" ? 2 : 1; add("\n", i, i + width); i += width; continue; }
    const point = String.fromCodePoint(raw.codePointAt(i)!); add(point, i, i + point.length); i += point.length;
  }
  return units;
}
function markdownTextUnits(text: string, node: MdNode): Unit[] {
  const { from, to } = position(node);
  const raw = text.slice(from, to), value = node.value ?? "";
  const direct = lexText(raw, from, true);
  if (direct.map((unit) => unit.value).join("") === value) return direct;
  // 多行文本位置中可能包含 list/blockquote 的容器前缀，按解析器每行值核对并保留前缀间隙。
  const values = value.split("\n"), lines = raw.split(/\r\n|\r|\n/), result: Unit[] = [];
  if (values.length !== lines.length) throw new Error("Markdown 文字无法精确映射。");
  let cursor = from;
  for (let i = 0; i < lines.length; i++) {
    const units = lexText(lines[i], cursor, true), decoded = units.map((unit) => unit.value).join("");
    if (!decoded.endsWith(values[i]) || !/^[\s>]*$/.test(decoded.slice(0, decoded.length - values[i].length))) throw new Error("Markdown 容器缩进无法精确映射。");
    result.push(...units.slice(decoded.length - values[i].length));
    cursor += lines[i].length;
    if (i < lines.length - 1) { const width = text[cursor] === "\r" && text[cursor + 1] === "\n" ? 2 : 1; result.push({ from: cursor, to: cursor + width, value: "\n" }); cursor += width; }
  }
  return result;
}
function inlineCodeUnits(text: string, node: MdNode, table = false): Unit[] {
  const { from, to } = position(node), raw = text.slice(from, to);
  const delimiter = /^`+/.exec(raw)?.[0];
  if (!delimiter || !raw.endsWith(delimiter)) throw new Error("行内代码边界不完整。");
  let start = from + delimiter.length, end = to - delimiter.length;
  let value = text.slice(start, end).replace(/\r\n|\r|\n/g, " ");
  if (value.startsWith(" ") && value.endsWith(" ") && value.trim()) { start++; end--; value = value.slice(1, -1); }
  if ((table ? value.replace(/\\\|/g, "|") : value) !== node.value) throw new Error("行内代码文字无法精确映射。");
  const units: Unit[] = [];
  for (let i = start; i < end;) {
    if (table && text[i] === "\\" && text[i + 1] === "|") { units.push({ from: i, to: i + 2, value: "|" }); i += 2; continue; }
    const width = text[i] === "\r" && text[i + 1] === "\n" ? 2 : String.fromCodePoint(text.codePointAt(i)!).length;
    const logical = /[\r\n]/.test(text[i]) ? " " : text.slice(i, i + width);
    for (const char of logical.split("")) units.push({ from: i, to: i + width, value: char });
    i += width;
  }
  return units;
}
function blockCodeUnits(text: string, node: MdNode): Unit[] {
  const { from, to } = position(node), raw = text.slice(from, to), firstEnd = raw.search(/[\r\n]/);
  const fence = /^(`{3,}|~{3,})/.exec(raw)?.[0];
  const rawLines: Array<{ value: string; from: number; newline: string }> = [];
  let cursor = from;
  for (const match of raw.matchAll(/([^\r\n]*)(\r\n|\r|\n|$)/g)) {
    if (!match[0]) continue;
    rawLines.push({ value: match[1], from: cursor, newline: match[2] }); cursor += match[0].length;
  }
  let body = rawLines;
  if (fence) {
    const last = rawLines[rawLines.length - 1];
    const closing = new RegExp(`^[ \\t>]*${fence[0] === "`" ? "`" : "~"}{${fence.length},}[ \\t]*$`);
    if (firstEnd < 0 || rawLines.length < 2 || !closing.test(last.value)) throw new Error("代码围栏未闭合或外部容器无法确认。");
    body = rawLines.slice(1, -1);
  }
  // mdast 保留原始行结束符；这里只比较每行正文，实际换行仍逐字取自 rawLines。
  const values = (node.value ?? "").split(/\r\n|\r|\n/);
  if (!body.length && !node.value) return [];
  if (body.length !== values.length) throw new Error("代码行数无法精确映射。");
  const units: Unit[] = [];
  for (let i = 0; i < body.length; i++) {
    const line = body[i], value = values[i];
    if (!line.value.endsWith(value) || !/^[\s>]*$/.test(line.value.slice(0, line.value.length - value.length))) throw new Error("代码缩进无法精确映射，未转换代码块。");
    const start = line.from + line.value.length - value.length;
    for (let j = 0; j < value.length;) { const point = String.fromCodePoint(value.codePointAt(j)!); for (const char of point.split("")) units.push({ from: start + j, to: start + j + point.length, value: char }); j += point.length; }
    for (let j = 0; j < line.newline.length; j++) units.push({ from: line.from + line.value.length + j, to: line.from + line.value.length + j + 1, value: line.newline[j] });
  }
  return units;
}

function coveredUnits(leaf: Leaf, from: number, to: number): { from: number; to: number } | null {
  if (leaf.owned) for (const boundary of [from, to]) {
    if (boundary <= leaf.from || boundary >= leaf.to || leaf.boundaries?.has(boundary) || leaf.units.some((unit) => unit.from === boundary || unit.to === boundary)) continue;
    if (!leaf.units.some((unit) => unit.from < boundary && unit.to > boundary)) throw new Error("选区落在生成的 HTML 标签中，请只选择代码文字。");
  }
  const selected: number[] = [];
  for (let i = 0; i < leaf.units.length; i++) {
    const unit = leaf.units[i];
    if (unit.from >= to || unit.to <= from) continue;
    if (unit.from < from || unit.to > to) throw new Error("选区切开了实体、转义或 emoji，请重新完整选择字符。");
    selected.push(i);
  }
  if (!selected.length) return null;
  return { from: selected[0], to: selected[selected.length - 1] + 1 };
}
function stylesForUnits(units: readonly Unit[], ranges: readonly ColorRange[]): Styles[] {
  const byProperty = { foreground: ranges.filter((range) => range.property === "foreground").sort((a, b) => a.from - b.from), background: ranges.filter((range) => range.property === "background").sort((a, b) => a.from - b.from) };
  return units.map((unit) => {
    const styles: Styles = {};
    for (const property of ["foreground", "background"] as const) {
      const items = byProperty[property]; let low = 0, high = items.length;
      while (low < high) { const middle = (low + high) >>> 1; if (items[middle].from <= unit.from) low = middle + 1; else high = middle; }
      const range = items[low - 1];
      if (range && range.from <= unit.from && range.to >= unit.to) styles[property] = range.color;
    }
    return styles;
  });
}
function stylesFromRanges(length: number, ranges: readonly ColorRange[]): Styles[] { return stylesForUnits(Array.from({ length }, (_, i) => ({ from: i, to: i + 1, value: "" })), ranges); }
function styleRanges(styles: readonly Styles[]): ColorRange[] {
  const ranges: ColorRange[] = [];
  for (const property of ["foreground", "background"] as const) {
    let previous: ColorRange | undefined;
    for (let i = 0; i < styles.length; i++) {
      const color = styles[i][property];
      if (!color) { previous = undefined; continue; }
      if (previous && previous.color === color) previous.to++;
      else { previous = { from: i, to: i + 1, property, color }; ranges.push(previous); }
    }
  }
  if (ranges.length > MAX_RANGES) throw new Error("颜色片段超过 10,000 个，未改动正文。");
  return ranges;
}
function encodeText(value: string): string {
  return value.replace(/[&<>"'\r\n\t\\`*_\[\]]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "\r": "&#13;", "\n": "&#10;", "\t": "&#9;" }[char] ?? `&#${char.charCodeAt(0)};`));
}
function literalMarkdown(value: string, units: readonly Unit[]): { text: string; pairs: Pair[] } {
  let text = ""; const pairs: Pair[] = [];
  for (let i = 0; i < value.length;) {
    const point = String.fromCodePoint(value.codePointAt(i)!);
    const escaped = /^[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]$/.test(point) ? `\\${point}` : point;
    const start = text.length; text += escaped;
    for (let j = 0; j < point.length; j++) pairs.push({ from: units[i + j].from, to: units[i + j].to, resultFrom: start, resultTo: text.length });
    i += point.length;
  }
  return { text, pairs };
}
function styleAttribute(style: Styles): string { return [style.foreground ? `color:${style.foreground}` : "", style.background ? `background-color:${style.background}` : ""].filter(Boolean).join(";"); }
function renderLeaf(text: string, leaf: Leaf): Edit | null {
  const hasColors = leaf.styles.some((style) => style.foreground || style.background);
  if (leaf.code && !leaf.owned && !hasColors) return null;
  if (!leaf.code && !hasColors) return null;
  let output = ""; const pairs: Pair[] = [];
  if (leaf.code) {
    if (leaf.lang && !/^[a-zA-Z0-9_+.-]{1,64}$/.test(leaf.lang)) throw new Error("代码语言标记不能安全转换。");
    // language-* 会让 Prism 用 textContent 重建代码 DOM 并抹掉颜色；语言只保留为自有元数据。
    const language = leaf.lang ? ` data-codex-lang="${leaf.lang}"` : "";
    output += leaf.block ? `<pre data-codex-code="1" style="white-space:pre;overflow-x:auto"><code${language} style="display:block;white-space:pre;padding:0;background:transparent;font-family:monospace">` : '<code data-codex-code="1">';
  }
  let rawCursor = leaf.from;
  for (let i = 0; i < leaf.units.length;) {
    const style = leaf.styles[i], attribute = styleAttribute(style), start = i;
    let end = i + 1;
    while (end < leaf.units.length && styleAttribute(leaf.styles[end]) === attribute && (leaf.code || ((leaf.units[end - 1].to === leaf.units[end].from || (leaf.units[end - 1].from === leaf.units[end].from && leaf.units[end - 1].to === leaf.units[end].to)) && !/[\r\n]/.test(leaf.units[end].value) && !/[\r\n]/.test(leaf.units[end - 1].value)))) end++;
    if (!leaf.code && rawCursor < leaf.units[start].from) output += text.slice(rawCursor, leaf.units[start].from);
    const wrapped = Boolean(attribute) && (leaf.code || !/[\r\n]/.test(leaf.units[start].value));
    if (wrapped) output += `<span data-codex-color="1" style="${attribute}">`;
    for (let j = start; j < end;) {
      const unit = leaf.units[j];
      let count = 1;
      while (j + count < end && leaf.units[j + count].from === unit.from && leaf.units[j + count].to === unit.to) count++;
      const value = leaf.value.slice(j, j + count), resultFrom = output.length;
      output += wrapped || leaf.code ? encodeText(value) : text.slice(unit.from, unit.to);
      for (let k = 0; k < count; k++) pairs.push({ from: unit.from, to: unit.to, resultFrom, resultTo: output.length });
      j += count;
    }
    if (wrapped) output += "</span>";
    rawCursor = leaf.units[end - 1].to;
    i = end;
  }
  if (leaf.code) output += (leaf.block ? "</code></pre>" : "</code>") + (leaf.physicalSuffix ?? "");
  else if (rawCursor < leaf.to) output += text.slice(rawCursor, leaf.to);
  return { from: leaf.from, to: leaf.to, text: output, pairs };
}
function finish(text: string, model: Model, from: number, to: number, sameSemantics: boolean): PortableColorEdit {
  const edits = model.leaves.map((leaf) => renderLeaf(text, leaf)).filter((edit): edit is Edit => edit !== null);
  const changed = editText(text, edits);
  const normalized = decodeOwnedColors(changed.text), reparsed = buildModel(normalized.text, normalized.colors);
  if (sameSemantics && (containerSignature(model.ast, true) !== containerSignature(reparsed.ast, true) || visibleSignature(model) !== visibleSignature(reparsed))) throw new Error("颜色写入将改变列表、格式或代码文字，已停止。");
  return { text: changed.text, from: changed.map(from, 1), to: changed.map(to, -1) };
}
function editText(text: string, edits: readonly Edit[]): Mapped {
  const sorted = [...edits].sort((a, b) => a.from - b.from || a.to - b.to);
  let cursor = 0, output = "";
  const locations: Array<{ edit: Edit; start: number }> = [];
  for (const edit of sorted) {
    if (edit.from < cursor) throw new Error("编辑范围交叠，未改动正文。");
    output += text.slice(cursor, edit.from); locations.push({ edit, start: output.length }); output += edit.text; cursor = edit.to;
  }
  output += text.slice(cursor);
  return { text: output, map(position, side) {
    let shift = 0;
    for (const { edit, start } of locations) {
      if (position < edit.from) break;
      // 选区右端应停在最后一个逻辑字符之后，不能吞入新生成的关闭标签。
      if (position === edit.to && edit.from !== edit.to && side === -1) {
        const boundary = edit.boundaries?.get(position);
        if (boundary !== undefined) return start + boundary;
        if (edit.pairs?.length) return start + edit.pairs[edit.pairs.length - 1].resultTo;
      }
      if (position > edit.to || (position === edit.to && edit.from !== edit.to)) { shift += edit.text.length - (edit.to - edit.from); continue; }
      if (edit.from === edit.to) return start + (side === 1 ? edit.text.length : 0);
      const boundary = edit.boundaries?.get(position);
      if (boundary !== undefined) return start + boundary;
      const exact = edit.pairs?.filter((pair) => pair.from === position || pair.to === position);
      if (exact?.length) return start + (side === 1 ? Math.max(...exact.map((pair) => pair.from === position ? pair.resultFrom : pair.resultTo)) : Math.min(...exact.map((pair) => pair.to === position ? pair.resultTo : pair.resultFrom)));
      if (position === edit.from) return start + (edit.pairs?.[0]?.resultFrom ?? 0);
      if (position === edit.to) return start + (edit.pairs?.[edit.pairs.length - 1]?.resultTo ?? edit.text.length);
      if (edit.pairs?.some((pair) => pair.from < position && pair.to > position)) throw new Error("选区切开了实体或 emoji。");
      if (edit.strict) throw new Error("选区落在生成的 HTML 标签中，请重新选择正文。");
      if (edit.pairs?.length) {
        const next = edit.pairs.find((pair) => pair.from > position), previous = [...edit.pairs].reverse().find((pair) => pair.to < position);
        return start + (side === 1 ? next?.resultFrom ?? previous!.resultTo : previous?.resultTo ?? next!.resultFrom);
      }
      return start;
    }
    return position + shift;
  } };
}
function mapRanges(ranges: readonly ColorRange[], map: (position: number, side: -1 | 1) => number): ColorRange[] { return mergeRanges(ranges.map((range) => ({ ...range, from: map(range.from, 1), to: map(range.to, -1) })).filter((range) => range.from < range.to)); }
function checkSelection(text: string, from: number, to: number): void {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to > text.length || from >= to) throw new Error("没有有效的连续选区。");
  for (const boundary of [from, to]) if (boundary > 0 && /[\uD800-\uDBFF]/.test(text[boundary - 1]) && /[\uDC00-\uDFFF]/.test(text[boundary] ?? "")) throw new Error("选区切开 emoji，请完整选择字符。");
}
function rejectUnknown(model: Model, from: number, to: number): void {
  if (model.unknownHtml.some((range) => range.from < to && range.to > from)) throw new Error("选区包含非插件拥有的 HTML，未改动正文。");
  const protectedRange = model.protected.find((range) => range.from < to && range.to > from);
  if (protectedRange) throw new Error(`选区包含尚不支持着色的${protectedRange.kind}扩展语法，未改动正文。`);
}

export function frontmatterEnd(text: string): number {
  // 仅文档第一行开启 YAML；未闭合时保护至全文末尾，不猜测属性范围。
  const yamlOpen = /^(?:\uFEFF)?---[ \t]*(?:\r\n|\r|\n|$)/.exec(text);
  if (!yamlOpen) return 0;
  const close = /^(?:---|\.\.\.)[ \t]*(?:\r\n|\r|\n|$)/m.exec(text.slice(yamlOpen[0].length));
  return close ? yamlOpen[0].length + close.index + close[0].length : text.length;
}

/** 共用扩展语法边界，避免原生代码颜色绕过 YAML、注释、公式和高亮保护。 */
export function markdownProtectedRanges(text: string): Array<{ from: number; to: number; kind: string }> {
  return buildModel(text, []).protected;
}

/** 仅作为已完整解析文档上的安全护栏，不尝试把未知 Obsidian 扩展当作普通文本重写。 */
function protectedExtensions(text: string, code: readonly Leaf[], prose: readonly Leaf[]): Array<{ from: number; to: number; kind: string }> {
  const output: Array<{ from: number; to: number; kind: string }> = [];
  const yamlEnd = frontmatterEnd(text);
  if (yamlEnd) output.push({ from: 0, to: yamlEnd, kind: "YAML frontmatter" });
  const excluded = [...code].sort((a, b) => a.from - b.from);
  const containing = <T extends { from: number; to: number }>(items: readonly T[], offset: number): T | undefined => {
    let low = 0, high = items.length;
    while (low < high) { const middle = (low + high) >>> 1; if (items[middle].from <= offset) low = middle + 1; else high = middle; }
    const item = items[low - 1]; return item && offset < item.to ? item : undefined;
  };
  const containingCode = (offset: number): Leaf | undefined => containing(excluded, offset);
  const closing = (delimiter: string, start: number): number => {
    for (let i = start; i < text.length;) {
      const leaf = containingCode(i);
      if (leaf) { i = leaf.to; continue; }
      if (text[i] === "\\") { i += 2; continue; }
      if (text.startsWith(delimiter, i)) return i;
      i++;
    }
    return -1;
  };
  for (let i = yamlEnd; i < text.length;) {
    const leaf = containingCode(i);
    if (leaf) { i = leaf.to; continue; }
    if (text[i] === "\\") { i += 2; continue; }
    // 只识别正文 token 的扩展标记，不把 Setext 标题下划线或链接目的地址当成高亮/公式。
    const textLeaf = containing(prose, i);
    if (!textLeaf || !containing(textLeaf.units, i)) { i++; continue; }
    let open = "", close = "", kind = "";
    if (text.startsWith("[[", i)) { open = "[["; close = "]]"; kind = "双链"; }
    else if (text.startsWith("%%", i)) { open = close = "%%"; kind = "注释"; }
    else if (text.startsWith("==", i)) { open = close = "=="; kind = "高亮"; }
    else if (text.startsWith("$$", i)) { open = close = "$$"; kind = "公式"; }
    else if (text[i] === "$") { open = close = "$"; kind = "公式"; }
    if (!open) { i++; continue; }
    const end = closing(close, i + open.length);
    if (end < 0) { if (open === "%%" || open === "$$") output.push({ from: i, to: text.length, kind }); i += open.length; continue; }
    output.push({ from: i, to: end + close.length, kind }); i = end + close.length;
  }
  return output;
}
function containerSignature(ast: MdNode, includeFormatting = false): string {
  const result: unknown[] = [];
  walkMd(ast, (node) => { if (["list", "listItem", "blockquote", "heading", "link", "linkReference", "image", "imageReference", "definition", "table", "tableRow", "tableCell", ...(includeFormatting ? ["strong", "emphasis", "delete"] : [])].includes(node.type)) result.push([node.type, node.ordered, node.start, node.checked, node.depth, node.url, node.title, node.identifier]); });
  return JSON.stringify(result);
}
function visibleSignature(model: Model): string { return model.leaves.map((leaf) => leaf.value).join(""); }
function findParagraph(ast: MdNode, from: number, to: number): MdNode | null {
  let result: MdNode | null = null;
  walkMd(ast, (node) => { if (node.type !== "paragraph" && node.type !== "heading") return; const bounds = position(node); if (bounds.from <= to && bounds.to >= from) { if (result) result = ast; else result = node; } });
  return result === ast ? null : result;
}
function findExactFormat(node: MdNode, from: number, to: number, wanted: string): MdNode | null {
  let result: MdNode | null = null;
  walkMd(node, (candidate) => {
    if (candidate.type !== wanted || !candidate.children?.length) return;
    const outer = position(candidate);
    // 选中文字通常不含嵌套格式符。只穿透透明格式层判断是否完整选中，不能穿透链接/代码。
    // 真正移除时仍用调用方的直接子节点边界，保留另外一层加粗/斜体及其颜色。
    let first = candidate.children[0], last = candidate.children[candidate.children.length - 1];
    while (["strong", "emphasis", "delete"].includes(first.type) && first.children?.length) first = first.children[0];
    while (["strong", "emphasis", "delete"].includes(last.type) && last.children?.length) last = last.children[last.children.length - 1];
    const innerFrom = position(first).from, innerTo = position(last).to;
    if (from >= outer.from && from <= innerFrom && to >= innerTo && to <= outer.to) result = candidate;
  });
  return result;
}

function findTableCell(ast: MdNode, from: number, to: number): MdNode | null {
  let result: MdNode | null = null;
  walkMd(ast, (node) => {
    if (node.type === "tableCell" && node.children?.length && position(node.children[0]).from <= from && position(node.children.at(-1)!).to >= to) result = node;
  });
  return result;
}

/** 原生正文只接受已知 Markdown 容器；返回文字单元，列表号、链接地址和格式符不参与着色。 */
export function nativeTextBlocks(text: string): Array<{ from: number; to: number; line: number; kind: string; structure: string; supported: boolean; cells: Array<{ from: number; to: number }>; units: Array<{ from: number; to: number }> }> {
  const ast = parseMarkdown(text), model = buildModel(text, []);
  const allowed = new Set(["paragraph", "heading", "list", "listItem", "text", "inlineCode", "strong", "emphasis", "delete", "link", "break", "table", "tableRow", "tableCell"]);
  return (ast.children ?? []).filter((node) => ["paragraph", "heading", "list", "table"].includes(node.type)).map((node) => {
    const { from, to } = position(node); let supported = true;
    const shape: unknown[] = [], cells: Array<{ from: number; to: number }> = [];
    // 持久化仍以完整表格为单位；交互只允许同一非空单元格的内容，管道/分隔行不属于内容。
    walkMd(node, (child) => {
      if (child.type === "tableCell" && child.children?.length) cells.push({ from: position(child.children[0]).from, to: position(child.children.at(-1)!).to });
    });
    walkMd(node, (child) => shape.push([child.type, child.spread, child.ordered, child.start, child.depth, child.checked, child.url]));
    walkMd(node, (child) => { if (!allowed.has(child.type)) supported = false; });
    if (model.protected.some((range) => from < range.to && to > range.from) || model.unknownHtml.some((range) => from < range.to && to > range.from)) supported = false;
    const leaves = model.leaves.filter((leaf) => leaf.from >= from && leaf.to <= to);
    if (leaves.some((leaf) => leaf.owned || leaf.block)) supported = false;
    return { from, to, line: node.position!.start.line - 1, kind: node.type, structure: JSON.stringify(shape), supported, cells, units: leaves.flatMap((leaf) => leaf.units.map(({ from, to }) => ({ from, to }))) };
  });
}

/** 严格解码旧正文/行内代码，不猜测外部 HTML；颜色映射到恢复后的原生 Markdown 源码。 */
export function restoreOwnedInline(text: string): { text: string; ranges: ColorRange[]; count: number; map(position: number): number } {
  const owned = parseOwned(text, parseMarkdown(text)).owned.filter((item) => !item.block);
  const edits: Edit[] = [], carriers: Array<{ from: number; ranges: ColorRange[] }> = [];
  for (const item of owned) {
    const flat = flattenHtml(text, item), value = flat.units.map((unit) => unit.value).join("");
    if (/[\r\n]/.test(value)) throw new Error("跨行旧正文 HTML 暂不支持恢复，原文已保留。");
    let encoded: { text: string; pairs: Pair[] };
    if (item.code) {
      if (item.node.attrs.some((attribute) => attribute.name !== "data-codex-code")) throw new Error("旧行内代码含未知属性，原文已保留。");
      const delimiter = "`".repeat(Math.max(0, ...Array.from(value.matchAll(/`+/g), (match) => match[0].length)) + 1);
      const padding = value.startsWith("`") || value.endsWith("`") || (value.startsWith(" ") && value.endsWith(" ") && value.trim()) ? " " : "";
      const prefix = delimiter + padding;
      encoded = { text: prefix + value + padding + delimiter, pairs: flat.units.map((unit, index) => ({ ...unit, resultFrom: prefix.length + index, resultTo: prefix.length + index + 1 })) };
      const parsed = parseMarkdown(encoded.text), child = parsed.children?.[0]?.children?.[0];
      if (child?.type !== "inlineCode" || child.value !== value) throw new Error("行内代码无法无损恢复，原文已保留。");
    } else encoded = literalMarkdown(value, flat.units);
    edits.push({ from: item.from, to: item.to, ...encoded });
    carriers.push({ from: item.from, ranges: styleRanges(flat.styles).map((range) => ({ ...range, from: encoded.pairs[range.from].resultFrom, to: encoded.pairs[range.to - 1].resultTo })) });
  }
  const changed = editText(text, edits);
  // 两个紧邻 code 的反引号可能合并为更长定界符；单岛校验不足，必须核对恢复后的整篇可见文字。
  if (visibleSignature(buildModel(decodeOwnedColors(text).text, [])) !== visibleSignature(buildModel(changed.text, []))) throw new Error("旧行内 HTML 恢复将改变可见文字，原文已保留。");
  // editText.map 是“可见文字边界”映射：code 开头会越过反引号，相邻岛的边界还会关联前一岛。
  // 颜色的局部 offset 已包含原生定界符，因此这里必须使用替换片段的真实起点，不能再次套文字边界。
  let shift = 0;
  const ranges: ColorRange[] = [];
  for (let index = 0; index < edits.length; index++) {
    const edit = edits[index], offset = edit.from + shift;
    ranges.push(...carriers[index].ranges.map((range) => ({ ...range, from: range.from + offset, to: range.to + offset })));
    shift += edit.text.length - (edit.to - edit.from);
  }
  return { text: changed.text, count: edits.length, ranges: mergeRanges(ranges), map: (position) => changed.map(position, 1) };
}


/** 重置只定位顶层独立 HTML 注释，代码、YAML 和引用内相同文字不属于颜色存储。 */
export function nativeTextMetadataRecords(text: string): Array<{ from: number; to: number }> {
  const ast = parseMarkdown(text), protectedRanges = markdownProtectedRanges(text);
  return (ast.children ?? []).filter((node) => node.type === "html").flatMap((node) => {
    const { from, to: nodeTo } = position(node), raw = text.slice(from, nodeTo);
    if (!raw.startsWith("<!-- noteglow-text-colors:") || protectedRanges.some((range) => from < range.to && nodeTo > range.from)) return [];
    // 缺少结束符时 HTML 解析器可能吞入后文；重置只移除已确认自有前缀的第一物理行。
    const lineEnd = raw.search(/[\r\n]/), to = from + (lineEnd < 0 ? raw.length : lineEnd);
    const prefix = /(?:\r\n|\n){2}$/.exec(text.slice(0, from));
    return [{ from: from - (prefix?.[0].length ?? 0), to }];
  });
}


/** 失联记录只允许跨过完整顶层引用；不跨其他段落、代码、HTML 或不完整语法。 */
export function nativeTextQuoteGap(text: string, from: number, to: number): boolean {
  if (to <= from || to - from > 200_000) return false;
  const nodes = (parseMarkdown(text).children ?? []).filter((node) => position(node).from < to && position(node).to > from);
  if (!nodes.length || nodes.some((node) => node.type !== "blockquote" || position(node).from < from || position(node).to > to)) return false;
  let cursor = from;
  for (const node of nodes) {
    if (text.slice(cursor, position(node).from).trim()) return false;
    cursor = position(node).to;
  }
  return !text.slice(cursor, to).trim();
}

/** 插入记录前后核对实际 Markdown 树；只忽略自有独立记录，保留列表 spread 等语义字段。 */
export function nativeTextDocumentShape(text: string): string {
  const clean = (node: MdNode): unknown => {
    const { position: _position, children, ...fields } = node;
    return { ...fields, ...(children ? { children: children.filter((child) => !(child.type === "html" && /^<!-- noteglow-text-colors:/.test(child.value ?? ""))).map(clean) } : {}) };
  };
  return JSON.stringify(clean(parseMarkdown(text)));
}


/** 阅读投影复用实体/行内代码解析单元，避免把 Setext 下划线或 &amp; 源码当成可见文字。 */
export function projectNativeMarkdown(text: string, base = 0): { text: string; offsets: number[] } {
  const model = buildModel(text, []), units = model.leaves.filter((leaf) => !leaf.owned).flatMap((leaf) => leaf.units);
  return { text: units.map((unit) => unit.value).join(""), offsets: units.map((unit) => base + unit.from) };
}

/** 斜杠命令仅接管顶层普通文字行，代码、HTML、引用和 Obsidian 扩展保持字面内容。 */
export function isPlainMarkdownLine(text: string, from: number, to: number): boolean {
  // 此处只判断语法上下文。统一换行避开旧颜色投影的 CRLF 限制；实际编辑仍使用原始位置和换行。
  if (text.includes("\r\n")) {
    return isPlainMarkdownLine(text.replace(/\r\n/g, "\n"), text.slice(0, from).replace(/\r\n/g, "\n").length, text.slice(0, to).replace(/\r\n/g, "\n").length);
  }
  const ast = parseMarkdown(text);
  const paragraph = ast.children?.find((node) => node.type === "paragraph" && position(node).from <= from && position(node).to >= to);
  if (!paragraph?.children?.some((node) => node.type === "text" && position(node).from <= from && position(node).to >= to)) return false;
  const model = buildModel(text, []);
  return ![...model.protected, ...model.unknownHtml].some((range) => from < range.to && to > range.from);
}

export interface MarkdownSyntaxRange { from: number; to: number }
export interface MarkdownQuoteLine { from: number; depth: number }
export interface MarkdownQuotePrefix extends MarkdownSyntaxRange { blockFrom: number }
export interface MarkdownInlineLink extends MarkdownSyntaxRange { addressFrom: number; addressTo: number; url: string }
/** 只隐藏 AST 已确认的语法；所有位置仍指向原文，不替换正文、列表标记或代码里的符号。 */
export function cleanMarkdownSyntax(text: string): { ranges: MarkdownSyntaxRange[]; links: MarkdownInlineLink[]; quotes: MarkdownQuotePrefix[]; quoteLines: MarkdownQuoteLine[] } {
  try { return cleanMarkdownSyntaxUnchecked(text); } catch { return { ranges: [], links: [], quotes: [], quoteLines: [] }; }
}
function cleanMarkdownSyntaxUnchecked(text: string): { ranges: MarkdownSyntaxRange[]; links: MarkdownInlineLink[]; quotes: MarkdownQuotePrefix[]; quoteLines: MarkdownQuoteLine[] } {
  if (text.length > MAX_CHARS) return { ranges: [], links: [], quotes: [], quoteLines: [] };
  const model = buildModel(text, []), ast = model.ast;
  const protectedRanges = [...model.protected, ...model.unknownHtml];
  const ranges: MarkdownSyntaxRange[] = [], links: MarkdownInlineLink[] = [], quotes: MarkdownQuotePrefix[] = [];
  const quoteProtectedLines: MarkdownSyntaxRange[] = [];
  const quoteLines = new Map<number, number>();
  // 宿主整体渲染的容器继续由宿主排版，不在其源码行叠加 gutter。
  const quoteDisplayExclusions = [...model.unknownHtml, ...model.protected.filter((range) => range.kind === "公式" && text.startsWith("$$", range.from))];
  const add = (from: number, to: number): void => {
    if (to > from && !protectedRanges.some((range) => from < range.to && to > range.from)) ranges.push({ from, to });
  };
  const visit = (node: MdNode, quoteDepth = 0): void => {
    if (!node.position) { for (const child of node.children ?? []) visit(child, quoteDepth); return; }
    const { from, to } = position(node), raw = text.slice(from, to);
    if (node.type === "html" || protectedRanges.some((range) => from >= range.from && to <= range.to)) return;
    // 列表悬挂缩进由宿主按列表标记测量；不能被普通引用的固定 gutter 覆盖。
    if (node.type === "list") quoteDisplayExclusions.push({ from, to });
    if (node.type === "text") {
      // 仅隐藏已由正文解码单元确认的转义引导符；被转义的星号、反斜杠等仍是用户正文。
      for (const unit of markdownTextUnits(text, node)) {
        if (unit.to - unit.from === 2 && text[unit.from] === "\\" && text[unit.from + 1] === unit.value) add(unit.from, unit.from + 1);
      }
    }
    if (["strong", "emphasis", "delete"].includes(node.type) && node.children?.length) {
      add(from, position(node.children[0]).from); add(position(node.children.at(-1)!).to, to);
    } else if (node.type === "inlineCode") {
      const open = /^`+/.exec(raw)?.[0];
      if (open && raw.endsWith(open) && raw.length > open.length * 2) { add(from, from + open.length); add(to - open.length, to); }
      return;
    } else if (node.type === "heading") {
      const open = /^#{1,6}(?:[ \t]+|$)/.exec(raw);
      if (open) {
        add(from, from + open[0].length);
        const close = /[ \t]+#+[ \t]*$/.exec(raw); if (close) add(from + close.index, to);
      } else {
        const lineStart = raw.lastIndexOf("\n") + 1;
        if (lineStart > 0) {
          let content = lineStart;
          // Setext 的后续物理行保留祖先引用标记，先按 AST 层数越过，不能把 > 当下划线正文。
          for (let depth = 0; depth < quoteDepth; depth++) {
            const prefix = /^ {0,3}>[ \t]?/.exec(raw.slice(content));
            if (!prefix) break;
            content += prefix[0].length;
          }
          if (/^[ \t]*(?:=+|-+)[ \t]*$/.test(raw.slice(content))) add(from + content, to);
        }
      }
    } else if (node.type === "code") {
      // 引用里的完整代码块不可通过单行退层拆开；只保护结构操作，隐藏装饰仍沿用原逻辑。
      quoteProtectedLines.push({ from: text.lastIndexOf("\n", from - 1) + 1, to });
      const open = /^(`{3,}|~{3,})[^\r\n]*(?=\r?\n)/.exec(raw);
      const closeAt = raw.lastIndexOf("\n") + 1, close = raw.slice(closeAt);
      if (open && new RegExp(`^ {0,3}${open[1][0]}{${open[1].length},}[ \\t]*$`).test(close)) {
        add(from, from + open[0].length); add(from + closeAt, to);
      }
      return;
    } else if (node.type === "blockquote") {
      if (/^>[ \t]*\[![^\]]+\]/.test(raw)) quoteDisplayExclusions.push({ from, to });
      let offset = from, firstLine = true;
      for (const line of raw.split("\n")) {
        // 显示深度来自 AST，不随光标或宿主的活动行 widget 改变；代码里的字面 > 不会增加层级。
        const lineFrom = text.lastIndexOf("\n", offset - 1) + 1;
        quoteLines.set(lineFrom, Math.max(quoteLines.get(lineFrom) ?? 0, quoteDepth + 1));
        // 首行 node.from 已在本层 >；后续物理行先越过祖先容器，每层只消费一个 >。
        // 代码正文中的 > 没有 blockquote AST 节点，不能被贪婪前缀正则吞掉。
        let prefixOffset = 0;
        const ancestors = firstLine ? 0 : quoteDepth;
        for (let depth = 0; depth <= ancestors; depth++) {
          const prefix = /^ {0,3}>[ \t]?/.exec(line.slice(prefixOffset));
          if (!prefix) {
            // 懒延续行的实际层级比显式 > 更多，交还宿主，避免一次退掉多层。
            if (!firstLine && quoteDepth > 0) quoteProtectedLines.push({ from: offset, to: offset + line.length });
            break;
          }
          if (depth === ancestors) {
            const start = offset + prefixOffset, end = start + prefix[0].length;
            add(start, end);
            // 保留每一层的精确边界，退格降级不能使用合并后的原子装饰范围。
            if (!protectedRanges.some((range) => start < range.to && end > range.from)) quotes.push({ from: start, to: end, blockFrom: from });
          }
          prefixOffset += prefix[0].length;
        }
        firstLine = false; offset += line.length + 1;
      }
    } else if (node.type === "link" && node.children?.length && raw.startsWith("[")) {
      const innerFrom = position(node.children[0]).from, innerTo = position(node.children.at(-1)!).to;
      const suffix = text.slice(innerTo, to);
      if (suffix.startsWith("](") && suffix.endsWith(")")) {
        let start = innerTo + 2; while (/[ \t\r\n]/.test(text[start] ?? "") && start < to) start++;
        let end = start;
        if (text[start] === "<") {
          // CommonMark 的反斜杠转义可能包含 >；仅未转义结束符属于 destination 边界。
          end = start + 1;
          while (end < to - 1) {
            if (text[end] === "\\" && end + 1 < to - 1) { end += 2; continue; }
            if (text[end++] === ">") break;
          }
        }
        else {
          let depth = 0;
          for (; end < to - 1; end++) {
            const character = text[end];
            if (character === "\\") { end++; continue; }
            if (/\s/.test(character) && depth === 0) break;
            if (character === "(") depth++;
            if (character === ")") { if (!depth) break; depth--; }
          }
        }
        if (end >= start && end <= to - 1) {
          add(from, innerFrom); add(innerTo, to);
          links.push({ from, to, addressFrom: start, addressTo: end, url: String(node.url ?? "") });
        }
      }
    }
    for (const child of node.children ?? []) visit(child, quoteDepth + (node.type === "blockquote" ? 1 : 0));
  };
  visit(ast);
  // 嵌套 emphasis/quote 可能相接或重合，先合并以避免 CM 重复 replace 范围。
  const merged: MarkdownSyntaxRange[] = [];
  for (const range of ranges.sort((a, b) => a.from - b.from || a.to - b.to)) {
    const last = merged.at(-1);
    if (last && range.from <= last.to) last.to = Math.max(last.to, range.to); else merged.push({ ...range });
  }
  return { ranges: merged, links, quotes: quotes.filter((quote) => !quoteProtectedLines.some((range) => quote.from >= range.from && quote.from <= range.to)), quoteLines: [...quoteLines].filter(([from]) => !quoteDisplayExclusions.some((range) => from >= text.lastIndexOf("\n", range.from - 1) + 1 && from <= range.to)).map(([from, depth]) => ({ from, depth })).sort((a, b) => a.from - b.from) };
}

/** 地址是单值，提交时整体校验；用尖括号和百分号编码防止输入逃逸为 Markdown 结构。 */
export function markdownLinkAddress(value: string): string | null {
  const address = value.trim();
  if (!address || address.length > 8192 || /[\u0000-\u001f\u007f<>]/.test(value)) return null;
  return "<" + address.replace(/&/g, "&amp;").replace(/\\/g, "%5C").replace(/ /g, "%20") + ">";
}
