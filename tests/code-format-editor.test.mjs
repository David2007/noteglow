import assert from 'node:assert/strict';
import test from 'node:test';
import { Window } from 'happy-dom';
import { EditorState, StateEffect, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { history, undo, redo } from '@codemirror/commands';
import { applyNativeCodeColor, nativeCodeColorTransactions, scanNativeCode } from '../src/native-code-colors.ts';
import { codeFormatExtension } from '../src/code-format-editor.ts';

const window = new Window();
for (const key of ['window','document','MutationObserver','ResizeObserver','HTMLElement','Node']) globalThis[key] = key === 'window' ? window : window[key];
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function setup(doc = '```\n\n```', extensions = []) {
 const pending = [], statuses = [], settings = { autoFormatCode:true,gofmtPath:'',blackPath:'' };
 let path = 'fixture.md';
 const extension = codeFormatExtension({ settings:()=>settings,path:()=>path,report:s=>statuses.push(s),format:(language,code,config,signal)=>new Promise(resolve=>pending.push({language,code,signal,resolve})) });
 const parent = document.createElement('div'); document.body.append(parent);
 const view = new EditorView({ parent,state:EditorState.create({doc,selection:{anchor:4},extensions:[history(),extension,...extensions]}) });
 view.focus();
 return {view,pending,settings,statuses,setPath:p=>{path=p;},close:()=>{view.destroy();parent.remove();},paste:()=>view.dispatch({changes:{from:4,to:4,insert:'x:=1'},selection:{anchor:8},annotations:Transaction.userEvent.of('input.paste')})};
}
test('paste preserves original until format resolves; format is independently undoable and redo does not rerun it',async()=>{
 const env=setup(); try {
 env.paste(); await tick(); assert.equal(env.view.state.doc.toString(),'```\nx:=1\n```');
 assert.equal(env.pending.length,1); assert.equal(env.pending[0].language,'go');
 env.pending[0].resolve({status:'formatted',code:'x := 1\n'}); await tick();
 assert.equal(env.view.state.doc.toString(),'```go\nx := 1\n```');
 assert.equal(undo(env.view),true); assert.equal(env.view.state.doc.toString(),'```\nx:=1\n```');
 assert.equal(undo(env.view),true); assert.equal(env.view.state.doc.toString(),'```\n\n```');
 assert.equal(redo(env.view),true); assert.equal(redo(env.view),true);
 await tick(); assert.equal(env.pending.length,1);
 } finally {env.close();}
});
test('late results never overwrite typing, selection movement, blur, switched path, disabled setting or destroyed editor',async()=>{
 for (const action of ['typing','selection','blur','path','disabled','readonly','destroy']) {
 const env=setup(); env.paste(); await tick();
 if(action==='typing') env.view.dispatch({changes:{from:8,insert:' // edited'}});
 if(action==='selection') env.view.dispatch({selection:{anchor:4}});
 if(action==='blur') env.view.contentDOM.blur();
 if(action==='path') env.setPath('other.md');
 if(action==='disabled') env.settings.autoFormatCode=false;
 if(action==='readonly') env.view.dispatch({effects:StateEffect.appendConfig.of(EditorState.readOnly.of(true))});
 if(action==='destroy') env.view.destroy();
 const before=env.view.state.doc.toString();
 env.pending[0].resolve({status:'formatted',code:'x := 1\n'});await tick();
 assert.equal(env.view.state.doc.toString(),before,action);
 env.close();
 }
});
test('ordinary input and disabled paste do not run formatting; failures preserve original',async()=>{
 const env=setup();try{
 env.view.dispatch({changes:{from:4,insert:'x'},annotations:Transaction.userEvent.of('input.type')});await tick();assert.equal(env.pending.length,0);
 env.settings.autoFormatCode=false;env.paste();await tick();assert.equal(env.pending.length,0);
 }finally{env.close();}
 const failed=setup();try{failed.paste();await tick();failed.pending[0].resolve({status:'invalid'});await tick();assert.equal(failed.view.state.doc.toString(),'```\nx:=1\n```');assert.deepEqual(failed.statuses,['invalid']);}finally{failed.close();}
});
test('new paste cancels the preceding formatter; only latest result may commit',async()=>{
 const env=setup();try{
 env.paste();await tick();
 env.view.dispatch({changes:{from:8,insert:'\ny:=2'},selection:{anchor:13},annotations:Transaction.userEvent.of('input.paste')});await tick();
 assert.equal(env.pending.length,2);assert.equal(env.pending[0].signal.aborted,true);
 env.pending[0].resolve({status:'formatted',code:'x := 1\n'});await tick();
 assert.equal(env.view.state.doc.toString(),'```\nx:=1\ny:=2\n```');
 env.pending[1].resolve({status:'formatted',code:'x := 1\ny := 2\n'});await tick();
 assert.equal(env.view.state.doc.toString(),'```go\nx := 1\ny := 2\n```');
 }finally{env.close();}
});
test('unknown code reports skip and explicit read-only mode prevents formatter invocation',async()=>{
 const env=setup();try{
 env.view.dispatch({changes:{from:4,insert:'ordinary text'},selection:{anchor:17},annotations:Transaction.userEvent.of('input.paste')});await tick();
 assert.equal(env.pending.length,0);assert.deepEqual(env.statuses,['skipped']);
 env.view.dispatch({effects:StateEffect.appendConfig.of(EditorState.readOnly.of(true))});
 env.paste();await tick();assert.equal(env.pending.length,0);
 }finally{env.close();}
});
test('replacement crossing two code blocks stays as pasted even if the result is one valid block',async()=>{
 const doc='```\nx:=1\n```\n\n```\ny:=2\n```';
 const env=setup(doc);try{
 const from=doc.indexOf('x:='),to=doc.indexOf('y:=')+4;
 env.view.dispatch({changes:{from,to,insert:'z:=3'},selection:{anchor:from+4},annotations:Transaction.userEvent.of('input.paste')});await tick();
 assert.equal(env.view.state.doc.toString(),'```\nz:=3\n```');
 assert.equal(env.pending.length,0);assert.deepEqual(env.statuses,['skipped']);
 }finally{env.close();}
});
test('native color transaction maps pasted characters while automatic formatting leaves its metadata intact',async()=>{
 const source='```go\nx:=1\n```';
 const doc=applyNativeCodeColor(source,6,7,'foreground','#112233').text;
 const env=setup(doc,[nativeCodeColorTransactions]);try{
 env.view.dispatch({changes:{from:10,insert:'\ny:=2'},selection:{anchor:15},annotations:Transaction.userEvent.of('input.paste')});await tick();
 assert.equal(env.pending.length,0);
 const block=scanNativeCode(env.view.state.doc.toString())[0];
 assert.equal(block.status,'valid');assert.equal(block.code,'x:=1\ny:=2\n');
 assert.deepEqual(block.ranges,[{from:0,to:1,property:'foreground',color:'#112233'}]);
 assert.equal(undo(env.view),true);assert.equal(env.view.state.doc.toString(),doc);
 }finally{env.close();}
});
