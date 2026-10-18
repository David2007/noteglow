import assert from 'node:assert/strict';
import test from 'node:test';
import {loadPluginSettings,ConversationRepository} from '../src/conversation-store.ts';
import {exportConversationMarkdown} from '../src/conversation-utils.ts';
import {randomUUID} from 'node:crypto';
function picture(){const id=randomUUID();return {id,name:'截图.png',fileName:`${id}.png`,mime:'image/png',size:500,width:24,height:16,sha256:'a'.repeat(64)};}
test('legacy text history remains intact while new draft and history images survive reload and conversation switches',()=>{
 const state=loadPluginSettings(null).settings,repo=new ConversationRepository(state);const first=repo.active;first.draftText='看图';first.draftImages=Array.from({length:10},picture);
 first.messages.push({id:'u1',role:'user',text:'解释',createdAt:123,images:Array.from({length:10},picture)});const other=repo.create();other.draftImages=[picture()];
 const loaded=loadPluginSettings(JSON.parse(JSON.stringify(state))).settings;const a=loaded.conversations.find(x=>x.id===first.id),b=loaded.conversations.find(x=>x.id===other.id);
 assert.equal(a.draftImages.length,10);assert.equal(a.messages[0].images.length,10);assert.deepEqual(a.draftImages,first.draftImages);assert.deepEqual(a.messages[0].images,first.messages[0].images);assert.notDeepEqual(a.draftImages,b.draftImages);
 assert.equal(a.draftText,'看图');const exported=exportConversationMarkdown(a,123);assert.match(exported,/图片附件：截图.png/);assert.equal(exported.includes('base64'),false);
});
