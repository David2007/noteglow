import assert from 'node:assert/strict';
import test from 'node:test';
import {Window} from 'happy-dom';
import {createColorPicker} from '../src/color-picker.ts';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
function setup(overrides={}) {
 const window=overrides.document?.defaultView??new Window({width:800,height:600}),document=window.document;
 const calls=[],failures=[];let closed=0;
 const options={document,anchor:{left:100,top:100,bottom:120},label:'背景颜色',colors:['#fff88f','#ffd6d6','#cde6ff'],initialColor:'#fff88f',apply:async color=>{calls.push(color);},closed:()=>{closed++;},failedAfterClose:error=>failures.push(error),...overrides};
 const picker=createColorPicker(options);
 return {window,document,picker,calls,failures,get closed(){return closed;},panel:document.querySelector('[role="dialog"]'),input:document.querySelector('input'),buttons:[...document.querySelectorAll('button')]};
}
function key(env,target,value,extra={}) {target.dispatchEvent(new env.window.KeyboardEvent('keydown',{key:value,bubbles:true,cancelable:true,...extra}));}

test('preset click immediately applies once and closes without confirmation controls',async()=>{
 const env=setup();
 assert.equal(env.panel.getAttribute('aria-label'),'背景颜色');
 assert.equal(env.buttons.length,3);assert.equal(env.document.activeElement,env.buttons[0]);
 env.buttons[1].click();assert.deepEqual(env.calls,['#ffd6d6']);
 await tick();assert.equal(env.closed,1);assert.equal(env.document.querySelector('[role="dialog"]'),null);
 env.picker.close();assert.equal(env.closed,1);
});

test('custom input applies only on Enter, normalizes hex and rejects invalid values',async()=>{
 const env=setup();
 env.input.value='#abc';env.input.dispatchEvent(new env.window.Event('input',{bubbles:true}));
 env.input.dispatchEvent(new env.window.Event('change',{bubbles:true}));assert.deepEqual(env.calls,[]);
 key(env,env.input,'Enter',{isComposing:true});assert.deepEqual(env.calls,[]);
 key(env,env.input,'x');assert.deepEqual(env.calls,[]);
 env.input.value='red';key(env,env.input,'Enter');assert.deepEqual(env.calls,[]);
 assert.equal(env.document.querySelector('[role="alert"]').hidden,false);assert.equal(env.document.activeElement,env.input);
 env.input.value='#AbC';key(env,env.input,'Enter');assert.deepEqual(env.calls,['#aabbcc']);
 await tick();assert.equal(env.closed,1);
});

test('outside pointer and Escape dismiss without applying or stealing focus',()=>{
 for(const kind of ['pointer','escape']) {
  const env=setup();const outside=env.document.createElement('button');env.document.body.appendChild(outside);
  env.buttons[0].dispatchEvent(new env.window.PointerEvent('pointerdown',{bubbles:true}));assert.equal(env.closed,0);
  if(kind==='pointer') outside.dispatchEvent(new env.window.PointerEvent('pointerdown',{bubbles:true}));
  else key(env,env.input,'Escape');
  outside.focus();assert.equal(env.closed,1);assert.deepEqual(env.calls,[]);assert.equal(env.document.activeElement,outside);
  key(env,env.document,'Escape');outside.dispatchEvent(new env.window.PointerEvent('pointerdown',{bubbles:true}));assert.equal(env.closed,1,'listeners removed');
 }
});

test('only Escape synchronously returns focus through the caller callback',()=>{
 for(const kind of ['escape','outside','owner']) {
  let restored=0;
  let source;
  const env=setup({cancelledByEscape:()=>{restored++;source.focus();}});
  source=env.document.createElement('input');env.document.body.appendChild(source);
  if(kind==='escape') key(env,env.input,'Escape');
  else if(kind==='outside') env.document.body.dispatchEvent(new env.window.PointerEvent('pointerdown',{bubbles:true}));
  else env.picker.close();
  assert.equal(restored,kind==='escape'?1:0);
  if(kind==='escape') assert.equal(env.document.activeElement,source,'Escape restores the connected source synchronously');
  else assert.notEqual(env.document.activeElement,source,'other dismissal does not steal source focus');
  assert.equal(env.closed,1);
  key(env,env.document,'Escape');assert.equal(restored,kind==='escape'?1:0,'removed listener cannot restore twice');
 }
});

test('inflight submission disables controls and refuses repeated programmatic events',async()=>{
 let finish,restored=0;const calls=[];
 const env=setup({apply:color=>{calls.push(color);return new Promise(resolve=>{finish=resolve;});},cancelledByEscape:()=>{restored++;}});
 env.buttons[0].click();
 env.buttons[1].dispatchEvent(new env.window.MouseEvent('click',{bubbles:true}));
 key(env,env.input,'Enter');assert.deepEqual(calls,['#fff88f']);
 assert.ok(env.buttons.every(button=>button.disabled));assert.equal(env.input.disabled,true);
 key(env,env.input,'Escape');assert.equal(restored,1);const outside=env.document.createElement('input');env.document.body.appendChild(outside);outside.focus();
 env.buttons[2].dispatchEvent(new env.window.MouseEvent('click',{bubbles:true}));
 finish();await tick();assert.equal(env.closed,1);assert.deepEqual(calls,['#fff88f']);assert.equal(env.document.activeElement,outside);
});

test('apply failure remains visible and permits one retry without a second confirmation',async()=>{
 let attempts=0;
 const env=setup({apply:async()=>{if(++attempts===1)throw new Error('保存失败');}});
 env.buttons[0].click();await tick();
 assert.equal(env.closed,0);assert.equal(env.document.querySelector('[role="alert"]').textContent,'保存失败');
 assert.equal(env.input.disabled,false);assert.ok(env.buttons.every(button=>!button.disabled));
 env.buttons[1].click();await tick();assert.equal(attempts,2);assert.equal(env.closed,1);
});

test('dismissed pending failure is reported without reopening or focusing the old picker',async()=>{
 let fail;const env=setup({apply:()=>new Promise((_,reject)=>{fail=reject;})});
 env.buttons[0].click();env.picker.close();
 const outside=env.document.createElement('input');env.document.body.appendChild(outside);outside.focus();
 fail('保存冲突');await tick();assert.deepEqual(env.failures,['保存冲突']);
 assert.equal(env.document.querySelector('[role="dialog"]'),null);assert.equal(env.document.activeElement,outside);
});

test('non-Error rejection is shown inline and Tab wraps within available controls',async()=>{
 const env=setup({apply:async()=>{throw '拒绝写入';}});
 key(env,env.buttons[0],'Tab',{shiftKey:true});assert.equal(env.document.activeElement,env.input);
 key(env,env.input,'Tab');assert.equal(env.document.activeElement,env.buttons[0]);
 env.buttons[1].focus();key(env,env.buttons[1],'Tab');assert.equal(env.document.activeElement,env.buttons[1],'middle Tab keeps browser default');
 env.buttons[0].click();await tick();assert.equal(env.document.querySelector('[role="alert"]').textContent,'拒绝写入');env.picker.close();
 const empty=setup({colors:[]});assert.equal(empty.document.activeElement,empty.input);empty.picker.close();
});

test('popover remains inside viewport and moves above a bottom-edge anchor',()=>{
 const window=new Window({width:800,height:600}),document=window.document;
 Object.defineProperty(window.HTMLElement.prototype,'offsetWidth',{get:()=>260});
 Object.defineProperty(window.HTMLElement.prototype,'offsetHeight',{get:()=>120});
 const env=setup({document,anchor:{left:790,top:560,bottom:580}});
 const panel=document.querySelector('[role="dialog"]');assert.equal(panel.style.left,'532px');assert.equal(panel.style.top,'434px');env.picker.close();
});
