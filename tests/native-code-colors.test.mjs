import assert from 'node:assert/strict';
import test from 'node:test';
import {EditorState,Transaction,ChangeSet,StateField,StateEffect} from '@codemirror/state';
import {EditorView} from '@codemirror/view';
import {history,undo,redo,deleteCharBackward,deleteCharForward} from '@codemirror/commands';
import {Window} from 'happy-dom';
import {applyNativeCodeColor,encodeNativeCodeMetadata,scanNativeCode,minimalTextChange,nativeMetadataChanges,nativeCodeColorTransactions,paintNativeCodeElement,migrateOwnedCodeToNative,mapMigratedCodePosition,backupNativeCodeMigration,nativeMetadataHiddenRanges,createNativeMetadataField} from '../src/native-code-colors.ts';
import {applyMarkdownColor,decodeOwnedCodeBlocks} from '../src/markdown-colors.ts';
const bg='#fff88f',fg='#c0392b';
const paint=(source,word,property='background',color=bg)=>{const from=source.indexOf(word);assert.ok(from>=0);return applyNativeCodeColor(source,from,from+word.length,property,color);};
function stateHarness(source){
 let state=EditorState.create({doc:source,extensions:[history(),nativeCodeColorTransactions]});
 const target={get state(){return state;},dispatch(transaction){state=transaction.state;}};
 return {target,get text(){return state.doc.toString();},edit(from,to,insert,userEvent='input.type'){state=state.update({changes:{from,to,insert},annotations:Transaction.userEvent.of(userEvent)}).state;}};
}

test('three colors preserve fence info, exact CRLF, blanks, entities and source selection',()=>{
 const original='before\r\n\r\n~~~~go extra info  \r\nupdate(a)\r\nupdatePtr(&a) // &amp; 😀 -->\r\n\r\n~~~~  \r\n\r\nafter';
 const first=paint(original,'update(a)');
 assert.equal(first.text.slice(0,original.indexOf('\r\n\r\nafter')+2),original.slice(0,original.indexOf('\r\n\r\nafter')+2));
 assert.equal(first.text.slice(first.from,first.to),'update(a)');
 const second=paint(first.text,'&a');const third=paint(second.text,'updatePtr','foreground',fg);
 const block=scanNativeCode(third.text)[0];assert.equal(block.status,'valid');assert.equal(block.code,'update(a)\r\nupdatePtr(&a) // &amp; 😀 -->\r\n\r\n');
 assert.equal(block.ranges.length,3);assert.ok(third.text.endsWith('\r\nafter'));assert.ok(third.text.includes('~~~~go extra info  \r\n'));
 const metadata=third.text.slice(block.commentFrom,block.metadataTo);assert.equal((metadata.match(/-->/g)||[]).length,1);assert.ok(metadata.includes('\\u002d\\u002d\\u003e'));
 const cleared=applyNativeCodeColor(third.text,second.from,second.to);assert.equal(scanNativeCode(cleared.text)[0].ranges.length,2);
});

test('clear removes metadata and preserves original EOF shape',()=>{
 for(const original of ['```go\na\n```','```go\na\n```\n','```go\r\na\r\n```\r\n']) {
  const colored=paint(original,'a');const cleared=applyNativeCodeColor(colored.text,colored.from,colored.to);
  assert.equal(cleared.text,original);
 }
 const original='```go\na\n```\n';
 const from=original.indexOf('a');assert.equal(applyNativeCodeColor(original,from,from+1).text,original);
});

test('metadata is adjacent, versioned, bounded and snapshot-checked without global text lookup',()=>{
 const original='```go\nrepeat\n```\n';const colored=paint(original,'repeat').text;
 const stale=colored.replace('repeat\n```','changed\n```');assert.equal(scanNativeCode(stale)[0].status,'stale');
 assert.throws(()=>paint(stale,'changed'),/过期/);assert.ok(stale.includes('noteglow-code-colors'));
 const detached=colored.replace('```\n<!--','```\n\n<!--');assert.equal(scanNativeCode(detached)[0].status,'none');
 const second=original+'\n'+colored;const blocks=scanNativeCode(second);assert.equal(blocks[0].status,'none');assert.equal(blocks[1].status,'valid');
 for(const mutated of [colored.replace('colors:1','colors:9'),colored.replace('"version":1','"version":2'),colored.replace('"from":0','"from":-1'),colored.replace('"ranges":','"extra":1,"ranges":'),colored.replace('"code":"repeat\\n"','"code":42'),colored.replace('"color":"#fff88f"','"color":"red"')]) {
  assert.equal(scanNativeCode(mutated)[0].status,'invalid');assert.throws(()=>paint(mutated,'repeat'),/损坏/);
 }
 assert.throws(()=>applyNativeCodeColor(colored,colored.indexOf('<!--')+5,colored.indexOf('<!--')+10),/元数据/);
 assert.deepEqual(scanNativeCode('x'.repeat(1_000_001)),[]);
 assert.throws(()=>encodeNativeCodeMetadata('x'.repeat(200_001),[]),/超限/);
 assert.throws(()=>encodeNativeCodeMetadata('ab',[{from:0,to:2,property:'background',color:bg},{from:1,to:2,property:'background',color:bg}]),/无效/);
});

test('unsupported nested, indented, unclosed and cross-domain selections fail explicitly',()=>{
 for(const source of ['> ```go\n> value\n> ```\n','- item\n\n  ```go\n  value\n  ```\n','    value\n','```go\nvalue',' ```go\n value\n ```']) assert.throws(()=>paint(source,'value'),/顶层/);
 const source='before\n\n```go\nvalue 😀\n```\n\nafter';
 assert.throws(()=>applyNativeCodeColor(source,0,source.indexOf('value')+2,'background',bg),/跨代码块/);
 assert.equal(applyNativeCodeColor(source,0,6,'background',bg),null);
 const emoji=source.indexOf('😀');assert.throws(()=>applyNativeCodeColor(source,emoji,emoji+1,'background',bg),/emoji/);
 assert.throws(()=>paint(source,'value','background','red'),/#RGB/);
});

test('plain paragraph color coexists with unchanged native code and metadata',()=>{
 const native=paint('hello\n\n```go\na & b\n```\n','a & b').text;
 const before=scanNativeCode(native)[0];const edit=applyMarkdownColor(native,0,5,'foreground',fg);
 const after=scanNativeCode(edit.text)[0];assert.equal(after.status,'valid');assert.equal(after.code,before.code);assert.deepEqual(after.ranges,before.ranges);
 assert.equal(edit.text.slice(after.commentFrom,after.metadataTo),native.slice(before.commentFrom,before.metadataTo));
});

test('minimal replacement never splits surrogate pairs or CRLF',()=>{
 for(const [before,after] of [['a😀b','a😁b'],['a\r\nb','a\nb'],['same','same'],['','new'],['old','']]) {
  const change=minimalTextChange(before,after);assert.equal(before.slice(0,change.from)+change.insert+before.slice(change.to),after);
  assert.ok(!(/[\uD800-\uDBFF]$/.test(before.slice(0,change.from))));assert.ok(!(before[change.from-1]==='\r'&&before[change.from]==='\n'));
 }
});

test('native CM code edits and metadata share one Undo/Redo transaction',()=>{
 const initial=paint('```go\nalpha beta\n```\n','alpha').text;
 const harness=stateHarness(initial),at=harness.text.indexOf('alpha')+2;
 harness.edit(at,at,'X');const changed=harness.text;const block=scanNativeCode(changed)[0];
 assert.equal(block.status,'valid');assert.equal(block.code,'alXpha beta\n');assert.deepEqual(block.ranges,[{from:0,to:6,property:'background',color:bg}]);
 assert.equal(undo(harness.target),true);assert.equal(harness.text,initial);assert.equal(redo(harness.target),true);assert.equal(harness.text,changed);
});

test('CM deletion clips ranges; external edits and altered metadata remain inactive',()=>{
 const initial=paint('```go\nalpha beta\n```\n','alpha').text;
 const harness=stateHarness(initial),from=harness.text.indexOf('alpha');harness.edit(from,from+5,'','delete.selection');
 assert.equal(scanNativeCode(harness.text)[0].status,'valid');assert.deepEqual(scanNativeCode(harness.text)[0].ranges,[]);
 const external=stateHarness(initial);external.edit(from,from+1,'X','external');assert.equal(scanNativeCode(external.text)[0].status,'stale');
 const malformed=initial.replace('"version":1','"version":9'),bad=stateHarness(malformed);bad.edit(from,from+1,'X');assert.equal(scanNativeCode(bad.text)[0].status,'invalid');
 const plain=stateHarness('abc');plain.edit(1,1,'x');assert.equal(plain.text,'axbc');
});

test('CM filter preserves fence edits, adjacent metadata and EOF metadata newline shape',()=>{
 const initial=paint('```go\nalpha\n```\n','alpha').text.trimEnd();
 const at=initial.indexOf('alpha')+1,changes=ChangeSet.of([{from:at,insert:'X'}],initial.length),after=changes.apply(EditorState.create({doc:initial}).doc).toString();
 const edits=nativeMetadataChanges(initial,after,changes);assert.equal(edits.length,1);assert.ok(edits[0].insert.endsWith('-->'));
 const corrupt=ChangeSet.of([{from:at,insert:'X'},{from:initial.indexOf('"version":1')+10,to:initial.indexOf('"version":1')+11,insert:'2'}],initial.length);
 assert.deepEqual(nativeMetadataChanges(initial,corrupt.apply(EditorState.create({doc:initial}).doc).toString(),corrupt),[]);
 const fence=stateHarness(initial);fence.edit(0,1,'~');assert.ok(fence.text.includes('noteglow-code-colors'));assert.ok(!scanNativeCode(fence.text).some(block=>block.status==='valid'));
});

test('Prism spans retain their structure while native ranges paint exact decoded text',()=>{
 const source=paint('```go\r\na & b\r\n```\r\n','&').text,block=scanNativeCode(source)[0];
 const window=new Window(),code=window.document.createElement('code');code.innerHTML='<span class="token">a </span>&amp;<span class="token"> b\n</span>';
 assert.equal(paintNativeCodeElement(code,block),true);assert.equal(code.textContent,'a & b\n');assert.equal(code.querySelectorAll('.token').length,2);
 assert.equal(code.querySelector('[data-codex-note-color]').textContent,'&');
 const mismatch=window.document.createElement('code');mismatch.textContent='other';assert.equal(paintNativeCodeElement(mismatch,block),false);
 assert.equal(paintNativeCodeElement(code,{...block,status:'stale'}),false);
});

test('strict legacy migration preserves exact text, language and styles with safe fence length',()=>{
 const code='update(a)\nupdatePtr(&a) // ``` 😀\n';
 let legacy=applyMarkdownColor('```go\n'+code+'```\n',6,15,'background',bg).text;
 // The original code includes a literal backtick run inside a comment, not a closing line.
 const at=legacy.indexOf('updatePtr');legacy=applyMarkdownColor(legacy,at,at+9,'foreground',fg).text;
 legacy=legacy.replace('</code></pre>','</code>\n</pre>');
 const decoded=decodeOwnedCodeBlocks(legacy);assert.equal(decoded.length,1);assert.equal(decoded[0].code,code);
 const migrated=migrateOwnedCodeToNative(legacy),block=scanNativeCode(migrated)[0];
 assert.ok(migrated.startsWith('````go\n'));assert.equal(block.code,code);assert.equal(block.status,'valid');assert.deepEqual(block.ranges,decoded[0].ranges);
 assert.equal(migrateOwnedCodeToNative(migrated),migrated);
 for(const bad of [legacy.replace('data-codex-code="1"','data-codex-code="1" onclick="bad"'),legacy.replace('&#10;</code>','</code>'),'> '+legacy,legacy.replace('</code>','<b>bad</b></code>')]) assert.throws(()=>migrateOwnedCodeToNative(bad));
});

test('native scan honors shared YAML and Obsidian opaque region protection',()=>{
 for(const source of ['---\nexample: "\n```go\nfoo\n```\n"\n---','\ufeff---\r\nexample: "\r\n```go\r\nfoo\r\n```\r\n"\r\n---',...['%%','$$','=='].map(mark=>mark+'\n```go\nfoo\n```\n'+mark)]) {
  assert.ok(!scanNativeCode(source).some(block=>block.supported));
  const from=source.indexOf('foo');
  if(source.includes('example:')) assert.equal(applyNativeCodeColor(source,from,from+3,'background',bg),null);
  else assert.throws(()=>applyNativeCodeColor(source,from,from+3,'background',bg),/顶层/);
 }
 const actual='```go\n%% $$ == literal\n```\n';assert.equal(paint(actual,'literal').text.startsWith(actual),true);
});

test('indent transactions keep valid ranges; move transactions invalidate instead of guessing',()=>{
 const initial=paint('```go\nalpha\nbeta\n```\n','alpha').text;
 const harness=stateHarness(initial),at=initial.indexOf('alpha');harness.edit(at,at,'  ','indent');
 const block=scanNativeCode(harness.text)[0];assert.equal(block.status,'valid');assert.deepEqual(block.ranges,[{from:2,to:7,property:'background',color:bg}]);
 assert.equal(undo(harness.target),true);assert.equal(harness.text,initial);
 const move=stateHarness(initial);move.edit(at,at+'alpha\nbeta'.length,'beta\nalpha','move.line');assert.equal(scanNativeCode(move.text)[0].status,'stale');
});


test('migration maps source selections into code and preserves later cursor offsets',()=>{
 const original='before\n\n```go\nalpha & beta\n```\n\nafter';
 const legacy=applyMarkdownColor(original,original.indexOf('alpha'),original.indexOf('alpha')+5,'background',bg).text;
 const migrated=migrateOwnedCodeToNative(legacy);
 const at=legacy.indexOf('&amp;');const mapped=mapMigratedCodePosition(legacy,migrated,at);
 assert.equal(migrated.slice(mapped,mapped+1),'&');
 assert.equal(mapMigratedCodePosition(legacy,migrated,2),2);
 assert.equal(migrated.slice(mapMigratedCodePosition(legacy,migrated,legacy.indexOf('after'))),'after');
});

test('clearing originally EOF metadata keeps a separator before later appended prose',()=>{
 const original='```go\nalpha\n```';const colored=paint(original,'alpha');
 const appended=colored.text+'after\n';const cleared=applyNativeCodeColor(appended,colored.from,colored.to);
 assert.equal(cleared.text,original+'\nafter\n');
 assert.equal(scanNativeCode(cleared.text)[0].code,'alpha\n');
});

test('migration backup must round-trip before editor writes and preserves failure evidence',async()=>{
 const files=new Map(),operations=[];let current=true;
 const adapter={exists:async path=>files.has(path),mkdir:async path=>{files.set(path,'');operations.push('mkdir');},write:async(path,text)=>{files.set(path,text);operations.push('write');},read:async path=>{operations.push('read');return files.get(path);}};
 assert.equal(await backupNativeCodeMigration(adapter,'backups','one.md','exact\r\n',()=>current),'backups/one.md');
 assert.deepEqual(operations,['mkdir','write','read']);assert.equal(files.get('backups/one.md'),'exact\r\n');
 await assert.rejects(backupNativeCodeMigration(adapter,'backups','one.md','other',()=>true),/已存在/);
 await assert.rejects(backupNativeCodeMigration(adapter,'backups','../bad.md','text',()=>true),/参数/);
 const length=operations.length;await assert.rejects(backupNativeCodeMigration(adapter,'backups','two.md','text',()=>false),/来源/);assert.equal(operations.length,length);
 await assert.rejects(backupNativeCodeMigration({...adapter,read:async()=> 'mismatch'},'backups','mismatch.md','text',()=>true),/读回/);assert.equal(files.get('backups/mismatch.md'),'text');
 await assert.rejects(backupNativeCodeMigration({...adapter,write:async(path,text)=>{await adapter.write(path,text);current=false;}},'backups','stale.md','text',()=>current),/备份期间/);assert.equal(files.get('backups/stale.md'),'text');
 await assert.rejects(backupNativeCodeMigration({...adapter,write:async()=>{throw new Error('disk full');}},'backups','failed.md','text',()=>true),/disk full/);
});

test('only canonical adjacent metadata is concealed, never code or malformed records',()=>{
 const initial=paint('```go\nalpha\n```\n\nafter','alpha').text;
 const block=scanNativeCode(initial)[0];assert.deepEqual(nativeMetadataHiddenRanges(initial),[{from:block.commentFrom,to:block.metadataTo}]);
 assert.ok(block.commentFrom>block.to);assert.ok(initial.slice(block.commentFrom,block.metadataTo).startsWith('<!-- noteglow-code-colors:1 '));
 assert.equal(nativeMetadataHiddenRanges(initial.replace('alpha\n```','changed\n```')).length,1,'canonical stale snapshot stays hidden');
 assert.deepEqual(nativeMetadataHiddenRanges(initial.replace('"version":1','"version":2')),[]);
 assert.deepEqual(nativeMetadataHiddenRanges('plain text'),[]);
 assert.deepEqual(nativeMetadataHiddenRanges(initial.replace('```\n<!--','```\n\n<!--')),[],'detached records stay visible in source');
});

test('direct CM metadata field follows Live Preview toggle, code edits and Undo without changing source',()=>{
 const mode=StateEffect.define();
 const live=StateField.define({create:()=>true,update:(value,tr)=>tr.effects.reduce((current,effect)=>effect.is(mode)?effect.value:current,value)});
 const field=createNativeMetadataField(state=>state.field(live));
 const initial=paint('```go\nalpha\n```\n','alpha').text;
 let state=EditorState.create({doc:initial,extensions:[live,field,history(),nativeCodeColorTransactions]});
 const target={get state(){return state;},dispatch:tr=>{state=tr.state;}};
 const ranges=()=>{const output=[];state.field(field).between(0,state.doc.length,(from,to)=>{output.push({from,to});});return output;};
 assert.deepEqual(ranges(),nativeMetadataHiddenRanges(initial));
 assert.ok(state.facet(EditorView.decorations).includes(state.field(field)),'block decorations come directly from state');
 assert.equal(state.facet(EditorView.atomicRanges)[0]({state}),state.field(field),'cursor movement uses same atomic range');
 state=state.update({selection:{anchor:initial.indexOf('alpha')+1}}).state;assert.equal(ranges().length,1,'code cursor does not reveal metadata');
 state=state.update({effects:mode.of(false)}).state;assert.deepEqual(ranges(),[]);assert.equal(state.doc.toString(),initial,'source toggle never rewrites text');
 state=state.update({effects:mode.of(true)}).state;assert.equal(ranges().length,1);
 const at=initial.indexOf('alpha')+2;state=state.update({changes:{from:at,insert:'X'},annotations:Transaction.userEvent.of('input.type')}).state;
 assert.deepEqual(ranges(),nativeMetadataHiddenRanges(state.doc.toString()));assert.equal(scanNativeCode(state.doc.toString())[0].status,'valid');
 assert.equal(undo(target),true);assert.equal(state.doc.toString(),initial);assert.deepEqual(ranges(),nativeMetadataHiddenRanges(initial));
 const plain=EditorState.create({doc:'plain',extensions:[live,field]});assert.equal(plain.field(field).size,0);
});


test('real CM delete commands protect hidden metadata but allow blank lines, selections and Source mode',async()=>{
 const window=new Window(),saved=new Map(),views=[];
 // 真实 EditorView 才会执行 skipAtomic；不能用仅有 state/dispatch 的替身掩盖删除扩展。
 const globals={window,document:window.document,MutationObserver:window.MutationObserver,HTMLElement:window.HTMLElement,Node:window.Node,DOMRect:window.DOMRect,getComputedStyle:window.getComputedStyle.bind(window),requestAnimationFrame:window.requestAnimationFrame.bind(window),cancelAnimationFrame:window.cancelAnimationFrame.bind(window)};
 for(const [key,value] of Object.entries(globals)){saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});}
 const make=(doc,anchor,live=true,head=anchor,reverse=false)=>{
  const parent=window.document.createElement('div');window.document.body.appendChild(parent);
  const extensions=[createNativeMetadataField(()=>live),nativeCodeColorTransactions];if(reverse)extensions.reverse();
  const view=new EditorView({parent,state:EditorState.create({doc,selection:{anchor,head},extensions})});views.push(view);return view;
 };
 try {
  const initial=paint('```go\nalpha\n```\n\nafter','alpha').text;
  const view=make(initial,initial.indexOf('after'));
  assert.equal(deleteCharBackward(view),true);
  const withoutBlank=initial.replace('\n\nafter','\nafter');assert.equal(view.state.doc.toString(),withoutBlank,'ordinary blank line deletion is allowed');
  assert.equal(deleteCharBackward(view),true);assert.equal(view.state.doc.toString(),withoutBlank,'atomic backspace cannot erase hidden snapshot');
  const block=scanNativeCode(initial)[0],forward=make(initial,block.to);
  assert.equal(deleteCharForward(forward),true);assert.equal(forward.state.doc.toString(),initial,'forward delete cannot detach metadata separator');
  const eof=paint('```go\nalpha\n```','alpha').text,tail=make(eof,eof.length);
  assert.equal(deleteCharBackward(tail),true);assert.equal(tail.state.doc.toString(),eof,'EOF blank caret also preserves hidden metadata');
  const stale=withoutBlank.replace('alpha\n```','changed\n```'),staleView=make(stale,stale.indexOf('after'));
  assert.equal(deleteCharBackward(staleView),true);assert.equal(staleView.state.doc.toString(),stale,'canonical stale metadata remains recoverable');
  const selected=make(initial,0,true,initial.indexOf('after'));
  assert.equal(deleteCharBackward(selected),true);assert.equal(selected.state.doc.toString(),'after','explicit whole-block selection remains deletable');
  const source=make(initial,block.to,false);
  assert.equal(deleteCharForward(source),true);assert.equal(source.state.doc.toString(),initial.slice(0,block.to)+initial.slice(block.to+1),'Source mode permits explicit source editing');
  for(const reverse of [false,true]) {
   const ordinary=make(initial,initial.indexOf('alpha')+1,true,initial.indexOf('alpha')+1,reverse);
   assert.equal(deleteCharBackward(ordinary),true);const edited=scanNativeCode(ordinary.state.doc.toString())[0];
   assert.equal(edited.code,'lpha\n','normal code deletion works with either extension order');assert.equal(edited.status,'valid');
   const protectedView=make(withoutBlank,withoutBlank.indexOf('after'),true,withoutBlank.indexOf('after'),reverse);
   assert.equal(deleteCharBackward(protectedView),true);assert.equal(protectedView.state.doc.toString(),withoutBlank,'hidden record protected with either extension order');
   const separator=make(initial,block.to,true,block.to,reverse);
   assert.equal(deleteCharForward(separator),true);assert.equal(separator.state.doc.toString(),initial,'separator protected with either extension order');
  }
 } finally {
  for(const view of views)view.destroy();await window.happyDOM.abort();
  for(const [key,descriptor] of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}
 }
});
