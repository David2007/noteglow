import { deflateSync } from 'node:zlib';

export function png(width = 24, height = 16, color = [213, 37, 42]) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) color.forEach((value, c) => { raw[y * (width * 3 + 1) + 1 + x * 3 + c] = value; });
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function chunk(name, data) {
  const type = Buffer.from(name), size = Buffer.alloc(4), crc = Buffer.alloc(4); size.writeUInt32BE(data.length);
  let sum = 0xffffffff;
  for (const value of Buffer.concat([type, data])) { sum ^= value; for (let i = 0; i < 8; i++) sum = (sum >>> 1) ^ ((sum & 1) ? 0xedb88320 : 0); }
  crc.writeUInt32BE((sum ^ 0xffffffff) >>> 0);
  return Buffer.concat([size, type, data, crc]);
}
