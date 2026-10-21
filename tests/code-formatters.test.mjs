import assert from 'node:assert/strict';
import test from 'node:test';
import { formatCode, formatJava, runFormatter, formatterExecutable } from '../src/code-formatters.ts';

const signal = () => new AbortController().signal;
const settings = { gofmtPath: '', blackPath: '' };
test('real Go and Black stdin tools format complete files and common snippets', async () => {
 for (const [language, input, expected] of [
  ['go','package main\nfunc main(){println("hi")}\n','func main() { println("hi") }'],
  ['go','x:=1\nprintln(x)\n','x := 1'],
  ['python','def hi(name):\n print( "hello",name )\n','    print("hello", name)']
 ]) {
  const result = await formatCode(language,input,settings,signal());
  assert.equal(result.status,'formatted',JSON.stringify(result));
  assert.ok(result.code.includes(expected),result.code);
 }
 assert.equal((await formatCode('go','func {',settings,signal())).status,'invalid');
 assert.equal((await formatCode('python','def :',settings,signal())).status,'invalid');
});
test('Java bundled parser formats full classes, methods and statements, preserving strings', async () => {
 for (const input of ['class Hi{public static void main(String[] args){System.out.println("hello");}}','public void hi(){System.out.println("hello");}','System.out.println("hello");']) {
  const result = await formatJava(input,signal());
  assert.equal(result.status,'formatted');
  assert.ok(result.code.includes('System.out.println("hello");'));
  assert.ok(!result.code.includes('NoteGlowFragment'));
 }
 assert.equal((await formatJava('not valid !!!',signal())).status,'invalid');
 assert.equal((await formatJava('x'.repeat(20_001),signal())).status,'too-large');
 const controller = new AbortController(); controller.abort();
 assert.equal((await formatJava('class Hi{}',controller.signal)).status,'cancelled');
});
test('runner fails closed for absent tool, exit failure, timeout, cancellation and output/input limits', async () => {
 assert.equal((await runFormatter('/noteglow/missing',[], 'x',signal())).status,'unavailable');
 assert.equal((await runFormatter(process.execPath,['-e','process.exit(2)'],'x',signal())).status,'invalid');
 assert.equal((await runFormatter(process.execPath,['-e','setInterval(()=>{},1000)'],'x',signal(),20)).status,'timeout');
 assert.equal((await runFormatter(process.execPath,['-e','process.stdout.write("x".repeat(400001))'],'',signal())).status,'too-large');
 assert.equal((await runFormatter(process.execPath,['-e','process.stderr.write("x".repeat(400001))'],'',signal())).status,'too-large');
 assert.equal((await runFormatter(process.execPath,[], 'x'.repeat(200001),signal())).status,'too-large');
 const controller = new AbortController();
 const pending = runFormatter(process.execPath,['-e','setInterval(()=>{},1000)'],'x',controller.signal);
 controller.abort(); assert.equal((await pending).status,'cancelled');
 assert.equal((await runFormatter(process.execPath,[], 'x',controller.signal)).status,'cancelled');
 assert.equal(formatterExecutable('gofmt',' /custom/gofmt '),'/custom/gofmt');
 assert.ok(formatterExecutable('black','~/bin/black').endsWith('/bin/black'));
});
