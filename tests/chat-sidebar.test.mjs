import assert from 'node:assert/strict';
import test from 'node:test';
import { createChatSidebar } from '../src/chat-sidebar.ts';

function setup({existing=false,root='right',deferred=false}={}){
 const calls=[];let unloaded=false,leaves=[],resolve;
 const right={expand:()=>calls.push('expand-right')},left={expand:()=>calls.push('expand-left')};
 const note={name:'note'},newNote={name:'new-note'};
 const leaf={getRoot:()=>root==='right'?right:root==='left'?left:{},setViewState:async state=>{calls.push(['setViewState',state]);leaves=[leaf];}};
 if(existing)leaves=[leaf];
 const workspace={activeLeaf:note,rightSplit:right,leftSplit:left,getLeavesOfType:()=>leaves,
  ensureSideLeaf(type,side,options){calls.push(['ensure',type,side,options]);leaves=[leaf];return deferred?new Promise(r=>{resolve=r;}):Promise.resolve(leaf);},
  getRightLeaf(){calls.push('right-leaf');return leaf;},getLeaf(){throw Error('unexpected root fallback');},
  async revealLeaf(value){calls.push(['reveal',value]);workspace.activeLeaf=value;}};
 return {controller:createChatSidebar(workspace,'chat',()=>unloaded),workspace,calls,leaf,note,newNote,unload:()=>{unloaded=true;},close:()=>{leaves=[];},resolve:()=>resolve(leaf)};
}
test('startup creates the side view without activation, expands it and preserves editor focus',async()=>{
 const env=setup();await env.controller.open(true);
 assert.deepEqual(env.calls,[['ensure','chat','right',{active:false,reveal:true}]]);
 assert.equal(env.workspace.activeLeaf,env.note);
});
test('restored side leaves are reused and central or popout leaves are not moved',async()=>{
 for(const root of ['right','left','center']){
  const env=setup({existing:true,root});await env.controller.open(true);
  assert.deepEqual(env.calls,root==='center'?[]:[['ensure','chat',root,{active:false,reveal:true}]]);assert.equal(env.workspace.activeLeaf,env.note);
 }
});
test('async automatic initialization has no late activation after focus change, unload or closure',async()=>{
 for(const action of ['focus','unload','close']){
  const env=setup({deferred:true});const pending=env.controller.open(true);
  if(action==='focus')env.workspace.activeLeaf=env.newNote;
  if(action==='unload')env.unload();if(action==='close')env.close();env.resolve();await pending;
  assert.equal(env.calls.filter(call=>Array.isArray(call)&&call[0]==='reveal').length,0);
  assert.equal(env.workspace.activeLeaf,action==='focus'?env.newNote:env.note);
 }
 const unloaded=setup();unloaded.unload();await unloaded.controller.open(true);assert.deepEqual(unloaded.calls,[]);
});
test('manual activation shares pending startup initialization and then intentionally foregrounds chat',async()=>{
 const env=setup({deferred:true});const automatic=env.controller.open(true),manual=env.controller.open();env.resolve();await Promise.all([automatic,manual]);
 assert.equal(env.calls.filter(call=>Array.isArray(call)&&call[0]==='ensure').length,1);
 assert.equal(env.calls.filter(call=>Array.isArray(call)&&call[0]==='reveal').length,1);
 assert.equal(env.workspace.activeLeaf,env.leaf);
});
test('manual reopen retains existing activation behavior and failures do not poison later retries',async()=>{
 const env=setup();await env.controller.open();assert.deepEqual(env.calls[0],'right-leaf');assert.equal(env.workspace.activeLeaf,env.leaf);
 env.close();env.workspace.ensureSideLeaf=async()=>{throw Error('host unavailable');};await assert.rejects(env.controller.open(true),/host unavailable/);
 env.workspace.ensureSideLeaf=async()=>env.leaf;await env.controller.open(true); // closed target must not be revived by a stale result
 assert.equal(env.calls.filter(call=>call==='expand-right').length,0);
});
