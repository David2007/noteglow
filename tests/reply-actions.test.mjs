import assert from 'node:assert/strict';
import test from 'node:test';
import { Window } from 'happy-dom';
import { replyCodeBlocks, insertReplyCode, replyTargetAvailable, addReplyActions } from '../src/reply-actions.ts';

const tick = () => new Promise(resolve => setImmediate(resolve));
test('Markdown code extraction preserves spaces and handles nested, tilde, indented and empty blocks', () => {
  assert.deepEqual(replyCodeBlocks('hello `inline`\n\n~~~go\n\tvalue  \n\nnext\n~~~\n\n> ```js\n> nested\n> ```\n\n    indented\n\n```\n```'),
    ['\tvalue  \n\nnext', 'nested', 'indented', '']);
  assert.deepEqual(replyCodeBlocks('no code'), []);
  assert.deepEqual(replyCodeBlocks('````md\n```\n````'), ['```']);
});

test('Apply inserts at active selection head in one transaction without deleting selection', () => {
  for (const [code, expected] of [['one', { line: 3, ch: 5 }], ['a\n  b', { line: 4, ch: 3 }]]) {
    const calls = []; let focused = 0;
    insertReplyCode({ getCursor: which => { assert.equal(which, 'head'); return { line: 3, ch: 2 }; }, transaction: tx => calls.push(tx), focus: () => focused++ }, code);
    assert.deepEqual(calls, [{ changes: [{ from: { line: 3, ch: 2 }, to: { line: 3, ch: 2 }, text: code }], selection: { from: expected, to: expected } }]);
    assert.equal(focused, 1);
  }
  assert.throws(() => insertReplyCode({}, ''), /代码块为空/);
});

test('target gate rejects missing, closed, reading, unloaded and read-only editors', () => {
  const view = { file: {}, getMode: () => 'source', editor: {} };
  assert.equal(replyTargetAvailable(view, true, false), true);
  assert.equal(replyTargetAvailable({ ...view, editor: { cm: { state: { readOnly: false } } } }, true, false), true);
  for (const args of [[null, true, false], [{ ...view, file: null }, true, false], [view, false, false], [view, true, true], [{ ...view, getMode: () => 'preview' }, true, false], [{ ...view, editor: { cm: { state: { readOnly: true } } } }, true, false]]) {
    assert.equal(replyTargetAvailable(...args), false);
  }
});

function setup(overrides = {}) {
  const window = new Window(), document = window.document;
  const header = document.createElement('div'), body = document.createElement('div');
  document.body.append(header, body);
  body.innerHTML = '<pre><code><span>first</span>\n</code><button>Copy code</button></pre><pre><code>unknown</code></pre><pre><code>second</code></pre>';
  const copies = [], applies = [], notices = [];
  addReplyActions({ header, body, markdown: '**Full reply**\n\n```go\nfirst\n```\n\n~~~js\nsecond\n~~~', active: () => true, copy: async text => copies.push(text), apply: code => applies.push(code), notice: text => notices.push(text), ...overrides });
  return { document, header, body, copies, applies, notices, buttons: [...document.querySelectorAll('.codex-notes-reply-action')] };
}

test('Copy uses complete Markdown and Apply uses AST source, excluding injected controls and unknown code DOM', async () => {
  const env = setup();
  assert.equal(env.buttons.length, 3);
  assert.equal(env.buttons[0].getAttribute('aria-label'), '复制整条 Codex 回复（Markdown）');
  env.buttons[0].click(); env.buttons[1].click(); env.buttons[2].click();
  await tick();
  assert.deepEqual(env.copies, ['**Full reply**\n\n```go\nfirst\n```\n\n~~~js\nsecond\n~~~']);
  assert.deepEqual(env.applies, ['first', 'second']);
  assert.equal(env.notices.length, 3);
});

test('pending copy is single-flight, and failed copy/apply reports error and re-enables buttons', async () => {
  let release; const calls = [];
  const env = setup({ copy: text => { calls.push(text); return new Promise(resolve => { release = resolve; }); }, apply: () => { throw new Error('目标已关闭'); } });
  env.buttons[0].click(); env.buttons[0].click();
  assert.equal(calls.length, 1); assert.equal(env.buttons[0].disabled, true);
  release(); await tick(); assert.equal(env.buttons[0].disabled, false);
  env.buttons[1].click(); await tick(); assert.ok(env.notices.includes('目标已关闭'));
  assert.equal(env.buttons[1].disabled, false);
  const rejected = setup({ copy: async () => { throw 'blocked'; } });
  rejected.buttons[0].click(); await tick(); assert.deepEqual(rejected.notices, ['操作失败，请重试。']);
});

test('detached and inactive message buttons cannot copy or apply', async () => {
  const inactive = setup({ active: () => false });
  inactive.buttons.forEach(button => button.click());
  const detached = setup(); detached.document.body.replaceChildren();
  detached.buttons.forEach(button => button.click());
  await tick();
  for (const env of [inactive, detached]) {
    assert.deepEqual(env.copies, []); assert.deepEqual(env.applies, []); assert.deepEqual(env.notices, []);
  }
});

test('ambiguous trailing newline after a special renderer is skipped, while duplicate identical code stays safe', async () => {
  for (const [markdown, expected] of [
    ['```diagram\nfirst\n\n```\n\n```\nfirst\n```', []],
    ['```diagram\nfirst\n```\n\n```\nfirst\n```', ['first']]
  ]) {
    const env = setup({ markdown });
    for (const button of env.buttons.slice(1)) button.click();
    await tick();
    assert.deepEqual(env.applies, expected);
    assert.equal(env.buttons.length, expected.length + 1);
  }
});
