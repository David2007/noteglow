import assert from 'node:assert/strict';
import test from 'node:test';
import {EditorState,EditorSelection,Transaction,StateField,StateEffect,ChangeSet} from '@codemirror/state';
import {history,undo,redo,isolateHistory,deleteCharBackward,deleteCharForward} from '@codemirror/commands';
import {EditorView} from '@codemirror/view';
import {Window} from 'happy-dom';
import {applyNativeTextColor,formatNativeText,scanNativeText,nativeTextColorRanges,nativeTextColorTransactions,migrateOwnedTextToNative,resetNativeTextMetadata,encodeNativeTextMetadata,createNativeTextMetadataField,nativeTextMetadataChanges,nativeTextOwnedRecords,repairNativeTextMetadata,isNativeTableNormalization} from '../src/native-text-colors.ts';
import {applyNativeCodeColor,nativeCodeColorTransactions,scanNativeCode,minimalTextChange} from '../src/native-code-colors.ts';
import {applyMarkdownColor,nativeTextDocumentShape,restoreOwnedInline,projectNativeMarkdown,nativeTableCell,nativeTableEditorOffsets,nativeTableSelectedCells} from '../src/markdown-colors.ts';
import {alignRenderedText} from '../src/color-ranges.ts';
const bg='#fff88f',fg='#c0392b';
const paint=(text,word,property='background',color=bg)=>{const from=text.indexOf(word);return applyNativeTextColor(text,from,from+word.length,property,color);};
const fixture='- `arr`：数组赋值会复制。\n- `brr`：修改副本不会影响原数组。\n- `crr`：切片共享底层数组。';

test('three list ranges remain native Markdown and clear only the second',()=>{
 let text=fixture;
 for(const word of ['arr','brr','crr'])text=paint(text,word).text;
 assert.equal(text.slice(0,fixture.length),fixture);assert.equal(scanNativeText(text).length,1);
 assert.equal(scanNativeText(text)[0].ranges.length,3);assert.ok(!text.includes('<span'));assert.ok(!text.includes('<code'));
 const at=text.indexOf('brr');text=applyNativeTextColor(text,at,at+3).text;
 assert.deepEqual(nativeTextColorRanges(text).map(range=>text.slice(range.from,range.to)),['arr','crr']);
 assert.equal(resetNativeTextMetadata(text),fixture);
});

test('metadata preserves actual Markdown AST including tight lists, headings and adjacent blocks',()=>{
 for(const source of [fixture,'# title\nnext','title\n===\nnext','1. alpha\n2. beta\n\nafter','alpha\n\n# next','- alpha\n\n- beta\n\nafter','alpha','alpha\r\n\r\nafter']) {
  const word=source.includes('alpha')?'alpha':source.includes('arr')?'arr':'title';
  const colored=paint(source,word).text;
  assert.equal(nativeTextDocumentShape(colored),nativeTextDocumentShape(source));
  const at=colored.indexOf(word);assert.equal(applyNativeTextColor(colored,at,at+word.length).text,source);
 }
});

test('bold/link/inline-code source symbols are excluded from color ranges',()=>{
 const source='- **bold** [link](https://example.test) and `code`';
 const result=applyNativeTextColor(source,0,source.length,'foreground',fg);
 const covered=nativeTextColorRanges(result.text).map(range=>result.text.slice(range.from,range.to)).join('');
 assert.equal(covered,'bold link and code');assert.ok(!covered.includes('https'));
});

test('entities and UTF16 boundaries fail closed; canonical records escape comment terminators',()=>{
 const source='a &amp; 😀 --> b',at=source.indexOf('&amp;');
 assert.throws(()=>applyNativeTextColor(source,at+1,at+3,'background',bg),/实体/);
 assert.throws(()=>applyNativeTextColor(source,source.indexOf('😀')+1,source.indexOf('😀')+2,'background',bg),/选区/);
 const result=applyNativeTextColor(source,at,at+5,'background',bg);assert.equal(result.text.slice(0,source.length),source);
 const raw=encodeNativeTextMetadata(source,[{from:0,to:1,property:'background',color:bg}]);assert.equal(raw.slice(4,-3).includes('--'),false);assert.ok(raw.includes('\\u002d'));
 assert.throws(()=>encodeNativeTextMetadata('a',[{from:0,to:2,property:'background',color:bg}]));
});

test('stale, corrupt and unsupported sources preserve text and expose a reset route',()=>{
 const valid=paint('alpha','alpha').text;
 for(const bad of [valid.replace('alpha\n','changed\n'),valid.replace('"version":1','"version":2'),valid.slice(0,-1)]) {
  assert.throws(()=>applyNativeTextColor(bad,0,1,'background',bg),/重置/);assert.equal(resetNativeTextMetadata(bad),bad.slice(0,bad.indexOf('\n\n')));
 }
 for(const source of ['> quote','- item\n\n  ```go\n  code\n  ```','<b>html</b>','$$\nmath\n$$']) assert.throws(()=>applyNativeTextColor(source,0,source.length,'background',bg));
 const literal='```html\n\n<!-- noteglow-text-colors:1 broken -->\n```';assert.equal(resetNativeTextMetadata(literal),literal);
 assert.equal(resetNativeTextMetadata('---\nvalue: "<!-- noteglow-text-colors:1 broken -->"\n---'),'---\nvalue: "<!-- noteglow-text-colors:1 broken -->"\n---');
});

test('plain text beside a complete HTML island supports colors, native formats and exact undo',()=>{
 const source='前文 <strong>Token</strong>。这个 Token 可能是一个完整的单词。',word='这个 Token 可能是一个完整的单词。',from=source.indexOf(word);
 for(const [format,marker] of [['bold','**'],['italic','*'],['code','`']]) {
  const colored=applyNativeTextColor(source,from,source.length,'background',bg);
  const formatted=formatNativeText(colored.text,from,source.length,format);
  assert.equal(resetNativeTextMetadata(formatted.text),source.slice(0,from)+marker+word+marker);
  assert.equal(scanNativeText(formatted.text)[0].status,'valid');
  assert.deepEqual(nativeTextColorRanges(formatted.text).map(range=>formatted.text.slice(range.from,range.to)),[word]);
  const foreground=applyNativeTextColor(formatted.text,formatted.from,formatted.to,'foreground',fg);
  assert.equal(scanNativeText(foreground.text)[0].ranges.length,2);
  const restored=formatNativeText(formatted.text,formatted.from,formatted.to,format);
  assert.equal(resetNativeTextMetadata(restored.text),source);
  assert.equal(applyNativeTextColor(restored.text,from,source.length).text,source);
  const h=harness(source),change=minimalTextChange(source,formatted.text);
  h.edit({from:change.from,to:change.to,insert:change.insert});
  assert.equal(undo(h.target),true);assert.equal(h.text,source);
  assert.equal(redo(h.target),true);assert.equal(h.text,formatted.text);
 }
 const before=applyNativeTextColor(source,0,2,'foreground',fg);
 assert.deepEqual(nativeTextColorRanges(before.text).map(range=>before.text.slice(range.from,range.to)),['前文']);
 const window=new Window(),el=window.document.createElement('div');
 el.innerHTML='<p>前文 <strong>Token</strong>。这个 Token 可能是一个完整的单词。</p>';
 const alignment=alignRenderedText(projectNativeMarkdown(source),el.textContent);
 assert.ok(alignment);assert.equal(alignment[el.textContent.indexOf(word)],from);
});

test('HTML island interiors, attributes, nesting and malformed tails remain protected',()=>{
 for(const island of ['<strong>inside</strong>','<span title="note"><em>inside</em></span>','<strong>inside','<strong><em>inside</strong>']) {
  const source='before '+island+' after',inside=source.indexOf('inside');
  for(const [from,to] of [[inside,inside+6],[0,inside+6],[inside,source.length],[0,source.length]]) {
   assert.throws(()=>applyNativeTextColor(source,from,to,'background',bg),/HTML/);
   for(const format of ['bold','italic','code'])assert.throws(()=>formatNativeText(source,from,to,format),/HTML/);
  }
 }
 const owned='before <span data-codex-color="1" style="color:#c0392b">legacy</span> after';
 assert.throws(()=>applyNativeTextColor(owned,0,6,'background',bg),/旧 HTML/);
 assert.throws(()=>formatNativeText(owned,0,6,'bold'),/旧 HTML/);
 const source='one\n\nbefore <strong>inside</strong> after\n\nlast';
 assert.throws(()=>applyNativeTextColor(source,0,source.length,'background',bg),/HTML/);
 assert.throws(()=>formatNativeText(source,0,source.length,'bold'),/HTML/);
 const plain='before <strong>inside</strong> after',at=plain.indexOf('inside');
 const invalid=plain+'\n\n'+encodeNativeTextMetadata(plain,[{from:at,to:at+6,property:'background',color:bg}]);
 assert.equal(scanNativeText(invalid)[0].status,'stale');assert.deepEqual(nativeTextColorRanges(invalid),[]);
 assert.throws(()=>applyNativeTextColor(invalid,0,6,'background',bg),/重置/);
});

test('ordinary input and Backspace beside HTML keep metadata valid and undo exact',()=>{
 const source=paint('before <strong>Token</strong> alpha after','alpha').text,at=source.indexOf('alpha');
 for(const [change,event,word] of [[{from:at+2,insert:'X'},'input.type','alXpha'],[{from:at+1,to:at+2},'delete.backward','apha']]) {
  const h=harness(source);h.edit(change,event);
  assert.equal(scanNativeText(h.text)[0].status,'valid');
  assert.deepEqual(nativeTextColorRanges(h.text).map(range=>h.text.slice(range.from,range.to)),[word]);
  assert.equal(resetNativeTextMetadata(h.text),'before <strong>Token</strong> '+word+' after');
  assert.equal(undo(h.target),true);assert.equal(h.text,source);
 }
});

test('HTML boundary adjacency is allowed but touching either tag edge is rejected',()=>{
 const source='before <strong>inside</strong> after',htmlFrom=source.indexOf('<'),htmlTo=source.lastIndexOf('>')+1;
 for(const [from,to] of [[0,htmlFrom],[htmlTo,source.length]]) {
  const colored=applyNativeTextColor(source,from,to,'background',bg);
  assert.equal(scanNativeText(colored.text)[0].status,'valid');assert.equal(resetNativeTextMetadata(colored.text),source);
  for(const format of ['bold','italic','code'])assert.ok(formatNativeText(source,from,to,format).text.includes('<strong>inside</strong>'));
 }
 for(const [from,to] of [[0,htmlFrom+1],[htmlTo-1,source.length]]) {
  assert.throws(()=>applyNativeTextColor(source,from,to,'background',bg),/HTML/);
  for(const format of ['bold','italic','code'])assert.throws(()=>formatNativeText(source,from,to,format),/HTML/);
 }
});

test('format and recolor keep native Markdown and earlier colors',()=>{
 const colored=paint('- alpha and beta','alpha').text;
 const from=colored.indexOf('alpha');const bold=formatNativeText(colored,from,from+5,'bold');
 assert.ok(bold.text.startsWith('- **alpha** and beta'));assert.ok(!bold.text.includes('<span'));
 assert.equal(nativeTextColorRanges(bold.text).map(range=>bold.text.slice(range.from,range.to)).join(''),'alpha');
 const second=paint(bold.text,'beta','foreground',fg);assert.equal(scanNativeText(second.text)[0].ranges.length,2);
 const code=formatNativeText(second.text,second.text.indexOf('beta'),second.text.indexOf('beta')+4,'code');
 assert.ok(code.text.startsWith('- **alpha** and `beta`'));assert.equal(scanNativeText(code.text)[0].status,'valid');
});

test('strict legacy migration restores three inline codes with exact colors and source mapping',()=>{
 let old=fixture;for(const word of ['arr','brr','crr']){const at=old.indexOf(word);old=applyMarkdownColor(old,at,at+word.length,'background',bg).text;}
 const originalAt=old.indexOf('brr');const migrated=migrateOwnedTextToNative(old);
 assert.equal(migrated.count,3);assert.ok(migrated.text.startsWith(fixture));assert.equal(migrated.text.slice(migrated.map(originalAt),migrated.map(originalAt)+3),'brr');
 assert.deepEqual(nativeTextColorRanges(migrated.text).map(range=>migrated.text.slice(range.from,range.to)),['arr','brr','crr']);
 assert.equal(migrateOwnedTextToNative(migrated.text).text,migrated.text);
 assert.throws(()=>migrateOwnedTextToNative(old.replace('data-codex-code="1"','data-codex-code="1" onclick="bad"')));
 assert.throws(()=>restoreOwnedInline('<code data-codex-code="1"></code>'),/无损/);
});

function harness(doc,reverse=false){
 const filters=[nativeTextColorTransactions,nativeCodeColorTransactions];if(reverse)filters.reverse();
 let state=EditorState.create({doc,extensions:[history(),EditorState.allowMultipleSelections.of(true),...filters]});
 const target={get state(){return state;},dispatch:tr=>{state=tr.state;}};
 return {target,get state(){return state;},get text(){return state.doc.toString();},select(positions){state=state.update({selection:EditorSelection.create(positions.map(at=>EditorSelection.cursor(at)))}).state;},edit(changes,event='input.type'){state=state.update({changes,annotations:Transaction.userEvent.of(event)}).state;}};
}

test('both filter orders preserve mixed code/prose edits and exact single Undo/Redo',()=>{
 let source=paint('alpha\n\n```go\nvalue\n```\n\nafter','alpha').text;
 const at=source.indexOf('value');source=applyNativeCodeColor(source,at,at+5,'foreground',fg).text;
 for(const reverse of [false,true]) {
  const h=harness(source,reverse),a=source.indexOf('alpha')+2,v=source.indexOf('value')+2;
  h.select([a,v]);assert.equal(h.state.selection.ranges.length,2);
  h.edit([{from:a,insert:'X'},{from:v,insert:'Y'}]);
  const changed=h.text;assert.equal(scanNativeText(changed)[0].status,'valid');assert.equal(scanNativeCode(changed)[0].status,'valid');
  assert.ok(changed.startsWith('alXpha'));assert.ok(changed.includes('vaYlue'));
  assert.equal(undo(h.target),true);assert.equal(h.text,source);assert.equal(redo(h.target),true);assert.equal(h.text,changed);
 }
});

test('ordinary insertion/backspace retain colors while split/merge or external updates go inactive',()=>{
 const source=paint(fixture,'brr').text,at=source.indexOf('brr');
 const h=harness(source);h.edit({from:at+1,insert:'X'});assert.equal(scanNativeText(h.text)[0].status,'valid');
 h.edit({from:at+1,to:at+2},'delete.backward');assert.equal(h.text,source);
 const split=harness(paint('alpha beta','alpha').text);split.edit({from:5,insert:'\n\n'});assert.ok(!scanNativeText(split.text).some(block=>block.status==='valid'));
 const external=harness(source);external.edit({from:at,insert:'x'},'external');assert.equal(scanNativeText(external.text)[0].status,'stale');
});

test('Live Preview deletion guards preserve metadata and source mode/explicit selections remain operable',()=>{
 const source=paint('alpha\n\nafter','alpha').text,block=scanNativeText(source)[0];
 for(const live of [false,true]) {
  let state=EditorState.create({doc:source,selection:{anchor:block.to},extensions:[createNativeTextMetadataField(()=>live),nativeTextColorTransactions]});
  state=state.update({changes:{from:block.to,to:block.to+1},annotations:Transaction.userEvent.of('delete.forward')}).state;
  assert.equal(state.doc.toString()===source,live);
 }
 const state=EditorState.create({doc:source,selection:EditorSelection.range(0,block.metadataTo),extensions:[createNativeTextMetadataField(()=>true)]});
 const after=state.update({changes:{from:0,to:block.metadataTo},annotations:Transaction.userEvent.of('delete.selection')}).state;
 assert.equal(after.doc.toString(),'\n\nafter');
});


test('migration orders mixed foreground/background ranges by source position across blocks',()=>{
 let old='alpha\n\nbeta';
 for(const [word,property,color] of [['alpha','background',bg],['beta','foreground',fg],['alpha','foreground',fg],['beta','background',bg]]) {
  const at=old.indexOf(word);old=applyMarkdownColor(old,at,at+word.length,property,color).text;
 }
 const migrated=migrateOwnedTextToNative(old);
 const blocks=scanNativeText(migrated.text);assert.equal(blocks.length,2);
 assert.deepEqual(blocks.map(block=>[block.source,block.status,block.ranges.length]),[['alpha','valid',2],['beta','valid',2]]);
 assert.equal(resetNativeTextMetadata(migrated.text),'alpha\n\nbeta');
});


test('actual EditorView keeps inline selection plain and guards native Backspace/Delete',async()=>{
 const window=new Window(),saved=new Map(),views=[];
 const globals={window,document:window.document,MutationObserver:window.MutationObserver,HTMLElement:window.HTMLElement,Node:window.Node,DOMRect:window.DOMRect,getComputedStyle:window.getComputedStyle.bind(window),requestAnimationFrame:window.requestAnimationFrame.bind(window),cancelAnimationFrame:window.cancelAnimationFrame.bind(window)};
 for(const [key,value] of Object.entries(globals)){saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
 try {
  const source=paint(fixture,'brr').text+'\n\nafter',at=source.indexOf('brr');
  for(const reverse of [false,true]) {
   const filters=[nativeTextColorTransactions,nativeCodeColorTransactions];if(reverse)filters.reverse();
   const parent=window.document.createElement('div');window.document.body.appendChild(parent);
   const view=new EditorView({parent,state:EditorState.create({doc:source,selection:{anchor:at,head:at+3},extensions:[createNativeTextMetadataField(()=>true),...filters]})});views.push(view);
   const range=view.state.selection.main;assert.equal(view.state.sliceDoc(range.from,range.to),'brr','native clipboard selection contains no HTML or snapshot');
   view.dispatch({selection:{anchor:at+1}});assert.equal(deleteCharBackward(view),true);
   assert.equal(scanNativeText(view.state.doc.toString())[0].status,'valid');
   const before=view.state.doc.toString(),block=scanNativeText(before)[0];
   view.dispatch({selection:{anchor:block.to}});assert.equal(deleteCharForward(view),true);assert.equal(view.state.doc.toString(),before);
   view.dispatch({selection:{anchor:block.metadataTo}});assert.equal(deleteCharBackward(view),true);assert.equal(view.state.doc.toString(),before);
   view.dispatch({selection:{anchor:before.indexOf('after')}});assert.equal(deleteCharBackward(view),true);
   const oneBlankLess=view.state.doc.toString();assert.equal(oneBlankLess,before.replace('\n\nafter','\nafter'));
   assert.equal(deleteCharBackward(view),true);assert.equal(view.state.doc.toString(),oneBlankLess,'last separator after comment remains protected');
  }
 } finally {
  for(const view of views)view.destroy();await window.happyDOM.abort();
  for(const [key,descriptor] of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}
 }
});


test('reset damaged closing marker removes only its own line and retains following prose',()=>{
 const colored=paint('alpha\n\nafter\nnext','alpha').text;
 const damaged=colored.replace(' -->',' --');
 assert.equal(resetNativeTextMetadata(damaged),'alpha\n\nafter\nnext');
});


test('reading DOM aligns decoded entities, Setext heading and inline code to original offsets',()=>{
 const window=new Window();
 for(const [source,html,needle] of [['a &amp; b','<p>a &amp; b</p>','&amp;'],['title\n---','<h2>title</h2>','title'],['- `brr` and **bold**','<li><code>brr</code> and <strong>bold</strong></li>','brr']]) {
  const el=window.document.createElement('div');el.innerHTML=html;
  const projection=projectNativeMarkdown(source),alignment=alignRenderedText(projection,el.textContent);
  assert.ok(alignment);const visible=needle==='&amp;'?'&':needle;assert.equal(alignment[el.textContent.indexOf(visible)],source.indexOf(needle));
 }
});


test('adjacent colored code and prose migration preserves every first and last character',()=>{
 const span=value=>'<span data-codex-color="1" style="background-color:#fff88f">'+value+'</span>';
 const code=value=>'<code data-codex-code="1">'+span(value)+'</code>';
 const old='- '+code('arr')+span(' 和 ')+code('brr')+span(' 共享同一数组。')+'\n- '+span('两个变量。')+'\n- '+span('长度 ')+code('len')+span(' 不一样。');
 const migrated=migrateOwnedTextToNative(old),block=scanNativeText(migrated.text)[0];
 assert.equal(block.source,'- `arr` 和 `brr` 共享同一数组。\n- 两个变量。\n- 长度 `len` 不一样。');
 const projection=projectNativeMarkdown(block.source);
 for(let i=0;i<projection.text.length;i++) {
  const offset=projection.offsets[i];
  assert.ok(block.ranges.some(range=>range.property==='background'&&range.from<=offset&&range.to>offset),'missing color on '+JSON.stringify(projection.text[i])+' at '+offset);
 }
 assert.deepEqual(block.ranges.map(range=>block.source.slice(range.from,range.to)),['arr',' 和 ','brr',' 共享同一数组。','两个变量。','长度 ','len',' 不一样。']);
});


test('directly adjacent colored code islands fail closed when native delimiters would merge',()=>{
 const code=value=>'<code data-codex-code="1"><span data-codex-color="1" style="background-color:#fff88f">'+value+'</span></code>';
 const source='before '+code('arr')+code('brr')+' after';
 assert.throws(()=>migrateOwnedTextToNative(source),/改变可见文字/);
 assert.equal(source,'before '+code('arr')+code('brr')+' after');
});


test('metadata schema rejects malformed, noncanonical and overlapping ranges without discarding records',()=>{
 const range={from:0,to:1,property:'background',color:bg};
 for(const ranges of [null,[null],[{...range,extra:true}],[{...range,property:'border'}],[{...range,color:'red'}],[{...range,color:42}],[{...range,from:-1}],[{...range,to:0}],[{...range,from:0.5}],[range,range]]) {
  assert.throws(()=>encodeNativeTextMetadata('alpha',ranges),/范围无效/);
 }
 assert.throws(()=>encodeNativeTextMetadata('a'.repeat(200001),[]),/超限/);
 assert.throws(()=>encodeNativeTextMetadata('a',Array(10001).fill(range)),/超限/);
 assert.throws(()=>encodeNativeTextMetadata('a\r\nb',[{...range,from:2,to:4}]),/范围无效/);
 assert.throws(()=>encodeNativeTextMetadata('😀',[{...range,to:1}]),/范围无效/);
 assert.ok(encodeNativeTextMetadata('',[]).includes('"source":""'));
 const valid=encodeNativeTextMetadata('alpha',[range]);
 for(const raw of [valid.replace(':1 ',':2 '),valid.replace('{"version":1','{ "version":1'),valid.replace('"source":"alpha"','"source":42'),valid.replace('"ranges":','"extra":true,"ranges":'),'<!-- noteglow-text-colors:1 null -->','<!-- noteglow-text-colors:1 {broken} -->']) {
  const text='alpha\n\n'+raw;assert.equal(scanNativeText(text)[0].status,'invalid');
  assert.deepEqual(nativeTextColorRanges(text),[]);assert.throws(()=>applyNativeTextColor(text,0,1,'background',bg),/重置/);
  assert.equal(resetNativeTextMetadata(text),'alpha');
 }
});

test('selection ownership rejects invalid boundaries, metadata and syntax-only selections',()=>{
 const source=paint('alpha\n\nbeta','alpha').text;
 for(const [from,to] of [[-1,1],[0,0],[0,source.length+1],[source.indexOf('<!--'),source.indexOf('<!--')+4]]) assert.throws(()=>applyNativeTextColor(source,from,to,'background',bg));
 assert.throws(()=>applyNativeTextColor('**alpha**',0,2,'background',bg),/格式标签/);
 assert.throws(()=>applyNativeTextColor('alpha',0,1,'background'),/#RGB/);
 assert.throws(()=>applyNativeTextColor('alpha',0,1,'foreground','invalid'),/#RGB/);
 assert.deepEqual(scanNativeText('a'.repeat(1000001)),[]);
 assert.throws(()=>applyNativeTextColor('a'.repeat(1000001),0,1,'background',bg),/过大/);
 assert.deepEqual(scanNativeText('```go\nunclosed'),[]);
 assert.equal(applyNativeTextColor('alpha',0,5).text,'alpha','clearing an uncolored block is a no-op');
 const bold=formatNativeText('alpha',0,5,'bold');assert.equal(bold.text,'**alpha**');assert.equal(bold.text.includes('noteglow-text-colors'),false);
});

test('editing metadata itself or mixing metadata and prose never silently repairs user changes',()=>{
 const source=paint('alpha\n\nafter','alpha').text,block=scanNativeText(source)[0];
 const h=harness(source);
 h.edit([{from:1,insert:'X'},{from:block.commentFrom+5,insert:'!'}]);
 assert.ok(h.text.startsWith('aXlpha'));assert.ok(h.text.includes('<!-- !noteglow-text-colors:'));
 assert.ok(!scanNativeText(h.text).some(item=>item.status==='valid'));
 const corrupt=harness(source);const at=source.indexOf('"version":1')+'"version":'.length;
 corrupt.edit({from:at,to:at+1,insert:'2'});assert.equal(scanNativeText(corrupt.text)[0].status,'invalid');assert.ok(corrupt.text.includes('"version":2'));
 const outside=harness(source);outside.edit({from:source.length,insert:'!'});assert.equal(scanNativeText(outside.text)[0].status,'valid');assert.equal(scanNativeText(outside.text)[0].source,'alpha');
 const list=paint('- alpha\n- beta','alpha').text,indentation=harness(list);indentation.edit({from:list.indexOf('- beta'),insert:'  '},'indent');
 assert.ok(!scanNativeText(indentation.text).some(item=>item.status==='valid'),'container indentation changes fail closed');
});

test('Live Preview mode toggle changes only decorations and read-only commands preserve source',()=>{
 const mode=StateEffect.define(),live=StateField.define({create:()=>true,update:(value,tr)=>tr.effects.reduce((current,effect)=>effect.is(mode)?effect.value:current,value)});
 const field=createNativeTextMetadataField(state=>state.field(live));
 const source=paint('alpha','alpha').text;
 let state=EditorState.create({doc:source,extensions:[live,field,EditorState.readOnly.of(true)]});
 assert.equal(state.field(field).size,1);
 state=state.update({effects:mode.of(false)}).state;assert.equal(state.field(field).size,0);assert.equal(state.doc.toString(),source);
 state=state.update({effects:mode.of(true)}).state;assert.equal(state.field(field).size,1);
 const readonly={state,dispatch(){assert.fail('read-only command dispatched a write');}};
 assert.equal(deleteCharBackward(readonly),false);assert.equal(deleteCharForward(readonly),false);
 const stale=source.replace('alpha\n','changed\n');const staleState=EditorState.create({doc:stale,extensions:[live,field]});assert.equal(staleState.field(field).size,1);
 const invalidState=EditorState.create({doc:source.replace('"version":1','"version":2'),extensions:[live,field]});assert.equal(invalidState.field(field).size,0,'corrupt records remain visible for recovery');
});

test('migration refuses mixed legacy/native ownership and preserves identity mapping when already native',()=>{
 const native=paint('alpha','alpha').text;
 const identity=migrateOwnedTextToNative(native);assert.equal(identity.count,0);assert.equal(identity.map(native.length),native.length);
 const old='<span data-codex-color="1" style="color:#c0392b">beta</span>';
 assert.throws(()=>migrateOwnedTextToNative(native+'\n\n'+old),/同时包含/);
 const plainCode='before <code data-codex-code="1">value</code> after';
 const restored=migrateOwnedTextToNative(plainCode);assert.equal(restored.text,'before `value` after');assert.equal(restored.count,1);assert.equal(restored.text.includes('noteglow-text-colors'),false);
 const misplaced='alpha\n\n\n'+encodeNativeTextMetadata('alpha',[]);assert.equal(scanNativeText(misplaced)[0].status,'none');assert.deepEqual(nativeTextColorRanges(misplaced),[]);
});


// 功能矩阵：每种格式 × 先着色/后着色；按公开纯函数重走命令路径，不用源码正则代替行为。
test('bold italic and inline code independently toggle with both colors before or after formatting',()=>{
 const source='- alpha beta';
 for(const format of ['bold','italic','code']) for(const colorFirst of [false,true]) {
  let text=source;
  const colors=()=>{for(const [property,color] of [['foreground',fg],['background',bg]])text=paint(text,'alpha',property,color).text;};
  const toggle=()=>{const at=text.indexOf('alpha');text=formatNativeText(text,at,at+5,format).text;};
  if(colorFirst)colors();toggle();if(!colorFirst)colors();
  const reopened=JSON.parse(JSON.stringify(text));const block=scanNativeText(reopened)[0];
  assert.equal(block.status,'valid');assert.equal(block.ranges.length,2);
  for(const range of block.ranges)assert.equal(block.source.slice(range.from,range.to),'alpha');
  assert.ok(!reopened.includes('<span'));assert.ok(!reopened.includes('<code'));
  toggle();assert.equal(scanNativeText(text)[0].source,source,'cancel format preserves native text');
  assert.equal(nativeTextColorRanges(text).length,2,'cancel format preserves both colors');
  const at=text.indexOf('alpha');text=applyNativeTextColor(text,at,at+5).text;
  assert.equal(text,source,'clear removes only color record after format cancellation');
 }
});

test('bold plus italic nesting can be independently cancelled without losing colors',()=>{
 for(const order of [['bold','italic'],['italic','bold']]) {
  let text=paint(paint('- alpha beta','alpha','foreground',fg).text,'alpha').text;
  const toggle=format=>{const at=text.indexOf('alpha');text=formatNativeText(text,at,at+5,format).text;};
  for(const format of order)toggle(format);
  assert.equal(projectNativeMarkdown(scanNativeText(text)[0].source).text,'alpha beta');
  assert.equal(scanNativeText(text)[0].ranges.length,2);
  toggle(order[0]);assert.equal(scanNativeText(text)[0].ranges.length,2);
  toggle(order[1]);assert.equal(scanNativeText(text)[0].source,'- alpha beta');
  assert.deepEqual(nativeTextColorRanges(text).map(range=>text.slice(range.from,range.to)),['alpha','alpha']);
 }
});

test('native inline code inside bold is reversible; incompatible and partial-code operations refuse unchanged',()=>{
 let text=paint('**alpha** and beta','alpha').text;
 let at=text.indexOf('alpha');text=formatNativeText(text,at,at+5,'code').text;
 assert.equal(scanNativeText(text)[0].source,'**`alpha`** and beta');
 assert.equal(scanNativeText(text)[0].ranges.length,1);
 at=text.indexOf('alpha');
 for(const format of ['bold','italic'])assert.throws(()=>formatNativeText(text,at,at+5,format),/正文/);
 assert.throws(()=>formatNativeText(text,at+1,at+4,'code'),/完整/);
 const cancelled=formatNativeText(text,at,at+5,'code');assert.equal(scanNativeText(cancelled.text)[0].source,'**alpha** and beta');
 assert.equal(nativeTextColorRanges(cancelled.text).map(range=>cancelled.text.slice(range.from,range.to)).join(''),'alpha');
});

test('clear one word preserves bold italic code and neighboring foreground/background colors',()=>{
 let text='- **alpha** *beta* `gamma`';
 for(const word of ['alpha','beta','gamma'])for(const [property,color] of [['foreground',fg],['background',bg]])text=paint(text,word,property,color).text;
 const at=text.indexOf('beta'),cleared=applyNativeTextColor(text,at,at+4).text;
 assert.equal(scanNativeText(cleared)[0].source,'- **alpha** *beta* `gamma`');
 assert.deepEqual(nativeTextColorRanges(cleared).map(range=>cleared.slice(range.from,range.to)).sort(),['alpha','alpha','gamma','gamma']);
 assert.equal(scanNativeText(JSON.parse(JSON.stringify(cleared)))[0].status,'valid');
});

test('each native format color cancellation transaction has exact Undo and Redo state',()=>{
 let state=EditorState.create({doc:'- alpha beta',extensions:[history(),nativeTextColorTransactions,nativeCodeColorTransactions]});
 const target={get state(){return state;},dispatch:tr=>{state=tr.state;}};
 const snapshots=[state.doc.toString()];
 const change=create=>{const before=state.doc.toString(),at=before.indexOf('alpha'),result=create(before,at);state=state.update({changes:minimalTextChange(before,result.text),selection:{anchor:result.from,head:result.to},annotations:[isolateHistory.of('full'),Transaction.userEvent.of('input')]}).state;snapshots.push(state.doc.toString());assert.equal(state.doc.toString(),result.text);};
 change((text,at)=>formatNativeText(text,at,at+5,'bold'));
 change((text,at)=>formatNativeText(text,at,at+5,'italic'));
 change((text,at)=>applyNativeTextColor(text,at,at+5,'foreground',fg));
 change((text,at)=>applyNativeTextColor(text,at,at+5,'background',bg));
 change((text,at)=>formatNativeText(text,at,at+5,'italic'));
 change((text,at)=>formatNativeText(text,at,at+5,'code'));
 change((text,at)=>formatNativeText(text,at,at+5,'code'));
 change((text,at)=>applyNativeTextColor(text,at,at+5));
 for(let i=snapshots.length-2;i>=0;i--){assert.equal(undo(target),true);assert.equal(state.doc.toString(),snapshots[i]);}
 for(let i=1;i<snapshots.length;i++){assert.equal(redo(target),true);assert.equal(state.doc.toString(),snapshots[i]);}
});

test('public native entrypoints reject owned legacy HTML instead of producing new HTML',()=>{
 const old=applyMarkdownColor('alpha',0,5,'background',bg).text,at=old.indexOf('alpha');
 assert.throws(()=>applyNativeTextColor(old,at,at+5,'foreground',fg),/旧 HTML/);
 for(const format of ['bold','italic','code'])assert.throws(()=>formatNativeText(old,at,at+5,format),/旧 HTML/);
 assert.ok(old.includes('<span data-codex-color'));
});


test('cancelling outer italic preserves nested bold while partial selection never removes whole wrapper',()=>{
 const source=paint('***alpha***','alpha').text,at=source.indexOf('alpha');
 const cancelled=formatNativeText(source,at,at+5,'italic');assert.equal(scanNativeText(cancelled.text)[0].source,'**alpha**');
 const partial=formatNativeText(source,at+1,at+4,'italic');
 assert.notEqual(scanNativeText(partial.text)[0].source,'**alpha**');
 assert.equal(projectNativeMarkdown(scanNativeText(partial.text)[0].source).text,'alpha');
 assert.deepEqual(nativeTextColorRanges(cancelled.text).map(range=>cancelled.text.slice(range.from,range.to)),['alpha']);
});

test('repeat format applies without toggling existing full or partial format and preserves colors',()=>{
 for(const [format, source, selected] of [['bold','**alpha beta**','alpha'],['italic','*alpha beta*','alpha'],['code','`alpha beta`','alpha']]) {
  const from=source.indexOf(selected);
  assert.equal(formatNativeText(source,from,from+selected.length,format,true).text,source);
  const fullFrom=source.indexOf('alpha beta');
  assert.equal(formatNativeText(source,fullFrom,fullFrom+10,format,true).text,source);
 }
 for(const [format,expected] of [['bold','**alpha**'],['italic','*alpha*'],['code','`alpha`']]) {
  const plain=paint('alpha beta','alpha').text;
  const result=formatNativeText(plain,0,5,format,true);
  assert.ok(result.text.startsWith(expected+' beta'));
  assert.equal(scanNativeText(result.text)[0].status,'valid');
  assert.equal(nativeTextColorRanges(result.text).map(range=>result.text.slice(range.from,range.to)).join(''),'alpha');
  assert.equal(formatNativeText(result.text,result.from,result.to,format,true).text,result.text);
 }
 assert.throws(()=>formatNativeText('```\nalpha\n```',4,9,'bold',true));
 assert.throws(()=>formatNativeText('`alpha`',1,6,'italic',true));
 // 普通命令仍保留原来的切换语义。
 assert.equal(formatNativeText('**alpha**',2,7,'bold').text,'alpha');
});


test('repeat bold on a mixed formatted and plain selection preserves visible text or rejects before editing',()=>{
 const source='**Alpha** Beta';
 let result;
 try { result=formatNativeText(source,0,source.length,'bold',true); }
 catch(error) {
  assert.match(error.message,/格式操作将改变正文结构或代码文字|格式修改将改变段落结构/);
  return;
 }
 assert.equal(projectNativeMarkdown(result.text).text,'Alpha Beta');
 assert.equal(formatNativeText(result.text,result.from,result.to,'bold',true).text,result.text);
});


test('inserting a quote before hidden text metadata keeps the original color, user text and one Undo',()=>{
 const source=paint('alpha\n\nafter','alpha').text;
 const h=harness(source),at=source.indexOf('alpha')+5;
 h.edit({from:at,insert:'\n\n> user quote'});
 const changed=h.text,block=scanNativeText(changed)[0];
 assert.equal(block.status,'valid');assert.equal(block.source,'alpha');
 assert.deepEqual(block.ranges,[{from:0,to:5,property:'background',color:bg}]);
 assert.ok(changed.indexOf('noteglow-text-colors')<changed.indexOf('> user quote'));
 assert.equal(resetNativeTextMetadata(changed),'alpha\n\n> user quote\n\nafter');
 assert.equal(undo(h.target),true);assert.equal(h.text,source);
 assert.equal(redo(h.target),true);assert.equal(h.text,changed);
});

test('pure metadata relocation preserves CRLF offsets and every original visible byte',()=>{
 const source=paint('alpha\r\n\r\nafter','alpha').text;
 const insert='\r\n\r\n> user quote';
 // ChangeSet 使用原始字符串偏移；不通过默认会规范换行的 EditorState 构造文档。
 const changes=ChangeSet.of({from:5,insert},source.length,"\n");
 const after=source.slice(0,5)+insert+source.slice(5);
 const edits=nativeTextMetadataChanges(source,after,changes);
 assert.equal(edits.length,2);
 let result=after;
 for(const edit of [...edits].reverse()) result=result.slice(0,edit.from)+edit.insert+result.slice(edit.to);
 assert.equal(scanNativeText(result)[0].status,'valid');
 assert.equal(resetNativeTextMetadata(result),'alpha\r\n\r\n> user quote\r\n\r\nafter');
 assert.equal(result.replace(/\r\n/g,'' ).includes('\n'),false);
});

test('Enter first relocates the hidden record and maps the caret to the next visible line before quote typing',()=>{
 const source=paint('alpha','alpha').text;
 for(const enters of [1,2]) {
  let state=EditorState.create({doc:source,selection:{anchor:5},extensions:[history(),nativeTextColorTransactions,createNativeTextMetadataField(()=>true)]});
  // 每次 Enter 都是独立原生输入，不能用一次整块粘贴代替光标映射验收。
  for(let i=0;i<enters;i++) {
   state=state.update({...state.replaceSelection('\n'),annotations:Transaction.userEvent.of('input.type')}).state;
   assert.equal(scanNativeText(state.doc.toString())[0].status,'valid');
   assert.equal(state.selection.main.head,state.doc.length);
  }
  for(const character of '> user quote') state=state.update({...state.replaceSelection(character),annotations:Transaction.userEvent.of('input.type')}).state;
  assert.ok(state.doc.toString().endsWith('\n'.repeat(enters)+'> user quote'));
  assert.equal(scanNativeText(state.doc.toString())[0].status,'valid');
  assert.equal(nativeTextOwnedRecords(state.doc.toString()).length,1);
 }
});

test('explicit orphan repair crosses only local quotes, preserves original content and is idempotent',()=>{
 const colored=paint('alpha\n\nafter','alpha').text;
 const orphan=colored.replace('alpha\n\n<!--','alpha\n\n> user quote\n\n<!--');
 assert.equal(scanNativeText(orphan)[0].status,'none');
 const repaired=repairNativeTextMetadata(orphan);
 assert.equal(scanNativeText(repaired)[0].status,'valid');
 assert.equal(resetNativeTextMetadata(repaired),resetNativeTextMetadata(orphan));
 assert.equal(nativeTextDocumentShape(repaired),nativeTextDocumentShape(orphan));
 assert.equal(repairNativeTextMetadata(repaired),repaired);
 assert.ok(repaired.indexOf('noteglow-text-colors')<repaired.indexOf('> user quote'));
 const cleared=applyNativeTextColor(repaired,0,5).text;
 assert.equal(cleared,'alpha\n\n> user quote\n\nafter');
 const formatted=formatNativeText(repaired,0,5,'bold').text;
 assert.ok(formatted.startsWith('**alpha**'));assert.ok(formatted.includes('> user quote'));
});

test('orphan recovery refuses repeated snapshots, nonquote gaps, changed text and noncanonical records',()=>{
 const record=encodeNativeTextMetadata('alpha',[{from:0,to:5,property:'background',color:bg}]);
 for(const source of [
  'alpha\n\nalpha\n\n> quote\n\n'+record,
  'alpha\n\n> quote\n\n'+record+'\n\n'+record,
  'alpha\n\nbeta\n\n'+record,
  'alpha\n\n```\ncode\n```\n\n'+record,
  'alpha\n\n<div>html</div>\n\n'+record,
  'changed\n\n> quote\n\n'+record,
  'alpha\n\n> quote\n\n'+record.replace('"version":1','"version":2')
 ]) assert.equal(repairNativeTextMetadata(source),source);
});

test('Live Preview hides canonical orphan records without hiding code, YAML, quote or invalid text',()=>{
 const record=encodeNativeTextMetadata('alpha',[{from:0,to:5,property:'background',color:bg}]);
 const field=createNativeTextMetadataField(()=>true);
 const orphan='alpha\n\n> quote\n\n'+record;
 const state=EditorState.create({doc:orphan,extensions:[field]});
 assert.equal(state.field(field).size,1);assert.equal(state.doc.toString(),orphan);
 for(const source of ['```\n'+record+'\n```','---\nvalue: |\n  '+record+'\n---','> '+record,record.replace('"version":1','"version":2'),record+' user text']) {
  assert.equal(EditorState.create({doc:source,extensions:[field]}).field(field).size,0,source);
 }
});

test('quote insertion preserves independent native code metadata with either transaction filter order',()=>{
 let source=paint('alpha\n\n```go\nvalue\n```','alpha').text;
 const at=source.indexOf('value');source=applyNativeCodeColor(source,at,at+5,'foreground',fg).text;
 const expectedCode=scanNativeCode(source)[0];
 for(const reverse of [false,true]) {
  const h=harness(source,reverse);h.edit({from:5,insert:'\n\n> quote'});
  const code=scanNativeCode(h.text)[0];
  assert.equal(code.status,'valid');assert.equal(code.code,expectedCode.code);assert.deepEqual(code.ranges,expectedCode.ranges);
  assert.equal(scanNativeText(h.text)[0].status,'valid');
  assert.equal(undo(h.target),true);assert.equal(h.text,source);
 }
});

const tableFixture='| 场景 | 结果 |\n| --- | --- |\n| nil | 发送、接收和 `for range` 都会一直阻塞 |\n| other | unchanged |';
test('table colors share one record after the complete table and clear independently',()=>{
 let text=paint(tableFixture,'场景','foreground',fg).text;
 const from=text.indexOf('发送'),to=text.indexOf('阻塞')+2;
 text=applyNativeTextColor(text,from,to,'background',bg).text;
 assert.equal(nativeTextDocumentShape(text),nativeTextDocumentShape(tableFixture));
 assert.equal(text.slice(0,tableFixture.length),tableFixture);
 const blocks=scanNativeText(text);assert.equal(blocks.length,1);assert.equal(blocks[0].kind,'table');assert.equal(blocks[0].status,'valid');assert.equal(blocks[0].to,tableFixture.length);
 assert.deepEqual(nativeTextColorRanges(text).map(range=>[range.property,text.slice(range.from,range.to)]),[['background','发送、接收和 '],['background','for range'],['background',' 都会一直阻塞'],['foreground','场景']]);
 text=applyNativeTextColor(text,from,to).text;
 assert.deepEqual(nativeTextColorRanges(text).map(range=>text.slice(range.from,range.to)),['场景']);
 assert.equal(resetNativeTextMetadata(text),tableFixture);
});

for(const format of ['bold','italic'])test(`table mixed ${format} preserves inline code and both colors through toggle and repeat`,()=>{
 const from=tableFixture.indexOf('发送'),to=tableFixture.indexOf('阻塞')+2;
 let text=applyNativeTextColor(tableFixture,from,to,'background',bg).text;
 text=applyNativeTextColor(text,from,to,'foreground',fg).text;
 const result=formatNativeText(text,from,to,format),delimiter=format==='bold'?'**':'*';
 assert.ok(result.text.includes(`${delimiter}发送、接收和${delimiter} \`for range\` ${delimiter}都会一直阻塞${delimiter}`));
 assert.equal(projectNativeMarkdown(resetNativeTextMetadata(result.text)).text,projectNativeMarkdown(tableFixture).text);
 assert.equal(scanNativeText(result.text)[0].status,'valid');
 const projectedColors=value=>{const projection=projectNativeMarkdown(resetNativeTextMetadata(value)),ranges=nativeTextColorRanges(value);return projection.offsets.map(offset=>ranges.filter(range=>range.from<=offset&&range.to>offset).map(range=>[range.property,range.color]));};
 assert.deepEqual(projectedColors(result.text),projectedColors(text));
 const repeat=formatNativeText(result.text,result.from,result.to,format,true);assert.equal(repeat.text,result.text);
 const reverted=formatNativeText(result.text,result.from,result.to,format);assert.equal(reverted.text,text);
});

test('table code toggle preserves escaped pipes, entities and emoji without making another column',()=>{
 const source='| one | two |\n| --- | --- |\n| a\\|b &amp; 😀 | next |';
 const from=source.indexOf('a\\|b'),to=source.indexOf('😀')+2;
 const painted=applyNativeTextColor(source,from,to,'foreground',fg);
 const code=formatNativeText(painted.text,from,to,'code');
 assert.ok(code.text.includes('`a\\|b & 😀`'));assert.equal(scanNativeText(code.text)[0].cells.length,4);
 const restored=formatNativeText(code.text,code.from,code.to,'code');
 assert.equal(projectNativeMarkdown(resetNativeTextMetadata(restored.text)).text,projectNativeMarkdown(source).text);
 assert.equal(scanNativeText(restored.text)[0].status,'valid');
 assert.throws(()=>applyNativeTextColor(code.text,code.text.indexOf('\\|')+1,code.text.indexOf('\\|')+2,'background',bg),/实体/);
});

test('table selection rejects separators and empty cells for all actions',()=>{
 const ranges=[[tableFixture.indexOf('---'),tableFixture.indexOf('---')+3],[0,1]];
 for(const [start,end] of ranges){
  assert.throws(()=>applyNativeTextColor(tableFixture,start,end,'background',bg),/单元格/);
  for(const format of ['bold','italic','code'])assert.throws(()=>formatNativeText(tableFixture,start,end,format),/单元格/);
 }
 const empty='| a | b |\n| --- | --- |\n|  | c |',at=empty.lastIndexOf('|  |')+1;
 assert.throws(()=>applyNativeTextColor(empty,at,at+1,'background',bg),/单元格/);
 // 正文与表格统一保留行内代码，仅对普通文字设置格式。
 assert.equal(formatNativeText('text `code` tail',0,16,'bold').text,'**text** `code` **tail**');
});

test('ordinary table typing updates ranges in one transaction and undo restores exact metadata',()=>{
 const colored=paint(tableFixture,'阻塞').text,h=harness(colored),at=colored.indexOf('阻塞');
 h.edit({from:at,to:at,insert:'始终'});
 assert.equal(scanNativeText(h.text)[0].status,'valid');assert.deepEqual(nativeTextColorRanges(h.text).map(range=>h.text.slice(range.from,range.to)),['阻塞']);
 assert.equal(undo(h.target),true);assert.equal(h.text,colored);assert.equal(redo(h.target),true);assert.equal(scanNativeText(h.text)[0].status,'valid');
});

test('table reading projection excludes pipes, alignment markers, links and metadata',()=>{
 const source='| Label | Value |\n| :--- | ---: |\n| [same](https://example.test) | `same` |';
 const from=source.lastIndexOf('same'),text=applyNativeTextColor(source,from,from+4,'background',bg).text;
 const projection=projectNativeMarkdown(source),alignment=alignRenderedText(projection,'\nLabel\nValue\nsame\nsame\n');
 assert.ok(alignment);const rendered='\nLabel\nValue\nsame\nsame\n',at=rendered.lastIndexOf('same');
 assert.deepEqual(alignment.slice(at,at+4),[from,from+1,from+2,from+3]);assert.equal(nativeTextColorRanges(text)[0].from,from);
});

for(const [format,delimiter] of [['bold','**'],['italic','*']])test(`table toggles existing encompassing ${format} without duplicating delimiters`,()=>{
 const phrase='发送、接收和 `for range` 都会一直阻塞',source=`| 场景 | 结果 |\n| --- | --- |\n| nil | ${delimiter}${phrase}${delimiter} |`;
 const from=source.indexOf('发送'),to=source.indexOf('阻塞')+2;
 const colored=applyNativeTextColor(source,from,to,'background',bg).text;
 assert.equal(formatNativeText(colored,from,to,format,true).text,colored);
 const changed=formatNativeText(colored,from,to,format);
 assert.equal(resetNativeTextMetadata(changed.text),source.replace(delimiter+phrase+delimiter,phrase));
 assert.equal(scanNativeText(changed.text)[0].status,'valid');
 const projection=projectNativeMarkdown(resetNativeTextMetadata(changed.text)),ranges=nativeTextColorRanges(changed.text);
 const selected=projection.offsets.filter(offset=>offset>=changed.text.indexOf('发送')&&offset<changed.text.indexOf('阻塞')+2);
 assert.ok(selected.every(offset=>ranges.some(range=>range.from<=offset&&range.to>offset&&range.property==='background'&&range.color===bg)));
});

test('table bold and italic composition toggles independently around existing code',()=>{
 const phrase='发送、接收和 `for range` 都会一直阻塞';
 for(const initial of [phrase,`**${phrase}**`,`*${phrase}*`]){
  let text=`| 场景 | 结果 |\n| --- | --- |\n| nil | ${initial} |`;
  const original=text,from=text.indexOf('发送'),to=text.indexOf('阻塞')+2;
  text=applyNativeTextColor(text,from,to,'background',bg).text;
  const first=initial.startsWith('**')?'italic':'bold',second=first==='bold'?'italic':'bold';
  const apply=(value,format)=>formatNativeText(value,value.indexOf('发送'),value.indexOf('阻塞')+2,format).text;
  const once=apply(text,first),twice=initial===phrase?apply(once,second):once,restored=apply(initial===phrase?apply(twice,second):twice,first);
  assert.equal(resetNativeTextMetadata(restored),original);
  for(const value of [once,twice,restored]){assert.equal(scanNativeText(value)[0].status,'valid');assert.ok(value.includes('`for range`'));assert.equal(projectNativeMarkdown(resetNativeTextMetadata(value)).text,projectNativeMarkdown(original).text);}
 }
});

for(const [format,delimiter] of [['bold','**'],['italic','*']])for(const phrase of ['hello `code`','`code` hello'])test(`table visible selection toggles encompassing ${format} with code at ${phrase.startsWith('`')?'start':'end'}`,()=>{
 const source=`| one | two |\n| --- | --- |\n| ${delimiter}${phrase}${delimiter} | unchanged |`;
 const from=source.indexOf(phrase)+(phrase.startsWith('`')?1:0),to=source.indexOf(phrase)+phrase.length-(phrase.endsWith('`')?1:0);
 const colored=applyNativeTextColor(source,from,to,'foreground',fg).text;
 assert.equal(formatNativeText(colored,from,to,format,true).text,colored);
 const changed=formatNativeText(colored,from,to,format);
 assert.equal(resetNativeTextMetadata(changed.text),source.replace(delimiter+phrase+delimiter,phrase));
 assert.equal(scanNativeText(changed.text)[0].status,'valid');
 const projection=projectNativeMarkdown(resetNativeTextMetadata(changed.text)),ranges=nativeTextColorRanges(changed.text);
 const start=changed.text.indexOf(phrase)+(phrase.startsWith('`')?1:0),end=changed.text.indexOf(phrase)+phrase.length-(phrase.endsWith('`')?1:0);
 assert.ok(projection.offsets.filter(offset=>offset>=start&&offset<end).every(offset=>ranges.some(range=>range.from<=offset&&range.to>offset&&range.property==='foreground'&&range.color===fg)));
});


test('host table alignment remaps existing colors without a user-event and undo restores exact bytes',()=>{
 const source='before\n\n| one | two |\n| --- | --- |\n| alpha | `same` |\n\nafter';
 const colored=paint(source,'same').text,block=scanNativeText(colored).find(block=>block.kind==='table');
 const aligned=block.source.replaceAll('| ', '|   ').replaceAll(' |','   |').replaceAll('---','------');
 const h=harness(colored);h.edit({from:block.from,to:block.to,insert:aligned},'');
 assert.equal(scanNativeText(h.text).find(block=>block.kind==='table').status,'valid');
 assert.deepEqual(nativeTextColorRanges(h.text).map(range=>h.text.slice(range.from,range.to)),['same']);
 assert.equal(isNativeTableNormalization(colored,h.text),true);
 assert.equal(undo(h.target),true);assert.equal(h.text,colored);assert.equal(redo(h.target),true);assert.equal(isNativeTableNormalization(colored,h.text),true);
 for(const altered of [h.text.replace('after','later'),h.text.replace('alpha','other'),h.text.replace('`same`','**same**')])assert.equal(isNativeTableNormalization(colored,altered),false);
});

test('table normalization refuses changed cell syntax and altered colors even with identical visible text',()=>{
 const source='| one | two |\n| --- | --- |\n| **same** | other |';
 assert.equal(isNativeTableNormalization(source,source.replace('**same**','__same__')),false);
 const painted=paint(source,'same').text;
 assert.equal(isNativeTableNormalization(painted,paint(source,'same','foreground',fg).text),false);
 assert.equal(isNativeTableNormalization('paragraph','paragraph'),false);
 const block=scanNativeText(painted)[0],h=harness(painted);
 h.edit({from:block.from,to:block.to,insert:block.source.replace('**same**','__same__')},'');
 assert.equal(scanNativeText(h.text)[0].status,'stale');
});

test('table cell projection uses anchored row and column instead of matching duplicate text',()=>{
 const source='before\n\n| same | same |\n| --- | --- |\n|  | `same` |\n\n| same | same |\n| --- | --- |';
 const anchor=source.indexOf('| same'),cell=nativeTableCell(source,anchor,1,1);
 assert.ok(cell);assert.equal(source.slice(cell.from,cell.to),'`same`');assert.equal(cell.projection.text,'same');
 assert.equal(cell.projection.offsets[0],source.indexOf('`same`')+1);
 assert.equal(nativeTableCell(source,anchor,1,0),null);assert.equal(nativeTableCell(source,0,1,1),null);assert.equal(nativeTableCell(source,anchor,5,1),null);assert.equal(nativeTableCell(source,anchor,-1,0),null);
});

test('active table editor maps only exact source and escaped-pipe transformations',()=>{
 assert.deepEqual(nativeTableEditorOffsets('**a** `b`','**a** `b`',20),Array.from({length:9},(_,i)=>20+i));
 assert.deepEqual(nativeTableEditorOffsets('a\\|b','a|b',10),[10,11,13]);
 assert.deepEqual(nativeTableEditorOffsets('a\\\\|b','a\\\\|b',10),[10,11,12,13,14]);
 assert.equal(nativeTableEditorOffsets('same','different',0),null);
});

for(const format of ['bold','italic'])test(`table rectangle ${format} applies uniformly then removes while preserving code-only cells`,()=>{
 const marker=format==='bold'?'**':'*',source=`| a | b | c |\n| :--- | ---: | --- |\n| ${marker}one${marker} | same | keep |\n| plain | \`only\` | keep |`;
 const coords=[{row:1,column:0},{row:1,column:1},{row:2,column:0},{row:2,column:1}],cells=nativeTableSelectedCells(source,0,coords);
 const first=formatNativeText(source,cells[0].from,cells.at(-1).to,format,false,cells);
 assert.ok(first.text.includes(`| ${marker}one${marker} | ${marker}same${marker} | keep |`));assert.ok(first.text.includes(`| ${marker}plain${marker} | \`only\` | keep |`));
 const nextCells=nativeTableSelectedCells(first.text,0,coords),second=formatNativeText(first.text,nextCells[0].from,nextCells.at(-1).to,format,false,nextCells);
 assert.equal(second.text,source.replace(marker+'one'+marker,'one'));
 const h=harness(source),change=minimalTextChange(source,first.text);h.edit({from:change.from,to:change.to,insert:change.insert});assert.equal(undo(h.target),true);assert.equal(h.text,source);
});

test('table rectangle colors retain empty cells, unselected duplicates and both properties through clear',()=>{
 const source='before\n\n| a | b | c |\n| --- | :---: | ---: |\n| same |  | same |\n| same | word | same |\n\nafter',anchor=source.indexOf('| a');
 const coords=[{row:1,column:0},{row:1,column:1},{row:2,column:0},{row:2,column:1}],cells=nativeTableSelectedCells(source,anchor,coords),from=cells[0].from,to=cells.at(-1).to;
 assert.equal(cells.length,3);
 let text=applyNativeTextColor(source,from,to,'background',bg,cells).text;text=applyNativeTextColor(text,from,to,'foreground',fg,cells).text;
 assert.equal(resetNativeTextMetadata(text),source);assert.equal(scanNativeText(text).filter(block=>block.status==='valid').length,1);
 const covered=nativeTextColorRanges(text);assert.equal(covered.length,6);assert.ok(covered.every(range=>cells.some(cell=>cell.from<=range.from&&cell.to>=range.to)));
 assert.equal(applyNativeTextColor(text,from,to,undefined,undefined,cells).text,source);
 assert.equal(nativeTableSelectedCells(source,0,coords),null);assert.equal(nativeTableSelectedCells(source,anchor,[coords[0],coords[3]]),null);
 assert.equal(resetNativeTextMetadata(applyNativeTextColor(source,from,source.length,'background',bg).text),source);
});

test('source cross-row selection formats each cell and code batch failure is atomic',()=>{
 const source='| a | b |\n| --- | --- |\n| one | two |\n| three | four |',from=source.indexOf('one'),to=source.indexOf('four')+4;
 const result=formatNativeText(source,from,to,'code');assert.equal(result.text,source.replace('one','`one`').replace('two','`two`').replace('three','`three`').replace('four','`four`'));
 const mixed=source.replace('four','text `code`');assert.throws(()=>formatNativeText(mixed,from,mixed.lastIndexOf('|')-1,'code'),/代码|连续/);
 const only='| a | b |\n| --- | --- |\n| `one` | `two` |';assert.throws(()=>formatNativeText(only,only.indexOf('`one`'),only.indexOf('`two`')+5,'bold'),/正文/);
});

for(const [format,marker] of [['bold','**'],['italic','*']])test(`table aggregate ${format} handles adjacent wrappers without touching partial ancestors`,()=>{
 const source=`| a | b |\n| --- | --- |\n| ${marker}one${marker} ${marker}two${marker} | ${marker}three${marker} |`,from=source.indexOf(marker+'one'),to=source.lastIndexOf('|')-1;
 const off=formatNativeText(source,from,to,format);assert.equal(off.text,source.replaceAll(marker,''));
 const mixed=source.replace(marker+'two'+marker,'two'),on=formatNativeText(mixed,mixed.indexOf(marker+'one'),mixed.lastIndexOf('|')-1,format);
 assert.equal(on.text,source);
 const partial=source.indexOf('one')+1;assert.throws(()=>formatNativeText(source,partial,to,format),/完整选择/);
});

test('batch with one mixed prose cell and one code-only cell retains aggregate apply semantics',()=>{
 const source='| a | b |\n| --- | --- |\n| **one** two | `only` |',coords=[{row:1,column:0},{row:1,column:1}],cells=nativeTableSelectedCells(source,0,coords);
 const result=formatNativeText(source,cells[0].from,cells.at(-1).to,'bold',false,cells);
 assert.equal(result.text,source.replace('two','**two**'));
});

for(const [format,marker] of [['bold','**'],['italic','*']])test(`batch ${format} removal preserves independently formatted inline code`,()=>{
 const source=`| a | b |\n| --- | --- |\n| ${marker}one${marker} ${marker}\`code\`${marker} | ${marker}two${marker} |`,coords=[{row:1,column:0},{row:1,column:1}],cells=nativeTableSelectedCells(source,0,coords);
 const result=formatNativeText(source,cells[0].from,cells.at(-1).to,format,false,cells);
 assert.equal(result.text,source.replace(marker+'one'+marker,'one').replace(marker+'two'+marker,'two'));
});

for(const [format,marker] of [['bold','**'],['italic','*']])test(`continuous paragraphs headings lists and table use uniform ${format} and preserve inline code`,()=>{
 const source=`${marker}first${marker} \`code\` tail\n\n# heading\n\n- item one\n- item two\n\n| a | b |\n| --- | --- |\n| cell | value |`;
 const result=formatNativeText(source,0,source.length,format);
 assert.ok(result.text.startsWith(`${marker}first${marker} \`code\` ${marker}tail${marker}`));
 assert.ok(result.text.includes(`# ${marker}heading${marker}`));assert.ok(result.text.includes(`- ${marker}item one${marker}\n- ${marker}item two${marker}`));
 assert.ok(result.text.includes(`| ${marker}cell${marker} | ${marker}value${marker} |`));
 const off=formatNativeText(result.text,result.from,result.to,format);assert.equal(off.text,source.replace(marker+'first'+marker,'first'));
 const h=harness(source),change=minimalTextChange(source,result.text);h.edit({from:change.from,to:change.to,insert:change.insert});assert.equal(undo(h.target),true);assert.equal(h.text,source);
});

test('cross-paragraph colors preserve partial endpoints, own metadata and unselected text',()=>{
 const source='before alpha\n\n# heading\n\nomega after',from=source.indexOf('alpha'),to=source.indexOf('omega')+5;
 let result=applyNativeTextColor(source,from,to,'background',bg);
 assert.equal(resetNativeTextMetadata(result.text),source);assert.equal(scanNativeText(result.text).filter(block=>block.status==='valid').length,3);
 assert.deepEqual(nativeTextColorRanges(result.text).map(range=>result.text.slice(range.from,range.to)),['alpha','heading','omega']);
 result=applyNativeTextColor(result.text,result.from,result.to,'foreground',fg);
 assert.equal(scanNativeText(result.text).filter(block=>block.status==='valid').length,3);
 assert.equal(applyNativeTextColor(result.text,result.from,result.to).text,source);
});

test('cross-block native code toggles per paragraph and protected gaps reject the entire operation',()=>{
 const source='one\n\ntwo',coded=formatNativeText(source,0,source.length,'code');assert.equal(coded.text,'`one`\n\n`two`');
 assert.equal(formatNativeText(coded.text,coded.from,coded.to,'code').text,source);
 for(const middle of ['> quote','```js\ncode\n```','<div>html</div>','---']){
  const protectedSource='one\n\n'+middle+'\n\ntwo';
  assert.throws(()=>applyNativeTextColor(protectedSource,0,protectedSource.length,'background',bg),/不支持/);
  assert.throws(()=>formatNativeText(protectedSource,0,protectedSource.length,'bold'),/不支持/);
 }
 const unsafe='one\n\ntext `code`';assert.throws(()=>formatNativeText(unsafe,0,unsafe.length,'code'),/连续/);
});

test('cross-block formatting preserves existing colors and rejects stale later block before any output',()=>{
 let source=applyNativeTextColor('one\n\ntwo',0,3,'foreground',fg).text;source=applyNativeTextColor(source,source.lastIndexOf('two'),source.lastIndexOf('two')+3,'background',bg).text;
 const last=scanNativeText(source).find(block=>block.source==='two');assert.ok(last);
 const result=formatNativeText(source,0,last.to,'bold');assert.equal(scanNativeText(result.text).filter(block=>block.status==='valid').length,2);
 assert.deepEqual(nativeTextColorRanges(result.text).map(range=>result.text.slice(range.from,range.to)),['one','two']);
 const stale=source.replace('two\n','changed\n');assert.throws(()=>formatNativeText(stale,0,stale.lastIndexOf('changed')+7,'bold'),/过期/);
});

for(const [format,marker] of [['bold','**'],['italic','*']])test(`partial cross-paragraph ${format} preserves endpoints and colored code through repeat and off`,()=>{
 const plain='prefix alpha `code` tail\n\nsecond paragraph\n\nlast omega。 suffix';
 let text=applyNativeTextColor(plain,plain.indexOf('code'),plain.indexOf('code')+4,'background',bg).text;
 const from=text.indexOf('alpha'),to=text.lastIndexOf('omega')+5;
 text=applyNativeTextColor(text,from,to,'foreground',fg).text;
 const end=text.indexOf('omega')+5,first=formatNativeText(text,from,end,format);
 assert.equal(resetNativeTextMetadata(first.text),`prefix ${marker}alpha${marker} \`code\` ${marker}tail${marker}\n\n${marker}second paragraph${marker}\n\n${marker}last omega${marker}。 suffix`);
 const colors=value=>{const projection=projectNativeMarkdown(resetNativeTextMetadata(value)),rawProjection=projectNativeMarkdown(value),ranges=nativeTextColorRanges(value);return {text:projection.text,colors:rawProjection.offsets.map(offset=>ranges.filter(range=>range.from<=offset&&range.to>offset).map(range=>[range.property,range.color]))};};
 assert.deepEqual(colors(first.text),colors(text));
 const repeat=formatNativeText(first.text,first.from,first.to,format,true);assert.equal(repeat.text,first.text);
 const off=formatNativeText(first.text,first.from,first.to,format);assert.equal(off.text,text);assert.deepEqual(colors(off.text),colors(text));
 assert.ok(resetNativeTextMetadata(off.text).startsWith('prefix alpha'));assert.ok(resetNativeTextMetadata(off.text).endsWith('omega。 suffix'));
});
