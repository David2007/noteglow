import assert from 'node:assert/strict';
import test from 'node:test';
import { Window } from 'happy-dom';
import { build } from 'esbuild';

// Obsidian 由桌面宿主提供；仅替换宿主类标识，目录注册与真实 DOM 交互保留生产实现。
const bundled = await build({
  stdin: {contents: "export { registerNoteOutline } from './src/note-outline.ts'; export { MarkdownView } from 'obsidian';", resolveDir: process.cwd()},
  bundle:true, write:false, format:'esm', platform:'node',
  plugins:[{name:'obsidian-host', setup(builder) {
    builder.onResolve({filter:/^obsidian$/}, () => ({path:'obsidian', namespace:'test-host'}));
    builder.onLoad({filter:/.*/, namespace:'test-host'}, () => ({contents:'export class MarkdownView {}'}));
  }}]
});
const { registerNoteOutline, MarkdownView } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
function setup() {
  const window = new Window(); const handlers = new Map(), cleanups = [], timers = new Map();
  let nextTimer = 0, ready, views = [];
  window.setTimeout = callback => {timers.set(++nextTimer, callback); return nextTimer;};
  window.clearTimeout = id => timers.delete(id);
  const on = (name, callback) => {handlers.set(name, callback); return name;};
  const cache = new Map();
  const plugin = {app:{workspace:{on, onLayoutReady:callback=>{ready=callback;}, getLeavesOfType:()=>views.map(view=>({view}))}, metadataCache:{on,getFileCache:file=>cache.get(file)}}, registerEvent:()=>{},register:callback=>cleanups.push(callback)};
  function makeView(path) {
    const view = new MarkdownView(); view.file={path}; view.contentEl=window.document.createElement('div');
    window.document.body.append(view.contentEl); view.mode='preview'; view.line=0; view.calls=[];
    view.getMode=()=>view.mode;
    view.currentMode={getScroll:()=>view.line,applyScroll:line=>{view.line=line;view.calls.push(['scroll',line]);}};
    view.editor={setCursor:position=>view.calls.push(['cursor',position])};
    cache.set(view.file,{headings:[{heading:'First',level:1,position:{start:{line:0}}},{heading:'Same',level:2,position:{start:{line:12}}}]});
    return view;
  }
  registerNoteOutline(plugin);
  return {window,cache,timers,makeView, setViews(value){views=value;}, ready(){ready();}, emit(name,...args){handlers.get(name)(...args);}, unload(){cleanups.forEach(callback=>callback());},flush(){const pending=[...timers.values()];timers.clear();pending.forEach(callback=>callback());}};
}

test('layout/file changes manage pane creation, metadata refresh, replacement and closure', () => {
  const env=setup(), left=env.makeView('left.md'), right=env.makeView('right.md');
  env.setViews([left,right]);env.ready();
  assert.equal(env.window.document.querySelectorAll('nav').length,2);
  env.emit('layout-change'); assert.equal(left.contentEl.querySelectorAll('nav').length,1);
  env.cache.set(left.file,{headings:[]});env.emit('changed',left.file);
  assert.equal(left.contentEl.querySelectorAll('.noteglow-outline-label').length,0);
  assert.equal(right.contentEl.querySelectorAll('.noteglow-outline-label').length,2);
  left.file={path:'new.md'};env.emit('file-open');
  assert.equal(left.contentEl.querySelector('.noteglow-outline-empty').textContent,'当前笔记暂无标题');
  env.setViews([right]);env.emit('layout-change');
  assert.equal(left.contentEl.querySelector('nav'),null);
  assert.equal(left.contentEl.classList.contains('noteglow-outline-host'),false);
  env.unload();assert.equal(right.contentEl.querySelector('nav'),null);
  env.emit('layout-change');assert.equal(right.contentEl.querySelector('nav'),null);
});

test('current mode navigation keeps reading mode and selects exact source line when editing', () => {
  const env=setup(), view=env.makeView('note.md');env.setViews([view]);env.ready();
  const label=view.contentEl.querySelectorAll('.noteglow-outline-label')[1];label.click();
  assert.deepEqual(view.calls,[['scroll',12]]);assert.equal(view.mode,'preview');
  view.mode='source';env.emit('layout-change');label.click();
  assert.deepEqual(view.calls.slice(1),[['scroll',12],['cursor',{line:12,ch:0}]]);
});

test('scroll coalesces, ignores outline scrolling and releases scheduled work on unload', () => {
  const env=setup(),view=env.makeView('note.md');env.setViews([view]);env.ready();
  const list=view.contentEl.querySelector('.noteglow-outline-list');
  list.dispatchEvent(new env.window.Event('scroll'));assert.equal(env.timers.size,0);
  const editor=env.window.document.createElement('div');view.contentEl.append(editor);
  view.line=14;editor.dispatchEvent(new env.window.Event('scroll'));editor.dispatchEvent(new env.window.Event('scroll'));
  assert.equal(env.timers.size,1);env.flush();
  assert.equal(view.contentEl.querySelector('[aria-current]').textContent,'Same');
  editor.dispatchEvent(new env.window.Event('scroll'));assert.equal(env.timers.size,1);
  env.unload();assert.equal(env.timers.size,0);
  editor.dispatchEvent(new env.window.Event('scroll'));assert.equal(env.timers.size,0);
});

test('plugin unloaded before layout ready cannot attach panels later', () => {
  const env=setup(),view=env.makeView('note.md');env.setViews([view]);env.unload();env.ready();
  assert.equal(view.contentEl.querySelector('nav'),null);
});

test('clicked heading stays active through fractional programmatic scroll and resumes on body input', () => {
  for (const input of ['wheel','touchstart','pointerdown','keydown']) {
    const env=setup(),view=env.makeView('note.md');view.mode='source';env.setViews([view]);env.ready();
    const labels=view.contentEl.querySelectorAll('.noteglow-outline-label');
    const body=env.window.document.createElement('div');view.contentEl.append(body);
    labels[1].click();view.line=11.8;
    body.dispatchEvent(new env.window.Event('scroll'));env.flush();
    assert.equal(view.contentEl.querySelector('[aria-current]').textContent,'Same');
    labels[1].dispatchEvent(new env.window.Event(input,{bubbles:true}));
    body.dispatchEvent(new env.window.Event('scroll'));env.flush();
    assert.equal(view.contentEl.querySelector('[aria-current]').textContent,'Same');
    body.dispatchEvent(new env.window.Event(input,{bubbles:true}));
    body.dispatchEvent(new env.window.Event('scroll'));env.flush();
    assert.equal(view.contentEl.querySelector('[aria-current]').textContent,'First');
    env.unload();
  }
});

test('file, mode and metadata changes release explicit heading selection', () => {
  for (const change of ['file','mode','metadata']) {
    const env=setup(),view=env.makeView('note.md');env.setViews([view]);env.ready();
    view.contentEl.querySelectorAll('.noteglow-outline-label')[1].click();view.line=0;
    if(change==='file') {const previous=view.file;view.file={path:'new.md'};env.cache.set(view.file,env.cache.get(previous));env.emit('file-open');}
    else if(change==='mode') {view.mode='source';env.emit('layout-change');}
    else env.emit('changed',view.file);
    assert.equal(view.contentEl.querySelector('[aria-current]').textContent,'First');
    env.unload();
  }
});

test('native sidebar input releases selection without moving highlight until the pane scrolls', () => {
  const env=setup(),view=env.makeView('note.md');env.setViews([view]);env.ready();
  view.contentEl.querySelectorAll('.noteglow-outline-label')[1].click();
  const sidebar=env.window.document.createElement('button');env.window.document.body.append(sidebar);
  sidebar.dispatchEvent(new env.window.Event('pointerdown',{bubbles:true}));
  assert.equal(view.contentEl.querySelector('[aria-current]').textContent,'Same');
  view.line=0;view.contentEl.dispatchEvent(new env.window.Event('scroll'));env.flush();
  assert.equal(view.contentEl.querySelector('[aria-current]').textContent,'First');
  env.unload();
  sidebar.dispatchEvent(new env.window.Event('pointerdown',{bubbles:true}));
  assert.equal(env.timers.size,0);assert.equal(view.contentEl.querySelector('nav'),null);
});
