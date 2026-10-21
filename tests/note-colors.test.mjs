import assert from 'node:assert/strict';
import test from 'node:test';
import { Module, createRequire } from 'node:module';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

// 保留生产注册和渲染流程，仅替换 Obsidian 桌面宿主提供的接口。
const bundled = await build({
  stdin: { contents: "export { registerNoteColors } from './src/note-colors.ts'; export { applyNativeCodeColor } from './src/native-code-colors.ts'; export { notices, TFile } from 'obsidian';", resolveDir: process.cwd() },
  bundle: true, write: false, format: 'cjs', platform: 'node',
  plugins: [{ name: 'obsidian-host', setup(builder) {
    builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'test-host' }));
    builder.onLoad({ filter: /.*/, namespace: 'test-host' }, () => ({ contents: `
      export const notices = [], editorInfoField = {}, editorLivePreviewField = {};
      export class Notice { constructor(message) { notices.push(message); } }
      export class MarkdownRenderChild { constructor(el) { this.containerEl = el; } unload() { this.onunload(); } }
      export class MarkdownView {} export class Plugin {} export class TFile {}
      export const normalizePath = path => path;
    ` }));
  } }]
});
const module = new Module(import.meta.filename);
module.require = createRequire(import.meta.url);
module._compile(bundled.outputFiles[0].text, import.meta.filename);
const { registerNoteColors, applyNativeCodeColor, notices, TFile } = module.exports;

async function setup(t, source, sectionInfo, legacy) {
  const window = new Window(), children = [], cleanups = [], timers = new Map();
  let nextTimer = 0, processor;
  const originals = new Map();
  const globals = { window, document: window.document, Text: window.Text, NodeFilter: window.NodeFilter, MutationObserver: window.MutationObserver,
    setTimeout: callback => { timers.set(++nextTimer, callback); return nextTimer; }, clearTimeout: id => timers.delete(id) };
  for (const [key, value] of Object.entries(globals)) { originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }); }
  notices.length = 0;
  const file = new TFile(); file.path = 'note.md';
  const plugin = {
    manifest: { id: 'codex-notes' },
    app: { vault: { configDir: '.obsidian', adapter: { exists: async () => Boolean(legacy), read: async () => JSON.stringify({ version: 1, notes: { 'note.md': legacy } }) }, getAbstractFileByPath: () => file, cachedRead: async () => source, on: () => {} }, workspace: { getLeavesOfType: () => [], on: () => {} } },
    register: callback => cleanups.push(callback), registerEvent() {}, registerDomEvent() {}, registerEditorExtension() {}, addCommand() {}, registerMarkdownPostProcessor: callback => { processor = callback; }
  };
  t.after(() => { cleanups.forEach(callback => callback()); for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } window.happyDOM.abort(); });
  await registerNoteColors(plugin);
  const el = window.document.createElement('div'); el.innerHTML = '<pre><code>hello\n</code></pre>'; window.document.body.append(el);
  const code = el.querySelector('code');
  await processor(el, { sourcePath: file.path, getSectionInfo: element => sectionInfo(element, code), addChild: child => { children.push(child); child.onload(); } });
  return { el, code, refresh: () => children.forEach(child => child.refresh()), flush: () => { const pending = [...timers.values()]; timers.clear(); pending.forEach(callback => callback()); } };
}
const original = '```js\nhello\n```\n';
const colored = applyNativeCodeColor(original, original.indexOf('hello'), original.indexOf('hello') + 5, 'background', '#fff88f').text;

test('successful native code paint remains independently observable when outer section is absent', async t => {
  const env = await setup(t, colored, (element, code) => element === code ? { text: colored, lineStart: 0, lineEnd: 2 } : null, { text: colored, ranges: [{ from: 6, to: 11, property: 'foreground', color: '#c0392b' }] });
  assert.equal(env.el.dataset.codexNoteColorStatus, 'no-source-section');
  assert.equal(env.code.dataset.codexNoteCodeColorStatus, 'applied');
  assert.equal(env.code.querySelector('[data-codex-note-color="native"]').textContent, 'hello');
  assert.equal(env.code.querySelector('span').style.getPropertyValue('--codex-note-background'), '#fff88f');
  env.flush(); env.refresh(); env.flush();
  assert.equal(env.code.textContent, 'hello\n');
  assert.equal(env.code.querySelectorAll('[data-codex-note-color="native"]').length, 1);
  assert.deepEqual(notices, []);
});

test('unmapped background renders stay silent and do not copy note colors into unrelated content', async t => {
  const env = await setup(t, colored, () => null, { text: colored, ranges: [{ from: 6, to: 11, property: 'foreground', color: '#c0392b' }] });
  for (let i = 0; i < 5; i++) { env.refresh(); env.flush(); }
  assert.equal(env.code.dataset.codexNoteCodeColorStatus, 'no-source-section');
  assert.equal(env.code.querySelector('span'), null);
  assert.equal(env.code.textContent, 'hello\n');
  assert.deepEqual(notices, []);
});

for (const [name, source, info, expected] of [
  ['source snapshot mismatch', colored, { text: original, lineStart: 0, lineEnd: 2 }, 'source-snapshot-mismatch'],
  ['wrong line', colored, { text: colored, lineStart: 1, lineEnd: 2 }, 'no-matching-block'],
  ['stale saved colors', colored.replace('hello', 'world'), null, 'stale'],
  ['different rendered text', applyNativeCodeColor(original.replace('hello', 'world'), 6, 11, 'background', '#fff88f').text, null, 'rendered-text-mismatch']
]) test(`native colors fail closed on ${name}`, async t => {
  const env = await setup(t, source, () => info ?? { text: source, lineStart: 0, lineEnd: 2 });
  assert.equal(env.code.dataset.codexNoteCodeColorStatus, expected);
  assert.equal(env.code.querySelector('span'), null);
  assert.equal(env.code.textContent, 'hello\n');
  env.flush(); assert.deepEqual(notices, []);
});
