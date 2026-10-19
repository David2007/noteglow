/** DOM Range 使用 UTF-16；这里保留实体解码后的全部换行，不使用会折叠空白的 innerText。 */
export function readCodeDomSelection(code: Node, range: Pick<Range, "startContainer" | "startOffset" | "endContainer" | "endOffset">): { text: string; from: number; to: number } | null {
  const offset = (target: Node, at: number): number | null => {
    if (!Number.isInteger(at) || at < 0) return null;
    let cursor = 0;
    let result: number | null = null;
    const visit = (node: Node): void => {
      if (node === target) {
        if (node.nodeType === 3) { if (at <= (node.textContent ?? "").length) result = cursor + at; }
        else if (at <= node.childNodes.length) result = cursor + Array.from(node.childNodes).slice(0, at).reduce((sum, child) => sum + (child.textContent ?? "").length, 0);
      }
      if (node.nodeType === 3) cursor += (node.textContent ?? "").length;
      else for (const child of Array.from(node.childNodes)) visit(child);
    };
    visit(code);
    return result;
  };
  const from = offset(range.startContainer, range.startOffset), to = offset(range.endContainer, range.endOffset);
  if (from === null || to === null || from >= to) return null;
  return { text: code.textContent ?? "", from, to };
}
