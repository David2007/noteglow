import assert from "node:assert/strict";
import test from "node:test";
import { readCodeDomSelection } from "../src/rendered-code-selection.ts";

// 最小 DOM 节点接口保留真实 Range 的 UTF-16 与 child-index 契约，不模拟业务映射逻辑。
const text = (value) => ({ nodeType: 3, textContent: value, childNodes: [] });
const element = (...children) => ({ nodeType: 1, get textContent() { return children.map((child) => child.textContent).join(""); }, childNodes: children });
const range = (startContainer, startOffset, endContainer, endOffset) => ({ startContainer, startOffset, endContainer, endOffset });

test("DOM selection retains entities, UTF-16, newlines and cross-span offsets", () => {
  const first = text("first\n"), amp = text("&"), tail = text("a 😀\r\n");
  const span = element(amp), code = element(first, span, tail);
  assert.deepEqual(readCodeDomSelection(code, range(amp, 0, amp, 1)), { text: "first\n&a 😀\r\n", from: 6, to: 7 });
  assert.deepEqual(readCodeDomSelection(code, range(first, 3, tail, 4)), { text: "first\n&a 😀\r\n", from: 3, to: 11 });
  assert.deepEqual(readCodeDomSelection(code, range(code, 1, code, 3)), { text: "first\n&a 😀\r\n", from: 6, to: 13 });
  assert.deepEqual(readCodeDomSelection(code, range(span, 0, span, 1)), { text: "first\n&a 😀\r\n", from: 6, to: 7 });
  // 浏览器把反向拖选归一为 start/end；anchor/focus 方向不参与映射。
  assert.deepEqual(readCodeDomSelection(code, { ...range(amp, 0, amp, 1), anchorNode: amp, anchorOffset: 1, focusNode: amp, focusOffset: 0 }), { text: "first\n&a 😀\r\n", from: 6, to: 7 });
});

test("DOM boundaries fail closed for cross-block, collapsed and invalid offsets", () => {
  const leaf = text("abc"), code = element(leaf), outside = text("abc");
  for (const selection of [range(outside, 0, leaf, 2), range(leaf, 0, outside, 2), range(leaf, 1, leaf, 1), range(leaf, 2, leaf, 1), range(leaf, -1, leaf, 2), range(leaf, 0.5, leaf, 2), range(leaf, 0, leaf, 4), range(code, 2, leaf, 3), range(leaf, 0, code, 2)]) assert.equal(readCodeDomSelection(code, selection), null);
  const empty = { nodeType: 3, textContent: null, childNodes: [] };
  assert.equal(readCodeDomSelection(empty, range(empty, 0, empty, 0)), null);
});
