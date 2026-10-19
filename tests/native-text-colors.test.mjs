import assert from 'node:assert/strict';
import test from 'node:test';
import {EditorState,EditorSelection,Transaction,StateField,StateEffect} from '@codemirror/state';
import {history,undo,redo,isolateHistory,deleteCharBackward,deleteCharForward} from '@codemirror/commands';
import {EditorView} from '@codemirror/view';
import {Window} from 'happy-dom';
import {applyNativeTextColor,formatNativeText,scanNativeText,nativeTextColorRanges,nativeTextColorTransactions,migrateOwnedTextToNative,resetNativeTextMetadata,encodeNativeTextMetadata,createNativeTextMetadataField} from '../src/native-text-colors.ts';
import {applyNativeCodeColor,nativeCodeColorTransactions,scanNativeCode,minimalTextChange} from '../src/native-code-colors.ts';
import {applyMarkdownColor,nativeTextDocumentShape,restoreOwnedInline,projectNativeMarkdown} from '../src/markdown-colors.ts';
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

test('selection ownership rejects cross-block, metadata and syntax-only selections',()=>{
 const source=paint('alpha\n\nbeta','alpha').text;
 for(const [from,to] of [[-1,1],[0,0],[0,source.length+1],[0,source.length],[source.indexOf('<!--'),source.indexOf('<!--')+4]]) assert.throws(()=>applyNativeTextColor(source,from,to,'background',bg));
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
 for(const format of ['bold','italic'])assert.throws(()=>formatNativeText(text,at,at+5,format),/先取消代码/);
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
