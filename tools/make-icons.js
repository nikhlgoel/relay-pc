'use strict';
/*
 * Draws Relay's own icon - an original mark, not WhatsApp's - and writes every
 * size the app needs:
 *
 *   npm run icons
 *
 * Rendered with a canvas inside a hidden Electron window, so no imaging
 * dependencies are needed. Output (src/assets): icon.png, icon.ico, tray.png,
 * tray@2x.png.
 */

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'src', 'assets');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

// Runs in the page: a rounded square in the app's blue with a bold white "R".
const DRAW = `(size) => {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const x = c.getContext('2d');
  const s = size;

  const r = s * 0.225;
  x.beginPath();
  x.moveTo(r, 0); x.lineTo(s - r, 0); x.quadraticCurveTo(s, 0, s, r);
  x.lineTo(s, s - r); x.quadraticCurveTo(s, s, s - r, s);
  x.lineTo(r, s); x.quadraticCurveTo(0, s, 0, s - r);
  x.lineTo(0, r); x.quadraticCurveTo(0, 0, r, 0);
  x.closePath();
  const g = x.createLinearGradient(0, 0, s, s);
  g.addColorStop(0, '#6aaee8');
  g.addColorStop(1, '#2b5278');
  x.fillStyle = g;
  x.fill();

  // The "R": stem, bowl and leg.
  const lw = s * 0.115;
  x.strokeStyle = '#ffffff';
  x.fillStyle = '#ffffff';
  x.lineWidth = lw;
  x.lineCap = 'round';
  x.lineJoin = 'round';

  const left = s * 0.31, top = s * 0.25, mid = s * 0.50, bottom = s * 0.75;
  x.beginPath();
  x.moveTo(left, bottom);
  x.lineTo(left, top);
  x.lineTo(s * 0.52, top);
  x.bezierCurveTo(s * 0.70, top, s * 0.70, mid, s * 0.52, mid);
  x.lineTo(left, mid);
  x.stroke();

  // Leg
  x.beginPath();
  x.moveTo(s * 0.50, mid);
  x.lineTo(s * 0.70, bottom);
  x.stroke();

  return c.toDataURL('image/png').split(',')[1];
}`;

async function main() {
  const win = new BrowserWindow({ show: false });
  await win.loadURL('about:blank');
  fs.mkdirSync(OUT, { recursive: true });

  const pngs = {};
  for (const size of SIZES) {
    const b64 = await win.webContents.executeJavaScript('(' + DRAW + ')(' + size + ')');
    pngs[size] = Buffer.from(b64, 'base64');
  }

  fs.writeFileSync(path.join(OUT, 'icon.png'), pngs[256]);
  fs.writeFileSync(path.join(OUT, 'tray.png'), pngs[16]);
  fs.writeFileSync(path.join(OUT, 'tray@2x.png'), pngs[32]);
  fs.writeFileSync(path.join(OUT, 'icon.ico'),
    encodeIco(SIZES.map((s) => [s, pngs[s]])));

  console.log('wrote icon.png, icon.ico, tray.png, tray@2x.png to', OUT);
  app.exit(0);
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

app.whenReady().then(main).catch((err) => { console.error(err); app.exit(1); });
