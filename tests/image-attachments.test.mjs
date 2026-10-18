import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { inspectImage, validateImages, parseImages, isImageAttachment, MAX_IMAGE_BYTES } from '../src/image-attachments.ts';
import { png } from './fixtures/image-fixtures.mjs';

function image(overrides = {}) {
  const id = randomUUID();
  return {id, name:'示例.png', fileName:`${id}.png`, mime:'image/png', size:100, width:24, height:16, sha256:'a'.repeat(64), ...overrides};
}
test('recognizes actual PNG bytes even when an imported file has an unrelated extension', () => {
  assert.deepEqual(inspectImage(png()), {mime:'image/png', width:24, height:16});
});
test('JPEG frame dimensions, both baseline and progressive, do not depend on filename or EXIF', () => {
  for (const marker of [0xc0,0xc2]) {
    const b = Buffer.from([0xff,0xd8, 0xff,0xe0,0,4,0,0, 0xff,marker,0,8,8,0,80,0,120,3, 0xff,0xd9]);
    assert.deepEqual(inspectImage(b), {mime:'image/jpeg',width:120,height:80});
  }
});
test('accepts VP8X, VP8L and lossy VP8 still images and rejects animated WebP', () => {
  for (const kind of ['VP8X','VP8L','VP8 ']) {
    const b=Buffer.alloc(30); b.write('RIFF');b.writeUInt32LE(22,4);b.write('WEBP',8);b.write(kind,12);
    if(kind==='VP8X'){b[24]=23;b[27]=15;}
    if(kind==='VP8L'){b[20]=0x2f;b.writeUInt32LE(23|(15<<14),21);}
    if(kind==='VP8 '){b.set([0x9d,1,0x2a],23);b.writeUInt16LE(24,26);b.writeUInt16LE(16,28);}
    assert.deepEqual(inspectImage(b),{mime:'image/webp',width:24,height:16});
    if(kind==='VP8X'){b[20]=2;assert.throws(()=>inspectImage(b),/动画/);}
  }
});
test('rejects unsupported, truncated, empty, oversized and excessive-pixel payloads', () => {
  for(const b of [Buffer.alloc(0),Buffer.alloc(MAX_IMAGE_BYTES+1)])assert.throws(()=>inspectImage(b),/10 MiB/);
  for(const b of [Buffer.from('GIF89a'),Buffer.from('<svg/>'),Buffer.from([255,216,255]),Buffer.alloc(30)])assert.throws(()=>inspectImage(b));
  const b=png();b.writeUInt32BE(20000,16);assert.throws(()=>inspectImage(b),/尺寸/);
  b.writeUInt32BE(8000,16);b.writeUInt32BE(8000,20);assert.throws(()=>inspectImage(b),/像素/);
  b.writeUInt32BE(0,16);assert.throws(()=>inspectImage(b),/尺寸/);
});
test('validates per-image metadata, path and MIME together instead of trusting JSON paths', () => {
  const good=image();assert.equal(isImageAttachment(good),true);
  for(const override of [{fileName:'../auth.json'},{id:'../x'},{mime:'text/html'},{sha256:'broken'},{size:0},{size:MAX_IMAGE_BYTES+1},{width:0},{name:'\nsecret'},{name:'a'.repeat(201)}])assert.equal(isImageAttachment({...good,...override}),false);
  assert.equal(isImageAttachment(null),false);assert.equal(isImageAttachment([]),false);
});
test('enforces four images and 20MiB at exact boundaries independently of text limits', () => {
  assert.equal(validateImages([image({size:MAX_IMAGE_BYTES}),image({size:MAX_IMAGE_BYTES})]),null);
  assert.match(validateImages([image({size:MAX_IMAGE_BYTES}),image({size:MAX_IMAGE_BYTES}),image()]),/20 MiB/);
  assert.equal(validateImages(Array.from({length:4},()=>image())),null);
  assert.match(validateImages(Array.from({length:5},()=>image())),/4/);
  assert.match(validateImages([{}]),/不完整/);
});
test('loads legacy settings with no images and drops malformed image paths, never dereferences them', () => {
  assert.deepEqual(parseImages(undefined),[]);assert.deepEqual(parseImages({images:[]}),[]);
  const one=image(), two=image(); const parsed=parseImages([one,{...one,fileName:'/etc/passwd'},two]);
  assert.deepEqual(parsed,[one,two]);assert.notEqual(parsed[0],one);
  assert.equal(parseImages(Array.from({length:5},()=>image())).length,4);
});
