import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,readFile,writeFile,stat,rm,symlink,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ImageStore} from '../src/image-store.ts';
import {png} from './fixtures/image-fixtures.mjs';

async function setup(t){const root=await mkdtemp(join(tmpdir(),'noteglow-images-test-'));t.after(()=>rm(root,{recursive:true,force:true}));const plugin='.obsidian/plugins/codex-notes';await mkdir(join(root,plugin),{recursive:true});return {root,plugin,store:new ImageStore(root,plugin)};}
test('private copy survives deletion of original and exports only Vault-relative resource paths',async t=>{
 const {root,plugin,store}=await setup(t);const bytes=png();const item=await store.add('原图/示例.png',bytes);
 assert.equal(item.name,'原图_示例.png');assert.equal(JSON.stringify(item).includes(root),false);assert.equal(JSON.stringify(item).includes('base64'),false);
 assert.deepEqual(Buffer.from(await store.verify(item)),bytes);
 assert.equal((await stat(join(root,plugin,'image-attachments',item.fileName))).mode&0o777,0o600);
 assert.equal((await stat(join(root,plugin,'image-attachments'))).mode&0o777,0o700);
 assert.equal(await store.resourcePath(item),`${plugin}/image-attachments/${item.fileName}`);
});
test('send snapshots are independent files and are removed on dispose, while history remains',async t=>{
 const {root,plugin,store}=await setup(t);const a=await store.add('1.png',png()),b=await store.add('2.png',png(24,16,[12,180,29]));
 const prepared=await store.prepare([a,b]);assert.equal(prepared.paths.length,2);
 assert.deepEqual(await readFile(prepared.paths[0]),png());assert.equal((await stat(prepared.paths[0])).mode&0o777,0o600);
 const cache=join(root,plugin,'image-attachments',a.fileName);await writeFile(cache,Buffer.from('changed'));
 assert.deepEqual(await readFile(prepared.paths[0]),png());await prepared.dispose();await prepared.dispose();
 await assert.rejects(stat(prepared.paths[0]),{code:'ENOENT'});assert.equal((await readdir(join(root,plugin,'image-attachments'))).length,2);
});
test('missing, tampered, symlinked and malformed records never produce send paths',async t=>{
 const {root,plugin,store}=await setup(t);const item=await store.add('img.png',png());const file=join(root,plugin,'image-attachments',item.fileName);
 await assert.rejects(store.verify({...item,fileName:'../data.json'}),/损坏/);
 await writeFile(file,png(24,16,[1,2,3]));await assert.rejects(store.verify(item),/变化/);
 await rm(file);await assert.rejects(store.prepare([item]),{code:'ENOENT'});
 const outside=join(root,'outside.png');await writeFile(outside,png());await symlink(outside,file);await assert.rejects(store.prepare([item]),/变化/);
});
test('refuses symlinked parent before creating a cache and refuses symlinked cache',async t=>{
 const {root,plugin}=await setup(t);const elsewhere=join(root,'elsewhere');await mkdir(elsewhere);await rm(join(root,plugin),{recursive:true});await symlink(elsewhere,join(root,plugin));
 await assert.rejects(new ImageStore(root,plugin).add('a.png',png()),/符号链接/);assert.deepEqual(await readdir(elsewhere),[]);
 await rm(join(root,plugin));await mkdir(join(root,plugin));await symlink(elsewhere,join(root,plugin,'image-attachments'));await assert.rejects(new ImageStore(root,plugin).add('a.png',png()),/符号链接/);
});
test('rejects traversal roots, oversized requests and malformed bytes without creating artifacts',async t=>{
 const {root,plugin,store}=await setup(t);assert.throws(()=>new ImageStore(root,'../../out'),/Vault/);assert.throws(()=>new ImageStore(root,'/absolute'),/Vault/);
 await assert.rejects(store.add('bad.svg',Buffer.from('<svg/>')),/仅支持/);await assert.rejects(store.prepare([{}, {}, {}, {}, {}]),/4/);
 const empty=await store.prepare([]);assert.deepEqual(empty.paths,[]);await empty.dispose();await assert.rejects(stat(join(root,plugin,'image-attachments')),{code:'ENOENT'});
});
