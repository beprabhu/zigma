// Generate simple sample product PNGs (solid shapes) for local testing — no deps, uses zlib.
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

// draw: (x, y) => [r, g, b, a]
function makePNG(w, h, draw) {
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    const rowStart = y * (1 + w * 4);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = draw(x, y);
      const o = rowStart + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = path.join(__dirname, '..', 'public', 'samples');
fs.mkdirSync(outDir, { recursive: true });

// Sample A: orange "bottle" (tall rounded rect) on white
fs.writeFileSync(path.join(outDir, 'bottle.png'), makePNG(400, 500, (x, y) => {
  const inBody = x > 140 && x < 260 && y > 120 && y < 480;
  const inNeck = x > 175 && x < 225 && y > 40 && y <= 120;
  if (inBody) return [235, 110, 40, 255];
  if (inNeck) return [180, 80, 25, 255];
  return [255, 255, 255, 255];
}));

// Sample B: blue "box" on white
fs.writeFileSync(path.join(outDir, 'box.png'), makePNG(500, 400, (x, y) => {
  const inBox = x > 80 && x < 420 && y > 100 && y < 380;
  const inLabel = x > 140 && x < 360 && y > 180 && y < 260;
  if (inLabel) return [255, 255, 255, 255];
  if (inBox) return [45, 105, 220, 255];
  return [255, 255, 255, 255];
}));

// Sample C: green "jar"
fs.writeFileSync(path.join(outDir, 'jar.png'), makePNG(400, 400, (x, y) => {
  const cx = 200, cy = 240;
  const inJar = (x - cx) ** 2 / (130 ** 2) + (y - cy) ** 2 / (150 ** 2) < 1;
  const inLid = x > 130 && x < 270 && y > 60 && y < 100;
  if (inLid) return [60, 60, 60, 255];
  if (inJar) return [60, 170, 90, 255];
  return [255, 255, 255, 255];
}));

// Sample CSV
const csv = [
  'Product Title,Image URL 1,Image URL 2,Discount',
  '"Orange Bottle + Blue Box Combo",http://localhost:3000/samples/bottle.png,http://localhost:3000/samples/box.png,20% OFF',
  '"Green Jar & Bottle Pack",http://localhost:3000/samples/jar.png,http://localhost:3000/samples/bottle.png,FLAT ₹50 OFF',
  '"Blue Box Solo",http://localhost:3000/samples/box.png,,',
].join('\n');
fs.writeFileSync(path.join(outDir, 'sample.csv'), csv);

console.log('Samples written to', outDir);
