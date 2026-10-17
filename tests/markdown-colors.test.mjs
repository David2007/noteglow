import assert from "node:assert/strict";
import test from "node:test";
import { parseFragment } from "parse5";
import { fromMarkdown } from "mdast-util-from-markdown";
import { applyMarkdownColor, formatMarkdownSelection, migrateMarkdownColors } from "../src/markdown-colors.ts";

const bg = "#fff88f", fg = "#c0392b";
function nodes(source) {
  const result = [];
  const visit = (node) => { result.push(node); for (const child of node.childNodes ?? []) visit(child); };
  visit(parseFragment(source, { sourceCodeLocationInfo: true }));
  return result;
}
function attr(node, name) { return node?.attrs?.find((item) => item.name === name)?.value; }
function content(node) { return node.nodeName === "#text" ? node.value : (node.childNodes ?? []).map(content).join(""); }
function codeText(source) {
  const code = nodes(source).find((node) => node.tagName === "code" && (attr(node, "data-codex-code") === "1" || attr(node.parentNode, "data-codex-code") === "1"));
  assert.ok(code, "generated portable code exists");
  return content(code);
}
function paintedText(source) { return nodes(source).filter((node) => node.tagName === "span" && attr(node, "data-codex-color") === "1").map((node) => ({ text: content(node), style: attr(node, "style") })); }
function noNestedSpans(source) {
  for (const node of nodes(source).filter((item) => attr(item, "data-codex-color") === "1")) {
    let parent = node.parentNode;
    while (parent) { assert.notEqual(attr(parent, "data-codex-color"), "1"); parent = parent.parentNode; }
  }
}
function select(source, value) { const from = source.indexOf(value); assert.ok(from >= 0); return [from, from + value.length]; }
function paint(source, value, property = "background", color = bg) { return applyMarkdownColor(source, ...select(source, value), property, color); }

// public contracts: source containers and inline tokens survive; only text leaves become owned HTML.
test("list and bold markers stay outside portable color spans", () => {
  const source = "1. **重要** 保留。\n2. 下一项。\n";
  const result = paint(source, "重要");
  assert.equal(result.text, '1. **<span data-codex-color="1" style="background-color:#fff88f">重要</span>** 保留。\n2. 下一项。\n');
  assert.equal(fromMarkdown(result.text).children[0].type, "list");
  for (const node of nodes(result.text)) {
    const location = node.sourceCodeLocation;
    if (!location || !node.tagName) continue;
    for (const offset of [result.from, result.to]) {
      if (location.startTag) assert.ok(offset <= location.startTag.startOffset || offset >= location.startTag.endOffset);
      if (location.endTag) assert.ok(offset <= location.endTag.startOffset || offset >= location.endTag.endOffset);
    }
  }
});

test("whole-line latest background replaces partial background without nesting", () => {
  let source = paint("alpha beta", "alpha", "foreground", fg).text;
  source = paint(source, "beta", "background", "#ffd6d6").text;
  const result = applyMarkdownColor(source, 0, source.length, "background", "#cde6ff");
  noNestedSpans(result.text);
  const parts = paintedText(result.text);
  assert.equal(parts.map((part) => part.text).join(""), "alpha beta");
  assert.ok(parts.every((part) => part.style.includes("background-color:#cde6ff")));
  assert.ok(parts.find((part) => part.text === "alpha").style.includes(`color:${fg}`));
  assert.doesNotMatch(result.text, /#ffd6d6/);
});

test("same color is idempotent and clearing partial selection keeps neighboring colors", () => {
  const first = paint("abc", "abc");
  const again = applyMarkdownColor(first.text, 0, first.text.length, "background", bg);
  assert.equal(again.text, first.text);
  const at = again.text.lastIndexOf("b");
  const cleared = applyMarkdownColor(again.text, at, at + 1);
  assert.deepEqual(paintedText(cleared.text).map((part) => part.text), ["a", "c"]);
  assert.ok(content(parseFragment(cleared.text)).includes("abc"));
  const all = applyMarkdownColor(cleared.text, 0, cleared.text.length);
  assert.equal(all.text, "abc");
});

test("link destination and italic delimiters survive cross-inline coloring", () => {
  const source = "1. *斜体* 与 [官方说明](https://obsidian.md/help/html?q=1&v=2) 保留。\n";
  const result = applyMarkdownColor(source, 0, source.length, "foreground", fg);
  assert.match(result.text, /\*<span[^>]+>斜体<\/span>\*/);
  assert.ok(result.text.includes("](https://obsidian.md/help/html?q=1&v=2)"));
  assert.match(result.text, /^1\. /);
  noNestedSpans(result.text);
});

test("task lists and strike markers are source-preserved during coloring", () => {
  const source = "- [x] ~~done~~ and **bold**\n- [ ] todo\n";
  const result = applyMarkdownColor(source, 0, source.length, "background", bg);
  assert.match(result.text, /^- \[x\] ~~/);
  assert.ok(result.text.includes("\n- [ ] "));
  assert.match(result.text, /~~<span[^>]*>done<\/span>~~/);
});

test("plain entities and emoji preserve logical characters and cannot be split", () => {
  const source = "A &amp; B 😀";
  const result = applyMarkdownColor(source, 0, source.length, "background", bg);
  assert.deepEqual(paintedText(result.text).map((part) => part.text).join(""), "A & B 😀");
  assert.throws(() => applyMarkdownColor(source, 3, 5, "background", bg), /实体|转义/);
  const emoji = source.indexOf("😀");
  assert.throws(() => applyMarkdownColor(source, emoji + 1, emoji + 2, "background", bg), /emoji/);
});

test("literal escaped Markdown punctuation stays literal after coloring and clear", () => {
  const source = "\\*literal\\* 与 user_tab";
  const colored = applyMarkdownColor(source, 0, source.length, "foreground", fg);
  assert.equal(paintedText(colored.text).map((part) => part.text).join(""), "*literal* 与 user_tab");
  const cleared = applyMarkdownColor(colored.text, 0, colored.text.length);
  const tree = fromMarkdown(cleared.text);
  assert.equal(tree.children[0].children[0].type, "text");
  assert.equal(tree.children[0].children[0].value, "*literal* 与 user_tab");
});

test("color then bold puts delimiters outside span and supports exact toggle off", () => {
  const colored = paint("first", "first").text;
  const bold = formatMarkdownSelection(colored, ...select(colored, "first"), "bold");
  assert.match(bold.text, /^\*\*<span[^>]+>first<\/span>\*\*$/);
  const plain = formatMarkdownSelection(bold.text, ...select(bold.text, "first"), "bold");
  assert.equal(plain.text, colored);
});

test("color then italic preserves list and visible text", () => {
  const colored = paint("1. word\n2. next\n", "word").text;
  const italic = formatMarkdownSelection(colored, ...select(colored, "word"), "italic");
  assert.match(italic.text, /^1\. \*<span[^>]*>word<\/span>\*\n2\. next\n$/);
});

test("colored text toggles code on and off without interpreting code stars", () => {
  const colored = paint("productPriceData", "productPriceData").text;
  const code = formatMarkdownSelection(colored, ...select(colored, "productPriceData"), "code");
  assert.match(code.text, /^<code data-codex-code="1">/);
  assert.equal(codeText(code.text), "productPriceData");
  const plain = formatMarkdownSelection(code.text, ...select(code.text, "productPriceData"), "code");
  assert.equal(plain.text, colored);
  assert.throws(() => formatMarkdownSelection("`**literal**`", 1, 12, "bold"), /行内代码/);
});

test("inline code angle brackets, literal entity spelling and backticks remain exact", () => {
  const source = "before ``a < b &amp; ` 😀`` after";
  const result = paint(source, "a < b &amp; ` 😀");
  assert.equal(codeText(result.text), "a < b &amp; ` 😀");
  assert.ok(result.text.startsWith("before "));
  assert.ok(result.text.endsWith(" after"));
});

test("fenced code becomes one physical HTML line with all original code text", () => {
  const code = 'if x < 1 && y > 0 {\n  println("&amp; 😀")\n\n}\n';
  const source = "```go\n" + code + "```\n\nuntouched\n";
  const result = paint(source, "println");
  assert.equal(codeText(result.text), code);
  assert.match(result.text, /^<pre data-codex-code="1" style="white-space:pre;overflow-x:auto">/);
  assert.match(result.text, /display:block;white-space:pre;padding:0;background:transparent;font-family:monospace/);
  assert.equal(nodes(result.text).find((node) => node.tagName === "code").attrs.some((item) => item.name === "class"), false);
  assert.equal(attr(nodes(result.text).find((node) => node.tagName === "code"), "data-codex-lang"), "go");
  assert.ok(result.text.includes("&#10;&#10;"));
  assert.equal(result.text.split("\n")[1], "");
  assert.ok(result.text.endsWith("\n\nuntouched\n"));
});

test("legacy language classes normalize away while untouched native fences stay exact", () => {
  const first = paint("```go\nx < 1\n```\n\nbody", "x").text;
  const old = first.replace('data-codex-lang="go"', 'class="language-go" data-codex-lang="go"');
  const untouched = "\n\n```js\nuntouched()\n```\n";
  const result = paint(old + untouched, "body");
  assert.ok(!result.text.includes('class="language-go"'));
  assert.equal(codeText(result.text), "x < 1\n");
  assert.ok(result.text.endsWith(untouched));
});

test("CRLF, code empty lines and last newline survive HTML entity round trip", () => {
  const code = 'if x < 1 {\r\n  println("& 😀")\r\n\r\n}\r\n';
  const result = paint("```go\r\n" + code + "```\r\n", "println");
  assert.equal(codeText(result.text), code);
  assert.match(result.text, /&#13;&#10;/);
  assert.ok(result.text.endsWith("\r\n"));
});

test("nested list and blockquote code keep outer containers", () => {
  for (const source of ["1. item\n\n   ```go\n   x < 1\n   ```\n\n2. next\n", "> ```go\n> x < 1\n> ```\n"]) {
    const result = paint(source, "x < 1");
    assert.equal(codeText(result.text), "x < 1\n");
    if (source.startsWith("1.")) { assert.match(result.text, /^1\. item\n\n   <pre/); assert.ok(result.text.endsWith("\n\n2. next\n")); }
    else assert.match(result.text, /^> <pre/);
  }
});

test("second code coloring and clear preserve code container without nested spans", () => {
  const first = paint("```go\nx < 1\n```\n", "x").text;
  const second = paint(first, "x", "foreground", fg).text;
  assert.equal(codeText(second), "x < 1\n");
  noNestedSpans(second);
  const cleared = applyMarkdownColor(second, 0, second.length);
  assert.equal(codeText(cleared.text), "x < 1\n");
  assert.equal(paintedText(cleared.text).length, 0);
  assert.match(cleared.text, /^<pre data-codex-code/);
});

test("migration maps all original offsets once including code and leaves untouched code unchanged", () => {
  const source = "1. **first** and second\n\n```go\nx < 1\n```\n\n```js\nuntouched()\n```\n";
  const first = source.indexOf("first"), second = source.indexOf("second"), code = source.indexOf("x < 1");
  const result = migrateMarkdownColors(source, [{ from: first, to: first + 5, property: "background", color: bg }, { from: second, to: second + 6, property: "foreground", color: fg }, { from: code, to: code + 5, property: "background", color: bg }]);
  assert.match(result.text, /1\. \*\*<span[^>]*>first<\/span>\*\*/);
  assert.equal(codeText(result.text), "x < 1\n");
  assert.ok(result.text.endsWith("```js\nuntouched()\n```\n"));
  assert.ok(paintedText(result.text).some((part) => part.text === "second" && part.style === `color:${fg}`));
  assert.deepEqual(migrateMarkdownColors(source, []), { text: source, from: 0, to: 0 });
});

test("migration rejects invalid ranges or unsupported user HTML without partial output", () => {
  assert.throws(() => migrateMarkdownColors("abc", [{ from: -1, to: 2, property: "background", color: bg }]), /选区/);
  const source = '<span style="color:red">word</span>';
  assert.throws(() => paint(source, "word"), /非插件|未知 HTML/);
  assert.throws(() => migrateMarkdownColors(source, [{ from: 0, to: source.length, property: "background", color: bg }]), /非插件|未知 HTML/);
});

test("malformed owned HTML, tag-interior selections and unclosed fences fail closed", () => {
  assert.throws(() => paint('<span data-codex-color="1" style="color:#c0392b">word', "word"), /标签/);
  const source = paint("word", "word").text;
  const at = source.indexOf("background-color");
  assert.throws(() => applyMarkdownColor(source, at + 2, source.indexOf("word") + 4, "foreground", fg), /HTML 标签/);
  assert.throws(() => paint("```go\nx < 1\n", "x"), /围栏/);
  assert.throws(() => applyMarkdownColor("word", 0, 4, "background", "url(x)"), /颜色/);
});

test("unsupported Obsidian math, wiki, comments and highlights reject only overlapping selections", () => {
  for (const fragment of ["$x+y$", "$$x+y$$", "[[target|alias]]", "%%hidden text%%", "==highlight=="]) {
    const source = "safe before " + fragment + " safe after";
    const start = source.indexOf(fragment);
    assert.throws(() => applyMarkdownColor(source, start + 2, start + fragment.length - 1, "background", bg), /扩展语法|公式|双链|注释|高亮/);
    const result = paint(source, "safe before");
    assert.ok(result.text.includes(fragment));
  }
  const literal = "```text\n$x+y$ [[target]] %%comment%% ==word==\n```\n";
  assert.equal(codeText(paint(literal, "$x+y$").text), "$x+y$ [[target]] %%comment%% ==word==\n");
});

test("indented code keeps its real terminal newline when converted to HTML", () => {
  const source = "    first < 1\n    second & 2\n\nafter\n";
  const result = paint(source, "first");
  assert.equal(codeText(result.text), "first < 1\nsecond & 2\n");
  assert.ok(result.text.endsWith("\n\nafter\n"));
});

test("YAML frontmatter is protected without blocking ordinary Setext headings or later prose", () => {
  for (const source of ["---\ntitle: Foo\n---\n正文", "\uFEFF---\r\ntitle: Foo\r\n...\r\n正文", "---\ntitle: Foo"]) {
    assert.throws(() => paint(source, "Foo"), /YAML frontmatter/);
    assert.throws(() => formatMarkdownSelection(source, ...select(source, "Foo"), "bold"), /YAML frontmatter/);
    if (source.includes("正文")) assert.ok(paint(source, "正文").text.startsWith(source.slice(0, source.indexOf("正文"))));
  }
  assert.ok(paint("Heading\n---\n", "Heading").text.endsWith("\n---\n"));
  assert.ok(paint("prose\n\n---\n\n正文", "prose").text.includes("\n\n---\n\n正文"));
});

test("returned selections support color, bold, italic and clear without reselecting HTML tags", () => {
  let result = paint("背景再加粗", "背景再加粗");
  assert.equal(result.text.slice(result.from, result.to), "背景再加粗");
  result = formatMarkdownSelection(result.text, result.from, result.to, "bold");
  assert.equal(result.text.slice(result.from, result.to), "背景再加粗");
  result = formatMarkdownSelection(result.text, result.from, result.to, "italic");
  assert.equal(result.text.slice(result.from, result.to), "背景再加粗");
  result = applyMarkdownColor(result.text, result.from, result.to);
  assert.equal(result.text, "***背景再加粗***");
  assert.equal(result.text.slice(result.from, result.to), "背景再加粗");
});
