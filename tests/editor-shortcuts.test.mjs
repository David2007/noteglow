import assert from 'node:assert/strict';
import test from 'node:test';
import { EditorState, EditorSelection, Transaction } from '@codemirror/state';
import { history, undo, redo } from '@codemirror/commands';
import { applyNativeTextColor, nativeTextColorTransactions, createNativeTextMetadataField } from '../src/native-text-colors.ts';
import { applyNativeCodeColor, nativeCodeColorTransactions, createNativeMetadataField } from '../src/native-code-colors.ts';
import { slashCommandEdit, expandSlashCommand } from '../src/editor-shortcuts.ts';

function expand(source, command) {
 const cursor = source.indexOf(command) + command.length;
 const edit = slashCommandEdit(source, cursor);
 assert.ok(edit);
 return { ...edit, text: source.slice(0, edit.from) + edit.insert + source.slice(edit.to) };
}

test('code and table are native blocks with useful cursor positions and isolated surrounding prose', () => {
 const code = expand('before\n/code\nafter', '/code');
 assert.equal(code.text, 'before\n\n```\n\n```\n\nafter');
 assert.equal(code.cursor, code.text.indexOf('```') + 4);
 const table = expand('/bg', '/bg');
 assert.equal(table.text, '| 标题 1 | 标题 2 |\n| --- | --- |\n|  |  |\n|  |  |');
 assert.equal(table.text.slice(table.cursor, table.cursor + 4), '标题 1');
 assert.equal(expand('before\n\n  /code\n\nafter', '/code').text, 'before\n\n```\n\n```\n\nafter');
 const crlf = expand('before\r\n/code\r\nafter', '/code');
 assert.equal(crlf.text, 'before\r\n\r\n```\r\n\r\n```\r\n\r\nafter');
 assert.equal(crlf.text.slice(crlf.cursor, crlf.cursor + 2), '\r\n');
});

test('plain input, invalid cursors and protected Markdown never expand', () => {
 for (const source of ['hello /code', '/code x', '/CODE', '/code ', '    /code', '> /code', '- /code', '```\n/code\n```', '~~~\n/code', '<!--\n/code\n-->', '<div>\n/code\n</div>', '---\n/code\n---', '$$\n/code\n$$', '%%\n/code\n%%', '`text\n/code\ntext`', '- item\n  /code']) {
  const at = source.indexOf('/code');
  const cursor = at >= 0 ? at + 5 : source.length;
  assert.equal(slashCommandEdit(source, cursor), null, source);
 }
 for (const cursor of [-1, 1.5, NaN, 6, 0, 4]) assert.equal(slashCommandEdit('/code', cursor), null);
 assert.equal(slashCommandEdit('x'.repeat(1_000_001), 1), null);
});

test('Enter conversion is one undo unit and redo preserves the cursor', () => {
 let state = EditorState.create({ doc: '/code', selection: { anchor: 5 }, extensions: [history()] });
 const view = { composing: false, get state() { return state; }, dispatch(spec) { state = spec instanceof Transaction ? spec.state : state.update(spec).state; } };
 assert.equal(expandSlashCommand(view), true);
 assert.equal(state.doc.toString(), '```\n\n```');
 assert.equal(state.selection.main.head, 4);
 assert.equal(undo(view), true);
 assert.equal(state.doc.toString(), '/code');
 assert.equal(state.selection.main.head, 5);
 assert.equal(redo(view), true);
 assert.equal(state.doc.toString(), '```\n\n```');
 assert.equal(state.selection.main.head, 4);
 view.dispatch(state.replaceSelection('CodeBody'));
 assert.equal(state.doc.toString(), '```\nCodeBody\n```');
});

test('composition, read-only, selections, multiple cursors and ordinary Enter are untouched', () => {
 const cases = [
  { doc: '/bg', selection: { anchor: 3 }, composing: true },
  { doc: '/bg', selection: { anchor: 3 }, extensions: [EditorState.readOnly.of(true)] },
  { doc: '/bg', selection: { anchor: 0, head: 3 } },
  { doc: '/bg', selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(3)]), extensions: [EditorState.allowMultipleSelections.of(true)] },
  { doc: 'ordinary', selection: { anchor: 8 } }
 ];
 for (const { composing = false, ...config } of cases) {
  const state = EditorState.create(config);
  assert.equal(expandSlashCommand({ state, composing, dispatch() { assert.fail('must not dispatch'); } }), false);
 }
});


test('code redo retains body cursor with native text/code metadata transaction filters', () => {
 const coloredText = applyNativeTextColor('Alpha', 0, 5, 'background', '#fff88f').text;
 const codeSource = '```js\nconst a = 1;\n```';
 const coloredCode = applyNativeCodeColor(codeSource, 6, 11, 'foreground', '#c0392b').text;
 const doc = coloredText + '\n\n' + coloredCode + '\n\n/code';
 let state = EditorState.create({ doc, selection: { anchor: doc.length }, extensions: [history(), nativeTextColorTransactions, nativeCodeColorTransactions, createNativeTextMetadataField(() => true), createNativeMetadataField(() => true)] });
 const view = { composing: false, get state() { return state; }, dispatch(spec) { state = spec instanceof Transaction ? spec.state : state.update(spec).state; } };
 assert.equal(expandSlashCommand(view), true);
 const converted = state.doc.toString(), bodyCursor = state.selection.main.head;
 assert.equal(converted.slice(bodyCursor - 4), '```\n\n```');
 assert.equal(undo(view), true);
 assert.equal(state.doc.toString(), doc);
 assert.equal(redo(view), true);
 assert.equal(state.doc.toString(), converted);
 assert.equal(state.selection.main.head, bodyCursor);
 view.dispatch(state.replaceSelection('RedoBody'));
 assert.equal(state.doc.toString(), converted.slice(0, bodyCursor) + 'RedoBody' + converted.slice(bodyCursor));
});
