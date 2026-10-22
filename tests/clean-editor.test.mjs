import assert from 'node:assert/strict';
import test from 'node:test';
import { EditorState, EditorSelection, Transaction, StateEffect, StateField } from '@codemirror/state';
import { history, undo, redo, isolateHistory } from '@codemirror/commands';
import { cleanMarkdownSyntax, markdownLinkAddress } from '../src/markdown-colors.ts';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { keymap } from '@codemirror/view';
import { cleanEditorExtension } from '../src/clean-editor.ts';

function visible(text) { const {ranges}=cleanMarkdownSyntax(text);let output=text;for(const r of [...ranges].reverse())output=output.slice(0,r.from)+output.slice(r.to);return output; }
test('exact AST delimiters disappear while ordinary content and list markers remain',()=>{
 const text='## Heading ##\n\n**bold** *italic* ~~strike~~ `a*b`\n\n> quoted\n\n- [ ] task\n1. numbered\n\n```go\nif x > 0 { // **literal**\n}\n```';
 assert.equal(visible(text),'Heading\n\nbold italic strike a*b\n\nquoted\n\n- [ ] task\n1. numbered\n\n\nif x > 0 { // **literal**\n}\n');
 assert.equal(visible('***nested*** and ``a`b``'),'nested and a`b');
 assert.equal(visible('Heading\n======='),'Heading\n');
});
test('code body, YAML, HTML and unsupported links remain literal',()=>{
 for(const text of ['```go\n**literal**','    **literal**','---\nname: "**literal**"\n---','<div>**literal**</div>','[label][ref]\n\n[ref]: https://example.test','[[wiki]]','![alt](image.png)'])assert.equal(visible(text),text,text);
 assert.equal(visible('> `x > 0`'),'x > 0');
 assert.equal(visible('- **item**'),'- item');
});
test('inline links preserve labels and title while exposing exact editable URL range',()=>{
 for(const text of ['[label](https://example.test/a(b) "title")','[**bold**](<https://example.test/a b>)','[label](../a\\(b\\))']) {
  const result=cleanMarkdownSyntax(text),link=result.links[0];assert.ok(link);
  assert.ok(['https://example.test/a(b)','<https://example.test/a b>','../a\\(b\\)'].includes(text.slice(link.addressFrom,link.addressTo)));
  const updated=text.slice(0,link.addressFrom)+markdownLinkAddress('https://new.test/a b')+text.slice(link.addressTo);
  assert.ok(updated.includes('<https://new.test/a%20b>'));
  assert.equal(visible(updated),text.includes('bold')?'bold':'label');
  if(text.includes('"title"'))assert.ok(updated.endsWith(' "title")'));
 }
 for(const invalid of ['', 'a\nb', '<bad>', 'x'.repeat(8193), 'a\0b'])assert.equal(markdownLinkAddress(invalid),null);
 assert.equal(markdownLinkAddress('https://example.test/a\\b'),'<https://example.test/a%5Cb>');
});
test('Live Preview changes decorations only; cursor selection cannot reveal delimiters and Source restores them',()=>{
 const toggle=StateEffect.define(),mode=StateField.define({create:()=>true,update:(v,tr)=>tr.effects.reduce((x,e)=>e.is(toggle)?e.value:x,v)});
 const extension=cleanEditorExtension(state=>state.field(mode)),field=extension[0];
 let state=EditorState.create({doc:'**bold**',extensions:[mode,extension]});
 assert.equal(state.field(field).decorations.size,2);
 for(const anchor of [0,1,2,4,6,7,8]){state=state.update({selection:{anchor}}).state;assert.equal(state.field(field).decorations.size,2);assert.equal(state.doc.toString(),'**bold**');}
 state=state.update({effects:toggle.of(false)}).state;assert.equal(state.field(field).decorations.size,0);assert.equal(state.doc.toString(),'**bold**');
 state=state.update({effects:toggle.of(true)}).state;assert.equal(state.field(field).decorations.size,2);
});
test('empty-selection deletion cannot break a hidden delimiter; explicit deletion and Undo remain native',()=>{
 const extension=cleanEditorExtension(()=>true);let state=EditorState.create({doc:'**bold**',selection:{anchor:2},extensions:[history(),extension]});
 state=state.update({changes:{from:1,to:2},annotations:Transaction.userEvent.of('delete.backward')}).state;assert.equal(state.doc.toString(),'**bold**');
 state=state.update({selection:{anchor:2,head:6}}).state;
 state=state.update({changes:{from:2,to:6},annotations:Transaction.userEvent.of('delete.selection')}).state;assert.equal(state.doc.toString(),'****');
 const target={get state(){return state;},dispatch(tr){state=tr.state;}};assert.equal(undo(target),true);assert.equal(state.doc.toString(),'**bold**');assert.equal(redo(target),true);assert.equal(state.doc.toString(),'****');
});
test('typing new complete markup still creates formatting without modifying source',()=>{
 const extension=cleanEditorExtension(()=>true),field=extension[0];let state=EditorState.create({extensions:[extension]});
 for(const character of '**bold**')state=state.update({changes:{from:state.doc.length,insert:character},annotations:Transaction.userEvent.of('input.type')}).state;
 assert.equal(state.doc.toString(),'**bold**');assert.equal(state.field(field).decorations.size,2);
});


test('quoted fenced code retains body greater-than symbols at every quote depth',()=>{
 for(const source of ['> ```\n> > literal\n> ```','> > ```\n> > > literal\n> > ```']) {
  const result=visible(source);
  assert.ok(result.includes('\n> literal\n'),result);
 }
 assert.equal(visible('> > nested\n> > second'),'nested\nsecond');
});


test('link address encoding preserves entity-looking URL query text on parse round-trip',()=>{
 for(const address of ['https://example.test/?val=&copy;','https://example.test/?val=&amp;copy;','https://example.test/?a=1&b=2']) {
  const markdown='[label]('+markdownLinkAddress(address)+')';
  assert.equal(cleanMarkdownSyntax(markdown).links[0].url,address);
 }
});


test('only parser-confirmed links hide; explicit empty angle destination preserves its real title',()=>{
 const literal='[label]( "my title")';
 assert.equal(visible(literal),literal);assert.equal(cleanMarkdownSyntax(literal).links.length,0);
 for(const source of ['[label]( "title")',"[label]( 'title')"]) {
  // 当前 CommonMark 解析器把引号视为 URL 字符，不是 title。
  assert.equal(visible(source),'label');assert.equal(cleanMarkdownSyntax(source).links[0].url,source.slice(9,-1));
 }
 const source='[label](<> "my title")',link=cleanMarkdownSyntax(source).links[0];
 assert.equal(visible(source),'label');assert.equal(link.url,'');
 assert.equal(source.slice(link.addressFrom,link.addressTo),'<>');
 assert.equal(source.slice(0,link.addressFrom)+markdownLinkAddress('https://new.test')+source.slice(link.addressTo),'[label](<https://new.test> "my title")');
 assert.equal(cleanMarkdownSyntax('[label]()').links.length,1);
});


test('Setext heading underline hides inside quoted containers without hiding code content',()=>{
 for(const marker of ['===','---']) {
  assert.equal(visible('> Heading\n> '+marker),'Heading\n');
  assert.equal(visible('> > Heading\n> > '+marker),'Heading\n');
  assert.ok(visible('> ```\n> '+marker+'\n> ```').includes(marker));
 }
});


test('escaped angle destination terminator is included in the exact editable URL range',()=>{
 const source='[label](<a\\>b> "title")';
 const link=cleanMarkdownSyntax(source).links[0];assert.ok(link);
 assert.equal(source.slice(link.addressFrom,link.addressTo),'<a\\>b>');
 const updated=source.slice(0,link.addressFrom)+markdownLinkAddress('https://new.test')+source.slice(link.addressTo);
 assert.equal(updated,'[label](<https://new.test> "title")');
});


test('confirmed text escapes hide only their introducer and preserve literal punctuation and odd/even runs',()=>{
 for(const [source,expected] of [
  [String.raw`\*literal\*`,'*literal*'],
  [String.raw`\\`,'\\'],
  [String.raw`\\\*`,'\\*'],
  [String.raw`\\\\`,'\\\\'],
  [String.raw`\q`,'\\q'],
  [String.raw`\***bold**。\*tail`,'*bold。*tail'],
  [String.raw`\[label\]`,'[label]']
 ]) assert.equal(visible(source),expected,source);
 for(const source of ['`'+String.raw`\*code\*`+'`','```\n'+String.raw`\*code\*`+'\n```','<div>'+String.raw`\*html\*`+'</div>','---\nvalue: '+String.raw`\*yaml\*`+'\n---']) {
  const {ranges}=cleanMarkdownSyntax(source);
  for(const index of [...source.matchAll(/\\/g)].map(match=>match.index)) assert.ok(!ranges.some(r=>r.from<=index&&r.to>index),source);
 }
});
test('escape display decorations never rewrite source and Source mode reveals the original backslashes',()=>{
 let live=true;const source=String.raw`\*literal\*`,extension=cleanEditorExtension(()=>live),field=extension[0];
 let state=EditorState.create({doc:source,extensions:[extension]});assert.equal(state.field(field).decorations.size,2);assert.equal(state.doc.toString(),source);
 state=state.update({selection:{anchor:2}}).state;assert.equal(state.doc.toString(),source);assert.equal(state.field(field).decorations.size,2);
 live=false;state=state.update({}).state;assert.equal(state.field(field).decorations.size,0);assert.equal(state.doc.toString(),source);
});

test('multiline quotes retain exact per-level prefixes without treating code greater-than as nesting',()=>{
 const source='> first\n> second\n>\n> > nested\n> > again';
 const syntax=cleanMarkdownSyntax(source);
 assert.equal(visible(source),'first\nsecond\n\nnested\nagain');
 assert.deepEqual(syntax.quotes.map(r=>[source.slice(0,r.from).split('\n').length,source.slice(r.from,r.to)]),[[1,'> '],[2,'> '],[3,'>'],[4,'> '],[5,'> '],[4,'> '],[5,'> ']]);
 for(const text of ['```\n> literal\n```','    > literal','---\nvalue: >\n---']) assert.deepEqual(cleanMarkdownSyntax(text).quotes,[]);
 const code='> ```\n> > literal\n> ```';
 assert.deepEqual(cleanMarkdownSyntax(code).quotes,[]);
 assert.ok(visible(code).includes('> literal'));
});

// 直接调用已注册的键绑定；其余 Enter 事务由 Obsidian 原生 Markdown 命令负责。
function quoteEditor(doc,cursor,options={}) {
 let state=EditorState.create({doc,selection:options.selection??{anchor:cursor},extensions:[history(),EditorState.allowMultipleSelections.of(true),EditorState.readOnly.of(!!options.readOnly),cleanEditorExtension(()=>options.live!==false)]});
 const view={get state(){return state;},composing:!!options.composing,dispatch(spec){state=spec.state??state.update(spec).state;}};
 const backspace=state.facet(keymap).flat().find(binding=>binding.key==='Backspace').run;
 return {view,backspace:()=>backspace(view)};
}
test('Backspace at quoted content start removes only one nested level and each step has its own Undo',()=>{
 const original='> first\n> > second',cursor=original.indexOf('second'),editor=quoteEditor(original,cursor);
 assert.equal(editor.backspace(),true);assert.equal(editor.view.state.doc.toString(),'> first\n> second');
 assert.equal(editor.backspace(),true);assert.equal(editor.view.state.doc.toString(),'> first\n\nsecond');
 assert.equal(editor.backspace(),false);
 assert.equal(undo(editor.view),true);assert.equal(editor.view.state.doc.toString(),'> first\n> second');
 assert.equal(undo(editor.view),true);assert.equal(editor.view.state.doc.toString(),original);assert.equal(editor.view.state.selection.main.head,cursor);
 assert.equal(redo(editor.view),true);assert.equal(redo(editor.view),true);assert.equal(editor.view.state.doc.toString(),'> first\n\nsecond');
});
test('quote retreat preserves inline markup, whitespace, adjacent lines and actual code contents',()=>{
 for(const [source,word,expected] of [
  ['>  >  **重点**','重点','>   **重点**'],
  ['> a\n> b\n> c','b','> a\n\nb\n> c'],
  ['> > `x > 0`','x','> `x > 0`'],
  ['> > ','', '> '],
  ['> ','',''],
 ]) {
  const editor=quoteEditor(source,word?source.indexOf(word):source.length);
  assert.equal(editor.backspace(),true,source);assert.equal(editor.view.state.doc.toString(),expected);
  if(word==='重点'){assert.equal(textQuoteDepth(expected,word),1);assert.equal(visible(expected).trim(),'重点');}
  assert.equal(undo(editor.view),true);assert.equal(editor.view.state.doc.toString(),source);
 }
 for(const source of ['plain','> word','```\n> code\n```','    > code']) {
  const editor=quoteEditor(source,source.indexOf('code')>=0?source.indexOf('code'):source.length);
  assert.equal(editor.backspace(),false,source);assert.equal(editor.view.state.doc.toString(),source);
 }
});
test('quote Backspace bypasses Source mode, readonly, composing, ranges and multiple cursors',()=>{
 for(const options of [{live:false},{readOnly:true},{composing:true},{selection:{anchor:2,head:3}},{selection:EditorSelection.create([EditorSelection.cursor(2),EditorSelection.cursor(3)])}]) {
  const editor=quoteEditor('> abc',2,options);
  assert.equal(editor.backspace(),false);assert.equal(editor.view.state.doc.toString(),'> abc');
 }
});
test('native Enter continuation and empty-quote exit transactions remain undoable with hidden markers',()=>{
 const editor=quoteEditor('> first',7);
 editor.view.dispatch({changes:{from:7,insert:'\n> '},selection:{anchor:10},annotations:[Transaction.userEvent.of('input'),isolateHistory.of('full')]});
 assert.equal(editor.view.state.doc.toString(),'> first\n> ');
 editor.view.dispatch({changes:{from:8,to:10},selection:{anchor:8},annotations:[Transaction.userEvent.of('input'),isolateHistory.of('full')]});
 assert.equal(editor.view.state.doc.toString(),'> first\n');
 assert.equal(undo(editor.view),true);assert.equal(editor.view.state.doc.toString(),'> first\n> ');
 assert.equal(undo(editor.view),true);assert.equal(editor.view.state.doc.toString(),'> first');
 assert.equal(redo(editor.view),true);assert.equal(redo(editor.view),true);assert.equal(editor.view.state.doc.toString(),'> first\n');
});

function textQuoteDepth(source,word) {
 let found;
 function visit(node,depth=0) {
  const next=depth+(node.type==='blockquote'?1:0);
  if(node.type==='text'&&node.value.includes(word))found=next;
  for(const child of node.children??[])visit(child,next);
 }
 visit(fromMarkdown(source));return found;
}
test('multiline retreat changes parsed quote depth rather than creating lazy continuation',()=>{
 for(const [source,word,depth] of [['> first\n> second','second',0],['> > first\n> > second\n> > third','second',1],['> outer\n> > first\n> > second','second',1]]) {
  const editor=quoteEditor(source,source.indexOf(word));assert.equal(editor.backspace(),true);
  const result=editor.view.state.doc.toString();assert.equal(textQuoteDepth(result,word),depth);
  assert.equal(textQuoteDepth(result,'first'),textQuoteDepth(source,'first'));
  if(source.includes('third'))assert.equal(textQuoteDepth(result,'third'),2);
  assert.equal(undo(editor.view),true);assert.equal(editor.view.state.doc.toString(),source);
 }
});
test('line-start and intermediate hidden-marker cursor positions also retreat exactly one level',()=>{
 for(const cursor of [0,1,2,3,4]) {
  const editor=quoteEditor('> > body',cursor);assert.equal(editor.backspace(),true);
  assert.equal(editor.view.state.doc.toString(),'> body');assert.equal(textQuoteDepth(editor.view.state.doc.toString(),'body'),1);
  assert.equal(undo(editor.view),true);assert.equal(editor.view.state.selection.main.head,cursor);
 }
});

test('Backspace before a visible list marker is not consumed by a following quote',()=>{
 for(const cursor of [0,1]) {
  const editor=quoteEditor('- > quote',cursor);assert.equal(editor.backspace(),false);assert.equal(editor.view.state.doc.toString(),'- > quote');
 }
 const editor=quoteEditor('  > quote',0);assert.equal(editor.backspace(),true);assert.equal(editor.view.state.doc.toString(),'  quote');
});

test('quoted block code and implicit nested quote continuation stay with native Backspace',()=>{
 for(const [source,word] of [
  ['> ```js\n> const x = 1\n> ```','const'],
  ['> ```js\n> const x = 1\n> ```','```js'],
  ['>     const x = 1','const'],
  ['> > first\n> second','second'],
  ['> > > first\n> second','second']
 ]) {
  const editor=quoteEditor(source,source.indexOf(word));assert.equal(editor.backspace(),false,source);assert.equal(editor.view.state.doc.toString(),source);
 }
});
