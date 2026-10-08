'use strict';
/*
 * Gives the development copy of Electron Relay's icon and name.
 *
 *   npm start   (runs this first, see "prestart" in package.json)
 *
 * Running from source uses node_modules/electron/dist/electron.exe, and Windows takes
 * the taskbar, Alt-Tab and Task Manager identity from that file: Electron's atom and
 * the name "Electron". This swaps the icon and the name inside the file (once; it is
 * remembered) with rcedit, which electron-builder already installs. A packaged build
 * (npm run dist) is branded by electron-builder and does not need this.
 *
 * Never blocks `npm start`: if the file is in use or rcedit is missing it just says so.
 * `npm install` restores the stock file; the next `npm start` brands it again.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

if (process.platform !== 'win32') process.exit(0);

const root = path.join(__dirname, '..');
const icon = path.join(root, 'src', 'assets', 'icon.ico');

function findRcedit() {
  const direct = path.join(root, 'node_modules', 'electron-winstaller', 'vendor', 'rcedit.exe');
  if (fs.existsSync(direct)) return direct;
  const cache = path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache', 'winCodeSign');
  try {
    for (const d of fs.readdirSync(cache)) {
      const p = path.join(cache, d, 'rcedit-x64.exe');
      if (fs.existsSync(p)) return p;
    }
  } catch (e) { /* no cache */ }
  return null;
}

function main() {
  let exe;
  try { exe = require('electron'); } catch (e) { return; }
  if (typeof exe !== 'string' || !fs.existsSync(exe) || !fs.existsSync(icon)) return;

  const version = (() => { try { return require('electron/package.json').version; } catch (e) { return ''; } })();
  const stamp = crypto.createHash('sha1').update(fs.readFileSync(icon)).update(version).digest('hex');
  const marker = path.join(path.dirname(exe), '.relay-branded');
  if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') === stamp) return;

  const rcedit = findRcedit();
  if (!rcedit) { console.warn('[brand] rcedit not found; Electron keeps its own icon in the taskbar for this run'); return; }
  try {
    execFileSync(rcedit, [
      exe, '--set-icon', icon,
      '--set-version-string', 'ProductName', 'Relay',
      '--set-version-string', 'FileDescription', 'Relay',
      '--set-version-string', 'InternalName', 'Relay',
      '--set-version-string', 'CompanyName', 'nikhlgoel'
    ], { stdio: 'pipe', windowsHide: true });
    fs.writeFileSync(marker, stamp);
    console.log('[brand] electron.exe now carries the Relay icon and name');
  } catch (e) {
    console.warn('[brand] could not update electron.exe (is Relay already running?). Quit it and run npm start again.');
  }
}

main();
