import assert from 'node:assert/strict';
import test from 'node:test';
import { codeLanguage, findFormatTarget, formattedEdit } from '../src/code-format.ts';
import { applyNativeCodeColor } from '../src/native-code-colors.ts';

const text = 'before\n\n```\nfunc hello(){fmt.Println("hello")}\n```\n\nafter';
test('explicit languages win; only strong unambiguous signals are inferred', () => {
 for (const [label, expected] of [['go','go'],['GOLANG','go'],['py','python'],['python','python'],['java','java'],['javascript',null],['constructor',null],['__proto__',null]]) assert.equal(codeLanguage('anything',label),expected);
 for (const [input, expected] of [['func hello() {}','go'],['x:=1','go'],['fmt.Println("x")','go'],['def hello():\n pass','python'],['print("x")','python'],['class Hi {}','java'],['System.out.println("x");','java'],['public void hello(){}','java'],['foo()',null],['hello world',null],['# func hello() {}',null],['"func hello() {}"',null],['// def hello():',null],['func hi() {}\ndef hi():',null]]) assert.equal(codeLanguage(input,''),expected,input);
});
test('single top-level closed block only; metadata and explicit unknown language are protected', () => {
 const from = text.indexOf('func');
 assert.equal(findFormatTarget(text,from,from+4).language,'go');
 for (const source of ['```\nfunc hi(){}','  ```\nfunc hi(){}\n  ```','> ```\n> func hi(){}\n> ```','```js\nfunc hi(){}\n```','```\n\n```']) assert.equal(findFormatTarget(source,source.indexOf('\n')+1,source.indexOf('\n')+1),null);
 assert.equal(findFormatTarget(text,0,from),null);
 assert.equal(findFormatTarget(text,-1,3),null);
 assert.equal(findFormatTarget(text,3,2),null);
 assert.equal(findFormatTarget(text,0,text.length+1),null);
 const colored = applyNativeCodeColor(text,from,from+4,'foreground','#112233').text;
 assert.equal(findFormatTarget(colored,from,from+4),null);
 assert.equal(findFormatTarget(colored.replace('noteglow-code-colors:1','noteglow-code-colors:9'),from,from+4),null);
 const large = '```java\n'+ 'x'.repeat(20_001)+'\n```';
 assert.equal(findFormatTarget(large,8,9),null);
});
test('safe result updates language and code together, preserves neighbors and CRLF, and is idempotent', () => {
 const target = findFormatTarget(text,text.indexOf('func'),text.indexOf('func')+4);
 const edit = formattedEdit(target,'func hello() {\n\tfmt.Println("hello")\n}\n');
 const result = text.slice(0,edit.from)+edit.insert+text.slice(edit.to);
 assert.equal(result,'before\n\n```go\nfunc hello() {\n\tfmt.Println("hello")\n}\n```\n\nafter');
 assert.equal(result[edit.cursor], '\n');
 const again = findFormatTarget(result,result.indexOf('func'),result.indexOf('func')+4);
 assert.equal(formattedEdit(again,again.block.code),null);
 const crlf = '```py\r\nprint( 1 )\r\n```';
 const change = formattedEdit(findFormatTarget(crlf,7,8),'print(1)\n');
 assert.equal(change.insert,'```py\r\nprint(1)\r\n');
 for (const invalid of ['', ' ', '\0', '```\n', '```\r\n', 'x'.repeat(400_001)]) assert.equal(formattedEdit(target,invalid),null);
});
