import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {migrateMarkdownColors} from '../src/markdown-colors.ts';
import {scanNativeText} from '../src/native-text-colors.ts';
import {scanNativeCode} from '../src/native-code-colors.ts';
const exec=promisify(execFile),script=fileURLToPath(new URL('../scripts/migrate-note-colors.mjs',import.meta.url));
const bg='#fff88f';
async function fixture(notes,observed={}) {
 const vault=await mkdtemp(join(tmpdir(),'noteglow-cli-'));
 const sidecar=join(vault,'.obsidian/plugins/codex-notes/note-colors.json');
 await mkdir(dirname(sidecar),{recursive:true});await mkdir(join(vault,'.obsidian/codex-notes-backups'));
 const original=JSON.stringify({version:1,notes,lastColors:{foreground:'#c0392b',background:bg}})+'\n';await writeFile(sidecar,original);
 for(const [path,note] of Object.entries(notes)){await mkdir(dirname(join(vault,path)),{recursive:true});await writeFile(join(vault,path),observed[path]??note.text);}
 return {vault,sidecar,original,close:()=>rm(vault,{recursive:true,force:true})};
}
const note=(text,word)=>({text,ranges:[{from:text.indexOf(word),to:text.indexOf(word)+word.length,property:'background',color:bg}]});
const run=async(f,apply=false)=>{const {stdout}=await exec(process.execPath,['--experimental-strip-types','--disable-warning=ExperimentalWarning','--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',script,f.vault,...(apply?['--apply']:[])]);return JSON.parse(stdout);};

test('migration CLI dry-run writes nothing and apply stores native prose/code with verified backups',async()=>{
 const notes={'prose.md':note('- `arr` and beta','arr'),'code.md':note('```go\nvalue\n```\n','value')};const f=await fixture(notes);
 try {
  const preview=await run(f);assert.equal(preview.mode,'dry-run');assert.equal(preview.notes.length,2);
  assert.equal(await readFile(f.sidecar,'utf8'),f.original);assert.deepEqual(await readdir(join(f.vault,'.obsidian/codex-notes-backups')),[]);
  const applied=await run(f,true);assert.equal(applied.notes.length,2);
  for(const [path,original] of Object.entries(notes)) {
   const text=await readFile(join(f.vault,path),'utf8');assert.ok(!text.includes('<span'));assert.ok(!text.includes('<code'));
   assert.equal(await readFile(join(applied.backup,'notes',path),'utf8'),original.text);
  }
  assert.equal(scanNativeText(await readFile(join(f.vault,'prose.md'),'utf8'))[0].status,'valid');
  assert.equal(scanNativeCode(await readFile(join(f.vault,'code.md'),'utf8'))[0].status,'valid');
  const saved=JSON.parse(await readFile(f.sidecar,'utf8'));assert.deepEqual(saved.notes,{});assert.equal(saved.lastColors.background,bg);
  assert.equal(await readFile(join(applied.backup,'note-colors.json'),'utf8'),f.original);
  assert.deepEqual((await run(f,true)).notes,[],'completed migration is idempotent');
 } finally {await f.close();}
});

test('migration CLI resumes exact legacy HTML interruption and preserves both observed and source snapshots',async()=>{
 const original=note('alpha','alpha'),html=migrateMarkdownColors(original.text,original.ranges).text;
 const f=await fixture({'note.md':original},{'note.md':html});
 try {
  const result=await run(f,true);assert.equal(result.notes[0].recovered,true);
  assert.equal(await readFile(join(result.backup,'notes/note.md'),'utf8'),html);
  assert.equal(await readFile(join(result.backup,'source-snapshots/note.md'),'utf8'),'alpha');
  const final=await readFile(join(f.vault,'note.md'),'utf8');assert.equal(scanNativeText(final)[0].status,'valid');assert.ok(!final.includes('<span'));
  // 模拟最后正文已写回但 sidecar 尚未提交：重试必须识别同一原生结果。
  await writeFile(f.sidecar,f.original);const retry=await run(f);assert.equal(retry.notes[0].recovered,true);assert.equal(retry.notes[0].changed,false);
 } finally {await f.close();}
});

test('migration CLI rejects unsupported member before writing any preflight file',async()=>{
 const notes={'first.md':note('alpha','alpha'),'unsupported.md':note('> beta','beta')};const f=await fixture(notes);
 try {
  await assert.rejects(run(f,true),/请选择支持的正文/);
  for(const [path,original] of Object.entries(notes))assert.equal(await readFile(join(f.vault,path),'utf8'),original.text);
  assert.equal(await readFile(f.sidecar,'utf8'),f.original);assert.deepEqual(await readdir(join(f.vault,'.obsidian/codex-notes-backups')),[]);
 } finally {await f.close();}
});

test('migration CLI refuses changed legacy HTML and preserves established backup-root prerequisite',async()=>{
 const original=note('alpha','alpha'),html=migrateMarkdownColors(original.text,original.ranges).text;
 const f=await fixture({'note.md':original},{'note.md':html+' changed'});
 try {
  await assert.rejects(run(f,true),/既不等于/);assert.equal(await readFile(f.sidecar,'utf8'),f.original);
  assert.equal(await readFile(join(f.vault,'note.md'),'utf8'),html+' changed');
  await writeFile(join(f.vault,'note.md'),original.text);await rm(join(f.vault,'.obsidian/codex-notes-backups'),{recursive:true});
  await assert.rejects(run(f,true),/ENOENT/);assert.equal(await readFile(f.sidecar,'utf8'),f.original);assert.equal(await readFile(join(f.vault,'note.md'),'utf8'),original.text);
 } finally {await f.close();}
});
