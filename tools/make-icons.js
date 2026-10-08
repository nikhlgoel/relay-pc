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
const SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];

// Runs in the page. A midnight-blue squircle with a soft glow of the accent colour,
// and a thin geometric R. The leg of the R fades out - a signal being passed on.
// Below 40px the strokes thicken and the fade is dropped so it still reads.
const DRAW = `(size) => {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const x = c.getContext('2d');
  const s = size;
  const small = s <= 40;

  // Tile
  const pad = s * 0.035, w = s - pad * 2, r = w * 0.235;
  x.beginPath();
  x.roundRect(pad, pad, w, w, r);
  const base = x.createLinearGradient(0, pad, 0, s - pad);
  base.addColorStop(0, '#17334f');
  base.addColorStop(1, '#0a1521');
  x.fillStyle = base;
  x.fill();
  x.save();
  x.clip();
  const glow = x.createRadialGradient(s * 0.30, s * 0.18, 0, s * 0.30, s * 0.18, s * 0.80);
  glow.addColorStop(0, 'rgba(98, 164, 235, 0.55)');
  glow.addColorStop(0.45, 'rgba(70, 126, 190, 0.20)');
  glow.addColorStop(1, 'rgba(60, 110, 170, 0)');
  x.fillStyle = glow;
  x.fillRect(0, 0, s, s);
  x.restore();
  // hairline highlight on the upper edge
  if (!small) {
    x.beginPath();
    x.roundRect(pad + 0.5, pad + 0.5, w - 1, w - 1, r);
    const edge = x.createLinearGradient(0, pad, 0, s * 0.6);
    edge.addColorStop(0, 'rgba(255,255,255,0.22)');
    edge.addColorStop(1, 'rgba(255,255,255,0)');
    x.strokeStyle = edge;
    x.lineWidth = Math.max(1, s * 0.006);
    x.stroke();
  }

  // The R. Coordinates are fractions of the canvas.
  const lw = s * (small ? 0.125 : 0.088);
  x.lineWidth = lw;
  x.lineCap = 'round';
  x.lineJoin = 'round';
  const X = (v) => v * s, Y = (v) => v * s;
  const stemX = 0.34, top = 0.265, bowlBottom = 0.505, foot = 0.735;
  const rad = (bowlBottom - top) / 2;

  const ink = x.createLinearGradient(0, Y(top), 0, Y(foot));
  ink.addColorStop(0, '#ffffff');
  ink.addColorStop(1, '#cfe3f8');
  x.strokeStyle = ink;
  x.beginPath();
  x.moveTo(X(stemX), Y(foot));
  x.lineTo(X(stemX), Y(top));
  x.lineTo(X(0.475), Y(top));
  x.arc(X(0.475), Y(top + rad), Y(rad), -Math.PI / 2, Math.PI / 2);
  x.lineTo(X(stemX), Y(bowlBottom));
  x.stroke();

  // Leg: a gentle curve that thins into the background.
  const leg = x.createLinearGradient(X(0.475), Y(bowlBottom), X(0.66), Y(foot));
  leg.addColorStop(0, 'rgb(230,241,251)');
  leg.addColorStop(1, small ? 'rgba(255,255,255,0.95)' : 'rgba(207,227,248,0.28)');
  x.strokeStyle = leg;
  x.beginPath();
  x.moveTo(X(0.47), Y(bowlBottom));
  x.quadraticCurveTo(X(0.56), Y(0.60), X(0.66), Y(foot));
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
