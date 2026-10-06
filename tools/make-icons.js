'use strict';
/*
 * Build the app icons from a source logo image.
 *
 *   npm run icons -- <path-to-image>
 *
 * Run under Electron so nativeImage can decode JPEG/PNG for us — no imaging
 * dependencies. The source we were given is a stock "transparent PNG" mockup
 * flattened to JPEG, so the checkerboard is real pixels; we key it out by
 * greenness, which also gives us clean antialiased edges for free.
 */

const { app, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'src', 'assets');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

function main() {
  const src = process.argv.slice(2).find((a) => !a.startsWith('-'));
  if (!src) {
    console.error('usage: npm run icons -- <image>');
    app.exit(1);
    return;
  }

  const img = nativeImage.createFromPath(path.resolve(src));
  if (img.isEmpty()) {
    console.error('could not decode ' + src);
    app.exit(1);
    return;
  }

  const { width, height } = img.getSize();
  const bgra = img.toBitmap();
  console.log('source: %dx%d', width, height);

  const logo = keyOutBackground(bgra, width, height);
  const box = boundingBox(logo, width, height);
  console.log('logo bounds: %o', box);

  const square = cropToSquare(logo, width, height, box, 0.12);
  console.log('cropped to %dx%d', square.size, square.size);

  fs.mkdirSync(OUT, { recursive: true });
  const pngs = {};
  for (const size of SIZES) {
    const scaled = downsample(square.data, square.size, size);
    pngs[size] = encodePng(scaled, size);
  }

  fs.writeFileSync(path.join(OUT, 'icon.png'), pngs[256]);
  fs.writeFileSync(path.join(OUT, 'tray.png'), pngs[16]);
  fs.writeFileSync(path.join(OUT, 'tray@2x.png'), pngs[32]);
  fs.writeFileSync(path.join(OUT, 'icon.ico'),
    encodeIco(SIZES.map((s) => [s, pngs[s]])));

  console.log('wrote icon.png, icon.ico, tray.png, tray@2x.png to', OUT);
  app.exit(0);
}

/**
 * Turn the flattened checkerboard/white backdrop into real transparency.
 *
 * The logo is saturated green (g clearly above r and b); every background
 * pixel is neutral grey or white (r ~= g ~= b). So "how green is this pixel"
 * doubles as an alpha channel, and partially-covered edge pixels — which are
 * green blended toward white — land on partial alpha automatically.
 */
function keyOutBackground(bgra, w, h) {
  const n = w * h;
  const greenness = new Float32Array(n);
  let peak = 0;

  for (let i = 0; i < n; i++) {
    const b = bgra[i * 4], g = bgra[i * 4 + 1], r = bgra[i * 4 + 2];
    const v = g - Math.max(r, b);
    greenness[i] = v;
    if (v > peak) peak = v;
  }
  if (peak <= 0) throw new Error('no green logo found in the source image');

  // Average colour of the most saturated pixels — the logo's true green.
  let sr = 0, sg = 0, sb = 0, count = 0;
  for (let i = 0; i < n; i++) {
    if (greenness[i] > peak * 0.9) {
      sb += bgra[i * 4]; sg += bgra[i * 4 + 1]; sr += bgra[i * 4 + 2];
      count++;
    }
  }
  const cr = Math.round(sr / count), cg = Math.round(sg / count),
        cb = Math.round(sb / count);
  console.log('logo colour: #%s',
    [cr, cg, cb].map((c) => c.toString(16).padStart(2, '0')).join(''));

  // A small floor kills JPEG ringing in the flat background.
  const floor = peak * 0.04;
  const rgba = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    const a = greenness[i] <= floor
      ? 0
      : Math.min(255, Math.round((greenness[i] / peak) * 255));
    rgba[i * 4] = cr;
    rgba[i * 4 + 1] = cg;
    rgba[i * 4 + 2] = cb;
    rgba[i * 4 + 3] = a;
  }
  return rgba;
}

function boundingBox(rgba, w, h) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (rgba[(y * w + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) throw new Error('image is fully transparent after keying');
  return { x0, y0, x1, y1 };
}

/** Centre the logo in a transparent square with `pad` fraction of margin. */
function cropToSquare(rgba, w, h, box, pad) {
  const bw = box.x1 - box.x0 + 1;
  const bh = box.y1 - box.y0 + 1;
  const size = Math.round(Math.max(bw, bh) * (1 + pad * 2));
  const ox = Math.round((size - bw) / 2) - box.x0;
  const oy = Math.round((size - bh) / 2) - box.y0;

  const data = Buffer.alloc(size * size * 4);
  for (let y = box.y0; y <= box.y1; y++) {
    for (let x = box.x0; x <= box.x1; x++) {
      const dx = x + ox, dy = y + oy;
      if (dx < 0 || dy < 0 || dx >= size || dy >= size) continue;
      rgba.copy(data, (dy * size + dx) * 4, (y * w + x) * 4, (y * w + x) * 4 + 4);
    }
  }
  return { data, size };
}

/** Box-filter downscale. Averages colour weighted by alpha so edges stay clean. */
function downsample(src, srcSize, dstSize) {
  const out = Buffer.alloc(dstSize * dstSize * 4);
  const ratio = srcSize / dstSize;

  for (let dy = 0; dy < dstSize; dy++) {
    const sy0 = Math.floor(dy * ratio);
    const sy1 = Math.max(sy0 + 1, Math.floor((dy + 1) * ratio));
    for (let dx = 0; dx < dstSize; dx++) {
      const sx0 = Math.floor(dx * ratio);
      const sx1 = Math.max(sx0 + 1, Math.floor((dx + 1) * ratio));

      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let y = sy0; y < sy1; y++) {
        for (let x = sx0; x < sx1; x++) {
          const i = (y * srcSize + x) * 4;
          const av = src[i + 3];
          r += src[i] * av; g += src[i + 1] * av; b += src[i + 2] * av;
          a += av;
          n++;
        }
      }
      const o = (dy * dstSize + dx) * 4;
      if (a === 0) continue;
      out[o] = Math.round(r / a);
      out[o + 1] = Math.round(g / a);
      out[o + 2] = Math.round(b / a);
      out[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

function encodePng(rgba, size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  const chunk = (tag, data) => {
    const body = Buffer.concat([Buffer.from(tag, 'ascii'), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/** ICO permits embedding PNGs verbatim, which is what modern Windows prefers. */
function encodeIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);

  let offset = 6 + 16 * entries.length;
  const dir = [];
  for (const [size, png] of entries) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4);    // colour planes
    e.writeUInt16LE(32, 6);   // bits per pixel
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    dir.push(e);
  }
  return Buffer.concat([header, ...dir, ...entries.map(([, png]) => png)]);
}

app.whenReady().then(main);
