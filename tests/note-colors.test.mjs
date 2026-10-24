import assert from 'node:assert/strict';
import test from 'node:test';
import { Module, createRequire } from 'node:module';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

// 保留生产注册和渲染流程，仅替换 Obsidian 桌面宿主提供的接口。
const bundled = await build({
  stdin: { contents: "export { registerNoteColors, waitForNativeTableSave } from './src/note-colors.ts'; export { applyNativeCodeColor } from './src/native-code-colors.ts'; export { notices, TFile } from 'obsidian'; export { ViewPlugin } from '@codemirror/view'; export { applyNativeTextColor } from './src/native-text-colors.ts';", resolveDir: process.cwd() },
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
const { registerNoteColors, waitForNativeTableSave, applyNativeCodeColor, applyNativeTextColor, notices, TFile, ViewPlugin } = module.exports;

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
  let editorPlugin;
  const fromClass=ViewPlugin.fromClass;
  ViewPlugin.fromClass=function(cls,spec){editorPlugin=cls;return fromClass.call(this,cls,spec);};
  try { await registerNoteColors(plugin); } finally { ViewPlugin.fromClass=fromClass; }
  const el = window.document.createElement('div'); el.innerHTML = '<pre><code>hello\n</code></pre>'; window.document.body.append(el);
  const code = el.querySelector('code');
  await processor(el, { sourcePath: file.path, getSectionInfo: element => sectionInfo(element, code), addChild: child => { children.push(child); child.onload(); } });
  return { el, code, attachEditor(dom,text,anchor=0){
    const state=value=>({doc:{toString:()=>value},field:()=>({file})});let instance;
    const view={dom,state:state(text),posAtDOM:()=>anchor,dispatch(spec){instance.update({view,state:view.state,startState:view.state,docChanged:false,selectionSet:false,transactions:[{effects:Array.isArray(spec.effects)?spec.effects:[spec.effects],isUserEvent:()=>false}]});}};
    instance=new editorPlugin(view);
    instance.replaceDocument=value=>{const startState=view.state;view.state=state(value);instance.update({view,state:view.state,startState,docChanged:true,selectionSet:false,changes:{mapPos:position=>position},transactions:[]});};
    cleanups.push(()=>instance.destroy());return instance;
  }, process:async element=>processor(element,{sourcePath:file.path,getSectionInfo:()=>null,addChild:child=>{children.push(child);child.onload();}}), refresh: () => children.forEach(child => child.refresh()), flush: () => { const pending = [...timers.values()]; timers.clear(); pending.forEach(callback => callback()); } };
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


test('Live Preview table cell without section paints only the anchored cell and active editor uses decorations',async t=>{
 const source='| same | same |\n| --- | --- |\n| same | `target` |',from=source.indexOf('target');
 const text=applyNativeTextColor(source,from,from+6,'background','#fff88f').text;
 const env=await setup(t,text,()=>null);
 env.el.innerHTML='<div class="cm-table-widget"><table class="table-editor"><thead><tr><th><div>same</div></th><th><div>same</div></th></tr></thead><tbody><tr><td><div>same</div></td><td><div class="table-cell-wrapper"><code>target</code></div></td></tr></tbody></table></div>';
 env.attachEditor(env.el,text);
 const cell=env.el.querySelector('.table-cell-wrapper');await env.process(cell);
 assert.equal(cell.dataset.codexNoteColorStatus,'applied');assert.equal(cell.querySelector('span').textContent,'target');
 assert.equal(cell.querySelector('span').style.getPropertyValue('--codex-note-background'),'#fff88f');
 const active=env.el.ownerDocument.createElement('div');cell.parentElement.append(active);active.textContent='`target`';
 const editor=env.attachEditor(active,'`target`');
 const ranges=[];editor.decorations.between(0,8,(from,to,decoration)=>ranges.push([from,to,decoration.spec.attributes.style]));
 assert.deepEqual(ranges,[[1,7,'--codex-note-background:#fff88f']]);
 assert.equal(active.textContent,'`target`');assert.equal(active.children.length,0);
});

test('Live Preview table binding rejects wrong anchor and mismatched cell DOM',async t=>{
 const source='before\n\n| one | two |\n| --- | --- |\n| same | target |',from=source.indexOf('target'),text=applyNativeTextColor(source,from,from+6,'background','#fff88f').text;
 const env=await setup(t,text,()=>null);
 env.el.innerHTML='<div class="cm-table-widget"><table class="table-editor"><tr><th>one</th><th>two</th></tr><tr><td>same</td><td><div class="table-cell-wrapper">target</div></td></tr></table></div>';
 const instance=env.attachEditor(env.el,text,0),cell=env.el.querySelector('.table-cell-wrapper');await env.process(cell);
 assert.equal(cell.querySelector('span'),null);assert.equal(cell.dataset.codexNoteColorStatus,'no-source-section');
 instance.destroy();env.attachEditor(env.el,text,source.indexOf('| one'));cell.textContent='different';env.refresh();
 assert.ok(cell.dataset.codexNoteColorStatus.startsWith('projection-mismatch'));assert.equal(cell.querySelector('span'),null);
});


test('active table decorations refresh and clear when only main-document metadata changes',async t=>{
 const source='| one | two |\n| --- | --- |\n| same | `target` |',from=source.indexOf('target');
 const initial=applyNativeTextColor(source,from,from+6,'background','#fff88f').text;
 const env=await setup(t,initial,()=>null);
 env.el.innerHTML='<div class="cm-table-widget"><table class="table-editor"><tr><th>one</th><th>two</th></tr><tr><td>same</td><td><div class="table-cell-wrapper"></div></td></tr></table></div>';
 const main=env.attachEditor(env.el,initial),active=env.el.querySelector('.table-cell-wrapper');active.textContent='`target`';
 const cell=env.attachEditor(active,'`target`'),marks=()=>{const ranges=[];cell.decorations.between(0,8,(from,to,decoration)=>ranges.push([from,to,decoration.spec.attributes.style]));return ranges;};
 env.flush();assert.deepEqual(marks(),[[1,7,'--codex-note-background:#fff88f']]);
 main.replaceDocument(applyNativeTextColor(initial,from,from+6,'background','#cde6ff').text);env.flush();
 assert.deepEqual(marks(),[[1,7,'--codex-note-background:#cde6ff']]);
 main.replaceDocument(source);env.flush();assert.deepEqual(marks(),[]);
 assert.equal(active.textContent,'`target`');assert.equal(active.children.length,0);
});


test('table save readback waits for the host queued save and stops after exact disk confirmation',async()=>{
 const before='| a | b |\n| --- | --- |\n| text | other |',expected=before.replace('text','**text**'),normalized=expected.replaceAll('| ','|   ');
 let disk=before,saves=0,waits=0;
 const saved=await waitForNativeTableSave(expected,()=>normalized,async()=>{if(++saves===2)disk=normalized;},async()=>disk,async()=>{waits++;});
 assert.equal(saved,normalized);assert.equal(saves,2);assert.equal(waits,2);
});

test('table save wait rejects concurrent content changes and never retries ordinary paragraphs',async()=>{
 const expected='| a | b |\n| --- | --- |\n| **text** | other |';
 let current=expected,saves=0;
 const saved=await waitForNativeTableSave(expected,()=>current,async()=>{saves++;},async()=>'',async()=>{current=expected+'\nnew user text';});
 assert.equal(saved,'');assert.equal(saves,0);assert.equal(current,expected+'\nnew user text');
 await waitForNativeTableSave('paragraph',()=> 'paragraph',async()=>{saves++;},async()=>'',async()=>assert.fail('non-table must not wait'));
 assert.equal(saves,0);
});

test('table save wait is bounded and does not retry after view closes',async()=>{
 const expected='| a | b |\n| --- | --- |';let saves=0,waits=0;
 const saved=await waitForNativeTableSave(expected,()=>expected,async()=>{saves++;},async()=>'',async()=>{waits++;});
 assert.equal(saved,'');assert.equal(saves,20);assert.equal(waits,20);
 await waitForNativeTableSave(expected,()=>null,async()=>assert.fail('closed view must not save'),async()=>'',async()=>assert.fail('closed view must not wait'));
});
