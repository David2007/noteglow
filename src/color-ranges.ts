/** 颜色属于旁路显示数据，范围使用与 CodeMirror 一致的 UTF-16 offset。 */
export type ColorProperty = "foreground" | "background";
export interface ColorRange { from: number; to: number; property: ColorProperty; color: string }
export interface ColoredNote { text: string; ranges: ColorRange[] }
export interface LastColors { foreground: string; background: string }
export interface NoteColorsData { version: 1; notes: Record<string, ColoredNote>; lastColors?: LastColors }

export function normalizeColor(value: string): string | null {
  const color = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(color)) return color;
  if (/^#[0-9a-f]{3}$/.test(color)) return `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`;
  return null;
}

/** 老版本没有选色偏好；两个字段独立降级，不因偏好损坏停用已有笔记颜色。 */
export function parseLastColors(raw: unknown): LastColors {
  const input = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  return {
    foreground: typeof input.foreground === "string" ? normalizeColor(input.foreground) ?? "#c0392b" : "#c0392b",
    background: typeof input.background === "string" ? normalizeColor(input.background) ?? "#fff88f" : "#fff88f"
  };
}

/** 同一属性按最后一次选色覆盖交叠，另一属性保留；清除同时移除两个属性。 */
export function replaceColor(ranges: readonly ColorRange[], from: number, to: number, property?: ColorProperty, color?: string): ColorRange[] {
  const output: ColorRange[] = [];
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from >= to) throw new Error("没有有效的连续选区。");
  if (property && !normalizeColor(color ?? "")) throw new Error("颜色须为 #RGB 或 #RRGGBB。");
  for (const range of ranges) {
    if ((property && range.property !== property) || range.to <= from || range.from >= to) { output.push({ ...range }); continue; }
    if (range.from < from) output.push({ ...range, to: from });
    if (range.to > to) output.push({ ...range, from: to });
  }
  if (property && color) output.push({ from, to, property, color: normalizeColor(color)! });
  return mergeRanges(output);
}

export function mergeRanges(ranges: readonly ColorRange[]): ColorRange[] {
  const result: ColorRange[] = [];
  const sorted = [...ranges].filter(({ from, to }) => from < to).sort((a, b) => a.property.localeCompare(b.property) || a.from - b.from || a.to - b.to);
  for (const item of sorted) {
    const last = result[result.length - 1];
    if (last && last.property === item.property && last.color === item.color && last.to === item.from) last.to = item.to;
    else result.push({ ...item });
  }
  return result;
}

/** CM 变更边界采用向内关联：在范围边缘新增的正文不自动染色，内部新增跟随原范围。 */
export function mapColorRanges(ranges: readonly ColorRange[], mapPos: (position: number, association: number) => number): ColorRange[] {
  return mergeRanges(ranges.map((item) => ({ ...item, from: mapPos(item.from, 1), to: mapPos(item.to, -1) })).filter(({ from, to }) => from < to));
}

/** 外部改动没有 ChangeSet：确定未变的前后缀直接映射，其他范围仅接受唯一原文锚点。 */
export function relocateColorRanges(note: ColoredNote, text: string): ColorRange[] {
  if (note.text === text) return note.ranges.map((range) => ({ ...range }));
  let prefix = 0;
  while (prefix < note.text.length && prefix < text.length && note.text[prefix] === text[prefix]) prefix++;
  let suffix = 0;
  while (suffix < note.text.length - prefix && suffix < text.length - prefix && note.text[note.text.length - 1 - suffix] === text[text.length - 1 - suffix]) suffix++;
  const output: ColorRange[] = [];
  for (const range of note.ranges) {
    if (range.to <= prefix) { output.push({ ...range }); continue; }
    if (range.from >= note.text.length - suffix) {
      const shift = text.length - note.text.length;
      output.push({ ...range, from: range.from + shift, to: range.to + shift });
      continue;
    }
    const quote = note.text.slice(range.from, range.to);
    if (!quote) continue;
    const index = text.indexOf(quote);
    const oldIndex = note.text.indexOf(quote);
    if (oldIndex === range.from && note.text.indexOf(quote, oldIndex + 1) < 0 && index >= 0 && text.indexOf(quote, index + 1) < 0) { output.push({ ...range, from: index, to: index + quote.length }); continue; }
    const left = note.text.slice(Math.max(0, range.from - 32), range.from);
    const right = note.text.slice(range.to, range.to + 32);
    const context = left + quote + right;
    const contextIndex = text.indexOf(context);
    const oldContextIndex = note.text.indexOf(context);
    if (oldContextIndex === range.from - left.length && note.text.indexOf(context, oldContextIndex + 1) < 0 && contextIndex >= 0 && text.indexOf(context, contextIndex + 1) < 0) output.push({ ...range, from: contextIndex + left.length, to: contextIndex + left.length + quote.length });
    // 找不到唯一原文就舍弃显示范围，绝不把旧 offset 套到不相关的新文字。
  }
  return mergeRanges(output);
}

export function parseNoteColors(raw: unknown): NoteColorsData {
  if (!raw || typeof raw !== "object" || !("version" in raw) || raw.version !== 1 || !("notes" in raw) || !raw.notes || typeof raw.notes !== "object" || Array.isArray(raw.notes)) throw new Error("颜色记录格式不正确，已暂停颜色功能以保护现有记录。");
  const notes: Record<string, ColoredNote> = Object.create(null) as Record<string, ColoredNote>;
  for (const [path, candidate] of Object.entries(raw.notes)) {
    if (!candidate || typeof candidate !== "object" || typeof candidate.text !== "string" || !Array.isArray(candidate.ranges) || candidate.ranges.length > 10_000) throw new Error(`颜色记录损坏：${path}`);
    const ranges: ColorRange[] = [];
    for (const item of candidate.ranges) {
      if (!item || typeof item !== "object" || !Number.isInteger(item.from) || !Number.isInteger(item.to) || item.from < 0 || item.to > candidate.text.length || item.from >= item.to || (item.property !== "foreground" && item.property !== "background") || typeof item.color !== "string" || !normalizeColor(item.color)) throw new Error(`颜色范围损坏：${path}`);
      ranges.push({ from: item.from, to: item.to, property: item.property, color: normalizeColor(item.color)! });
    }
    notes[path] = { text: candidate.text, ranges: mergeRanges(ranges) };
  }
  return { version: 1, notes, lastColors: parseLastColors("lastColors" in raw ? raw.lastColors : undefined) };
}

export interface TextProjection { text: string; offsets: number[] }

/** 阅读模式只隐藏确定的 Markdown 语法；随后还要与实际 DOM 全文逐字核对。 */
export function projectMarkdown(source: string, baseOffset = 0): TextProjection {
  const result: TextProjection = { text: "", offsets: [] };
  const push = (value: string, offset: number): void => {
    result.text += value;
    for (let i = 0; i < value.length; i++) result.offsets.push(baseOffset + offset + i);
  };
  const inline = (start: number, end: number): void => {
    let i = start;
    while (i < end) {
      const char = source[i];
      if (char === "\\" && i + 1 < end && /[\\`*_{}\[\]()#+\-.!|>~]/.test(source[i + 1])) { push(source[i + 1], i + 1); i += 2; continue; }
      if (char === "`") {
        let count = 1;
        while (source[i + count] === "`") count++;
        const delimiter = "`".repeat(count);
        const close = source.indexOf(delimiter, i + count);
        if (close >= 0 && close < end) { push(source.slice(i + count, close), i + count); i = close + count; continue; }
      }
      if (source.startsWith("[[", i)) {
        const close = source.indexOf("]]", i + 2);
        if (close >= 0 && close < end) {
          const pipe = source.indexOf("|", i + 2);
          inline(pipe >= 0 && pipe < close ? pipe + 1 : i + 2, close);
          i = close + 2; continue;
        }
      }
      const isImage = char === "!" && source[i + 1] === "[";
      if (char === "[" || isImage) {
        const open = isImage ? i + 1 : i;
        const close = source.indexOf("](", open + 1);
        if (close >= 0 && close < end) {
          let depth = 1;
          let tail = close + 2;
          while (tail < end && depth) {
            if (source[tail] === "\\") { tail += 2; continue; }
            if (source[tail] === "(") depth++;
            if (source[tail] === ")") depth--;
            tail++;
          }
          if (!depth) { if (!isImage) inline(open + 1, close); i = tail; continue; }
        }
      }
      if (char === "*" || char === "_" || char === "~" || char === "=") {
        let count = 1;
        while (i + count < end && source[i + count] === char) count++;
        // 单个 ~、= 是正文；内嵌标识符的下划线同样保留。
        const identifierUnderscore = char === "_" && /[\p{L}\p{N}]/u.test(source[i - 1] ?? "") && /[\p{L}\p{N}]/u.test(source[i + count] ?? "");
        if (!identifierUnderscore && (char === "*" || char === "_" || count >= 2)) { i += count; continue; }
      }
      push(char, i);
      i++;
    }
  };
  let cursor = 0;
  let fence: { char: string; count: number } | null = null;
  for (const line of source.split("\n")) {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch && (!fence || (fenceMatch[1][0] === fence.char && fenceMatch[1].length >= fence.count))) {
      fence = fence ? null : { char: fenceMatch[1][0], count: fenceMatch[1].length };
      cursor += line.length + 1; continue;
    }
    if (fence) push(line, cursor);
    else {
      let prefix = 0;
      const quote = /^(?:\s{0,3}>\s*)+/.exec(line);
      if (quote) prefix = quote[0].length;
      const block = /^(?:\s{0,3}#{1,6}\s+|\s*(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)/.exec(line.slice(prefix));
      if (block) prefix += block[0].length;
      const suffix = /^\s{0,3}#{1,6}\s/.test(line) ? /\s+#+\s*$/.exec(line)?.[0].length ?? 0 : 0;
      inline(cursor + prefix, cursor + line.length - suffix);
    }
    if (cursor + line.length < source.length) push("\n", cursor + line.length);
    cursor += line.length + 1;
  }
  return result;
}

/** 仅接受整个 section 非空白文本精确一致的投影，不做局部模糊子串着色。 */
export function alignRenderedText(projection: TextProjection, rendered: string): Array<number | null> | null {
  const sourceOffsets: number[] = [];
  const sourceIndices: number[] = [];
  let normalized = "";
  for (let i = 0; i < projection.text.length; i++) if (!/\s/.test(projection.text[i])) { normalized += projection.text[i]; sourceOffsets.push(projection.offsets[i]); sourceIndices.push(i); }
  const plain = rendered.replace(/\s/g, "");
  if (plain !== normalized) return null;
  let cursor = 0;
  const alignment = Array.from({ length: rendered.length }, (_, i) => /\s/.test(rendered[i]) ? null : sourceOffsets[cursor++] ?? null);
  // 非空白字符一致后，只映射完全相同的空白段；不把渲染器新增/折叠的空白猜成源码。
  let previousSource = -1;
  let previousRendered = -1;
  cursor = 0;
  for (let i = 0; i <= rendered.length; i++) {
    if (i < rendered.length && /\s/.test(rendered[i])) continue;
    const nextSource = i === rendered.length ? projection.text.length : sourceIndices[cursor++];
    const sourceGap = projection.text.slice(previousSource + 1, nextSource);
    const renderedGap = rendered.slice(previousRendered + 1, i);
    if (sourceGap === renderedGap) for (let j = 0; j < renderedGap.length; j++) alignment[previousRendered + 1 + j] = projection.offsets[previousSource + 1 + j];
    previousSource = nextSource;
    previousRendered = i;
  }
  return alignment;
}
