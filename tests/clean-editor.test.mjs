import assert from 'node:assert/strict';
import test from 'node:test';
import { EditorState, Transaction, StateEffect, StateField } from '@codemirror/state';
import { history, undo, redo } from '@codemirror/commands';
import { cleanMarkdownSyntax, markdownLinkAddress } from '../src/markdown-colors.ts';
import { cleanEditorExtension } from '../src/clean-editor.ts';

function visible(text) { const {ranges}=cleanMarkdownSyntax(text);let output=text;for(const r of [...ranges].reverse())output=output.slice(0,r.from)+output.slice(r.to);return output; }
test('exact AST delimiters disappear while ordinary content and list markers remain',()=>{
 const text='## Heading ##\n\n**bold** *italic* ~~strike~~ `a*b`\n\n> quoted\n\n- [ ] task\n1. numbered\n\n```go\nif x > 0 { // **literal**\n}\n```';
 assert.equal(visible(text),'Heading\n\nbold italic strike a*b\n\nquoted\n\n- [ ] task\n1. numbered\n\n\nif x > 0 { // **literal**\n}\n');
 assert.equal(visible('***nested*** and ``a`b``'),'nested and a`b');
 assert.equal(visible('Heading\n======='),'Heading\n');
});
test('code body, YAML, HTML, escaped syntax and unsupported links remain literal',()=>{
 for(const text of ['```go\n**literal**','    **literal**','\\*literal\\*','---\nname: "**literal**"\n---','<div>**literal**</div>','[label][ref]\n\n[ref]: https://example.test','[[wiki]]','![alt](image.png)'])assert.equal(visible(text),text,text);
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
