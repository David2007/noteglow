import assert from 'node:assert/strict';
import test from 'node:test';
import { Window } from 'happy-dom';
import { createOutlinePanel, outlineTree } from '../src/note-outline-panel.ts';

const headings = [
  { text: '笔记', level: 1, line: 0 },
  { text: '分组', level: 2, line: 3 },
  { text: '重复', level: 3, line: 8 },
  { text: '重复', level: 3, line: 14 },
  { text: '尾章', level: 2, line: 20 }
];
function setup() {
  const window = new Window();
  const host = window.document.createElement('div'); window.document.body.append(host);
  const calls = [];
  const panel = createOutlinePanel(host, line => calls.push(line));
  panel.setHeadings('one.md', headings);
  return { window, host, panel, calls,
    rows: () => [...host.querySelectorAll('.noteglow-outline-row')],
    labels: () => [...host.querySelectorAll('.noteglow-outline-label')],
    branches: () => [...host.querySelectorAll('.noteglow-outline-branch')],
    toggle: () => host.querySelector('.noteglow-outline-header button') };
}

test('tree preserves duplicate positions and derives structural depth even with skipped levels', () => {
  const input = [{text:'a',level:2,line:1},{text:'same',level:5,line:4},{text:'same',level:3,line:6},{text:'b',level:1,line:9}];
  const copy = structuredClone(input);
  const tree = outlineTree(input);
  assert.deepEqual(tree.map(({parent,depth,children,line}) => ({parent,depth,children,line})), [
    {parent:-1,depth:0,children:true,line:1}, {parent:0,depth:1,children:false,line:4},
    {parent:0,depth:1,children:false,line:6}, {parent:-1,depth:0,children:false,line:9}
  ]);
  assert.deepEqual(input, copy);
  assert.deepEqual(outlineTree([]), []);
});

test('default shows first two structural levels and native buttons with full label titles', () => {
  const env = setup();
  assert.equal(env.toggle().getAttribute('aria-expanded'), 'true');
  assert.deepEqual(env.rows().map(row => row.hidden), [false,false,true,true,false]);
  assert.equal(env.labels()[2].title, '重复');
  assert.equal(env.branches()[2].disabled, true);
  assert.equal(env.host.querySelector('nav').getAttribute('aria-label'), '笔记目录');
});

test('branch toggle reveals children without navigation and can close again', () => {
  const env = setup(); env.branches()[1].click();
  assert.equal(env.rows()[2].hidden, false);
  assert.equal(env.branches()[1].getAttribute('aria-expanded'), 'true');
  env.branches()[1].click();
  assert.equal(env.rows()[2].hidden, true);
  assert.deepEqual(env.calls, []);
});

test('duplicate titles navigate to their own line and leave directory expanded', () => {
  const env = setup(); env.branches()[1].click();
  env.labels()[2].click(); env.labels()[3].click();
  assert.deepEqual(env.calls, [8,14]);
  assert.equal(env.labels()[3].getAttribute('aria-current'), 'location');
  assert.equal(env.labels()[2].hasAttribute('aria-current'), false);
  assert.equal(env.toggle().getAttribute('aria-expanded'), 'true');
});

test('scroll tracking selects containing chapter, opens ancestors and clears before first heading', () => {
  const env = setup(); env.panel.setActiveLine(15.5);
  assert.equal(env.rows()[3].hidden, false);
  assert.equal(env.labels()[3].getAttribute('aria-current'), 'location');
  env.panel.setActiveLine(15.9);
  env.panel.setActiveLine(100);
  assert.equal(env.labels()[4].getAttribute('aria-current'), 'location');
  env.panel.setActiveLine(-1);
  assert.equal(env.host.querySelector('[aria-current]'), null);
});

test('whole panel collapse is manual and scroll updates cannot reopen it', () => {
  const env = setup(); env.toggle().click(); env.panel.setActiveLine(14);
  assert.equal(env.host.classList.contains('noteglow-outline-collapsed'), true);
  assert.equal(env.host.querySelector('.noteglow-outline-list').hidden, true);
  env.panel.setHeadings('one.md', [...headings, {text:'新增',level:2,line:30}]);
  assert.equal(env.toggle().getAttribute('aria-expanded'), 'false');
  env.toggle().click();
  assert.equal(env.host.querySelector('.noteglow-outline-list').hidden, false);
});

test('unchanged cache preserves rows and manual branches; new note resets collapse and replaces old actions', () => {
  const env = setup(); env.branches()[1].click();
  const row = env.rows()[2];
  env.panel.setHeadings('one.md', structuredClone(headings));
  assert.equal(env.rows()[2], row); assert.equal(row.hidden, false);
  env.toggle().click();
  env.panel.setHeadings('two.md', [{text:'另篇',level:1,line:7}]);
  assert.equal(env.toggle().getAttribute('aria-expanded'), 'true');
  assert.equal(env.rows().length, 1); assert.equal(env.labels()[0].textContent, '另篇');
  env.labels()[0].click(); assert.deepEqual(env.calls, [7]);
});

test('empty notes render non-interactive hint and later metadata adds headings', () => {
  const env = setup(); env.panel.setHeadings('empty.md', []); env.panel.setActiveLine(8);
  assert.equal(env.rows().length, 0);
  assert.equal(env.host.querySelector('.noteglow-outline-empty').textContent, '当前笔记暂无标题');
  env.panel.setHeadings('empty.md', headings);
  assert.equal(env.host.querySelector('.noteglow-outline-empty'), null);
  assert.equal(env.rows().length, 5);
});

test('headings are text only, not injected HTML', () => {
  const env = setup(); const text = '<img src=x onerror=alert(1)> & title';
  env.panel.setHeadings('x.md', [{text,level:1,line:0}]);
  assert.equal(env.labels()[0].textContent, text); assert.equal(env.host.querySelector('img'), null);
});

test('independent panes retain independent active and collapsed state', () => {
  const left = setup(), right = setup(); left.toggle().click(); right.panel.setActiveLine(14);
  assert.equal(left.host.classList.contains('noteglow-outline-collapsed'), true);
  assert.equal(right.host.classList.contains('noteglow-outline-collapsed'), false);
  assert.equal(left.host.querySelector('[aria-current]'), null);
  left.panel.destroy(); right.labels()[3].click(); assert.deepEqual(right.calls, [14]);
});

test('destroy is idempotent, removes only owned UI and refuses queued interactions', () => {
  const env = setup(); const content = env.window.document.createElement('article'); env.host.append(content);
  const label = env.labels()[1], branch = env.branches()[0], toggle = env.toggle();
  env.panel.destroy(); env.panel.destroy();
  label.click(); branch.click(); toggle.click();
  env.panel.setHeadings('x.md', headings); env.panel.setActiveLine(15);
  assert.deepEqual(env.calls, []);
  assert.deepEqual([...env.host.children], [content]);
  assert.equal(env.host.classList.contains('noteglow-outline-host'), false);
});

test('active row scroll adjusts only directory scroll offsets', () => {
  const env = setup(), list = env.host.querySelector('.noteglow-outline-list');
  Object.defineProperty(list, 'clientHeight', {value:50});
  Object.defineProperty(env.rows()[3], 'offsetTop', {value:100});
  Object.defineProperty(env.rows()[3], 'offsetHeight', {value:28});
  env.panel.setActiveLine(14); assert.equal(list.scrollTop,78);
  Object.defineProperty(env.rows()[1], 'offsetTop', {value:28});
  env.panel.setActiveLine(4); assert.equal(list.scrollTop,28);
  assert.equal(env.host.scrollTop,0); assert.deepEqual(env.calls,[]);
});

test('expanding after collapsed body scroll reveals active row without another section change', () => {
  const env = setup(), list = env.host.querySelector('.noteglow-outline-list');
  Object.defineProperty(list, 'clientHeight', {value:50});
  Object.defineProperty(env.rows()[3], 'offsetTop', {value:200});
  Object.defineProperty(env.rows()[3], 'offsetHeight', {value:28});
  env.toggle().click();
  env.panel.setActiveLine(14);
  assert.equal(list.scrollTop,0);
  env.toggle().click();
  assert.equal(list.scrollTop,178);
  assert.equal(env.labels()[3].getAttribute('aria-current'),'location');
  assert.equal(env.rows()[3].hidden,false);
  assert.equal(env.host.scrollTop,0);
  assert.deepEqual(env.calls,[]);
});
