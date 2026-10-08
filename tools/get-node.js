'use strict';
/*
 * Fetches the plain Node.js runtime that the live-voice engine runs in (tools/runtime/node.exe, git-ignored), and checks it
 * against nodejs.org's published SHA-256. Run by `npm run dist` (see "predist" in package.json); safe to run again.
 *
 * Why a separate Node: Electron forbids native add-ons from handing out "external buffers", which the speech-synthesis
 * library (sherpa-onnx) does for every sentence, so the engine cannot run inside Electron's own processes.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const VERSION = 'v22.23.3';
const SHA256 = '9c9245166b4a8e182e0b797da9c20136117ff24368eaff1fec8343a123c8db0e';
const URL = 'https://nodejs.org/dist/' + VERSION + '/win-x64/node.exe';
const DEST = path.join(__dirname, 'runtime', 'node.exe');

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function download(url, file) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); return resolve(download(res.headers.location, file)); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('nodejs.org answered ' + res.statusCode)); }
      const out = fs.createWriteStream(file);
      res.pipe(out);
      out.on('finish', () => out.close(resolve));
      out.on('error', reject);
      res.on('error', reject);
    }).on('error', reject);
  });
}

(async () => {
  if (fs.existsSync(DEST) && sha(DEST) === SHA256) { console.log('node.exe ' + VERSION + ' is in place'); return; }
  fs.mkdirSync(path.dirname(DEST), { recursive: true });
  const part = DEST + '.part';
  console.log('downloading ' + URL);
  await download(URL, part);
  if (sha(part) !== SHA256) { fs.unlinkSync(part); throw new Error('node.exe does not match the published checksum'); }
  fs.renameSync(part, DEST);
  console.log('node.exe ' + VERSION + ' downloaded and verified');
})().catch((e) => { console.error(String((e && e.message) || e)); process.exit(1); });
