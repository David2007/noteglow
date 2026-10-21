import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const bundled=await build({stdin:{contents:`export { registerLinkEditor } from './src/link-editor.ts'; export { MarkdownView, Modal, notices } from 'obsidian'; export { EditorState, Transaction, StateEffect } from '@codemirror/state'; export { history, undo } from '@codemirror/commands';`,resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'node',plugins:[{name:'host',setup(b){b.onResolve({filter:/^obsidian$/},()=>({path:'obsidian',namespace:'host'}));b.onLoad({filter:/.*/,namespace:'host'},()=>({contents:`
export class MarkdownView {}
export const notices=[];
export class Notice {constructor(text){notices.push(text);}}
export class Modal { static instances=[]; constructor(){this.contentEl=this;Modal.instances.push(this);}setTitle(){return this;}open(){this.opened=true;}close(){this.closed=true;}}
export class Setting {constructor(modal){this.modal=modal;}setName(){return this;}setDesc(){return this;}addText(fn){const modal=this.modal;fn({setValue(value){modal.value=value;return this;},onChange(fn){modal.change=fn;return this;}});return this;}addButton(fn){const modal=this.modal;fn({setButtonText(){return this;},setCta(){return this;},onClick(fn){modal.save=fn;return this;}});return this;}}
` }));}}]});
const {registerLinkEditor,MarkdownView,Modal,notices,EditorState,Transaction,StateEffect,history,undo}=await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
function setup(source='[label](https://old.test "title")'){
 Modal.instances.length=0;notices.length=0;
 let state=EditorState.create({doc:source,extensions:[history()]});
 const cm={get state(){return state;},dispatch(spec){state=spec instanceof Transaction?spec.state:state.update(spec).state;}};
 const editor={cm,getValue:()=>state.doc.toString(),getCursor:()=>({line:0,ch:3}),posToOffset:pos=>pos.ch};
 const view=new MarkdownView();view.file={path:'one.md'};view.getMode=()=>view.mode;view.mode='source';view.editor=editor;
 const handlers=new Map(),commands=[],cleanups=[];let leaves=[{view}];
 const plugin={app:{workspace:{on:(name,fn)=>{handlers.set(name,fn);return name;},getLeavesOfType:()=>leaves}},registerEvent(){},register:fn=>cleanups.push(fn),addCommand:command=>commands.push(command)};
 registerLinkEditor(plugin);
 const menu=()=>{let callback;handlers.get('editor-menu')({addItem(fn){fn({setTitle(){return this;},setIcon(){return this;},onClick(fn){callback=fn;return this;}});}},editor,view);return callback;};
 return {cm,editor,view,commands,menu,close:()=>{leaves=[];},modal:()=>Modal.instances.at(-1)};
}
test('deferred context-menu callback refuses offsets captured from a different document snapshot',()=>{
 const env=setup(),callback=env.menu();env.cm.dispatch({changes:{from:0,insert:'prefix '}});const before=env.editor.getValue();callback();
 assert.equal(Modal.instances.length,0);assert.equal(env.editor.getValue(),before);assert.ok(notices.at(-1).includes('改变'));
});
test('link command saves only destination, keeps title and uses one independently undoable transaction',()=>{
 const env=setup(),before=env.editor.getValue();
 assert.equal(env.commands[0].editorCheckCallback(true,env.editor,env.view),true);assert.equal(Modal.instances.length,0);
 env.commands[0].editorCheckCallback(false,env.editor,env.view);const modal=env.modal();modal.change('https://new.test/a b?val=&copy;');modal.save();
 assert.equal(env.editor.getValue(),'[label](<https://new.test/a%20b?val=&amp;copy;> "title")');assert.equal(modal.closed,true);
 assert.equal(undo(env.cm),true);assert.equal(env.editor.getValue(),before);
});
test('pending link dialog fails closed on readonly, renamed path, closed leaf, changed document and reading mode',()=>{
 for(const action of ['readonly','path','closed','snapshot','mode']){
  const env=setup();env.menu()();const modal=env.modal();modal.change('https://new.test');
  if(action==='readonly')env.cm.dispatch({effects:StateEffect.appendConfig.of(EditorState.readOnly.of(true))});
  if(action==='path')env.view.file.path='renamed.md';
  if(action==='closed')env.close();
  if(action==='snapshot')env.cm.dispatch({changes:{from:0,insert:'prefix '}});
  if(action==='mode')env.view.mode='preview';
  const before=env.editor.getValue();modal.save();assert.equal(env.editor.getValue(),before,action);assert.ok(notices.at(-1).includes('改变'));
 }
});
test('invalid address leaves source and dialog intact',()=>{
 const env=setup(),before=env.editor.getValue();env.menu()();const modal=env.modal();modal.change('x\ny');modal.save();assert.equal(env.editor.getValue(),before);assert.ok(!modal.closed);
});


test('dialog replaces the complete escaped-angle destination without leaving URL suffix in Markdown',()=>{
 const env=setup('[label](<a\\>b> "title")');env.menu()();const modal=env.modal();
 modal.change('https://new.test');modal.save();
 assert.equal(env.editor.getValue(),'[label](<https://new.test> "title")');
});
