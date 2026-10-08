'use strict';
// Keeps the in-app Relay panel's three halves in step: the page modules, the
// preload's allow-listed bridge, and the main-process handlers.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8');
const pageFiles = fs.readdirSync(path.join(SRC, 'page')).filter((f) => f.endsWith('.js')).sort();

test('every page module parses', () => {
  assert.ok(pageFiles.length >= 4);
  for (const f of pageFiles) assert.doesNotThrow(() => new Function(read('page', f)), f);
});

test('main.js delivers exactly the page modules that exist, core first', () => {
  const list = /PAGE_MODULES = \[([^\]]+)\]/.exec(read('main.js'));
  assert.ok(list, 'PAGE_MODULES not found');
  const names = [...list[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.equal(names[0], 'core');
  assert.deepEqual([...names].sort(), pageFiles.map((f) => f.replace(/\.js$/, '')));
});

test('bridge channels, page calls and main handlers agree', () => {
  const channels = new Set(
    [...(/RELAY_CHANNELS = new Set\(\[([\s\S]*?)\]\)/.exec(read('preload.js'))[1]).matchAll(/'([^']+)'/g)].map((m) => m[1]));
  const handlers = new Set([...(read('main.js') + read('hub.js')).matchAll(/handle\('relay:([\w-]+)'/g)].map((m) => m[1]));
  for (const c of channels) assert.ok(handlers.has(c), 'no handler for relay:' + c);
  for (const h of handlers) assert.ok(channels.has(h), 'relay:' + h + ' is not reachable from the page');

  const pageSrc = pageFiles.map((f) => read('page', f)).join('\n') + read('preload.js');
  for (const m of pageSrc.matchAll(/\bR\.call\('([\w-]+)'/g)) assert.ok(channels.has(m[1]), 'page calls unknown channel ' + m[1]);
  for (const m of pageSrc.matchAll(/R\.call\('set', '(\w+)'/g)) assert.match(read('hub.js'), new RegExp('\\b' + m[1] + ':'), 'switch ' + m[1]);
});

test('the API key never travels through the page', () => {
  assert.doesNotMatch(read('preload.js'), /'key-set'/);
  assert.match(read('hub.js'), /promptKey/);
  for (const f of pageFiles) assert.doesNotMatch(read('page', f), /apiKey|x-api-key/i, f);
});

test('the icon set is complete', () => {
  const dir = path.join(SRC, 'assets');
  for (const f of ['icon.png', 'icon.ico', 'tray.png', 'tray@2x.png']) assert.ok(fs.existsSync(path.join(dir, f)), f);
  const ico = fs.readFileSync(path.join(dir, 'icon.ico'));
  assert.equal(ico.readUInt16LE(2), 1, 'not an .ico');
  assert.ok(ico.readUInt16LE(4) >= 7, 'the .ico needs the usual sizes (16 to 256)');
});

test('the vendored noise suppressor is present with its licence', () => {
  const dir = path.join(SRC, 'vendor', 'rnnoise');
  for (const f of ['worklet.js', 'rnnoise.wasm', 'rnnoise_simd.wasm', 'LICENSE']) assert.ok(fs.existsSync(path.join(dir, f)), f);
  assert.doesNotMatch(read('vendor', 'rnnoise', 'worklet.js'), /sourceMappingURL/);
  assert.equal(fs.readFileSync(path.join(dir, 'rnnoise.wasm')).subarray(0, 4).toString('latin1'), '\0asm');
});

test('edge: stored quick replies are cleaned before the page ever sees them', () => {
  const { cleanSnippets } = require('../src/hub');
  assert.deepEqual(cleanSnippets('abc'), []);
  assert.deepEqual(cleanSnippets(null), []);
  assert.deepEqual(cleanSnippets([null, 5, { text: '   ' }, { text: 7 }]), []);
  const out = cleanSnippets([{ id: 'a', text: 'ok' }, { text: 'x'.repeat(5000) }, ...Array.from({ length: 80 }, () => ({ text: 'n' }))]);
  assert.equal(out.length, 40);                                   // at most MAX_SNIPPETS
  assert.equal(out[0].text, 'ok');
  assert.equal(out[1].text.length, 1000);                         // clipped
  assert.ok(out.every((s) => typeof s.id === 'string' && s.id.length > 0));
});

test('edge: a damaged settings file cannot stop the app starting', () => {
  const main = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8');
  assert.match(main, /function openStore\(/);                      // retries with a fresh file
  assert.match(main, /sanitizeStore/);                              // and drops values of the wrong type
});

test('edge: nothing automated may touch the real desktop', () => {
  const main = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8');
  // every user-visible side effect has a RELAY_TEST guard
  for (const needle of ["globalShortcut.register", "createTray()", 'toast(title, body, onClick) {']) {
    const i = main.indexOf(needle);
    assert.ok(i > 0, needle);
  }
  assert.match(main, /if \(!process\.env\.RELAY_TEST\) globalShortcut/);
  assert.match(main, /process\.env\.RELAY_TEST \|\| !Notification\.isSupported\(\)/);
});
