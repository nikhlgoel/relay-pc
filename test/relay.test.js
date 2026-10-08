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
  assert.deepEqual(names.slice(0, 2), ['i18n', 'core']);       // the translations first, then the shared core
  assert.deepEqual([...names].sort(), pageFiles.map((f) => f.replace(/\.js$/, '')));
});

test('bridge channels, page calls and main handlers agree', () => {
  const channels = new Set(
    [...(/RELAY_CHANNELS = new Set\(\[([\s\S]*?)\]\)/.exec(read('preload.js'))[1]).matchAll(/'([^']+)'/g)].map((m) => m[1]));
  const handlers = new Set([...(read('main.js') + read('hub.js') + read('captions.js')).matchAll(/handle\('relay:([\w-]+)'/g)].map((m) => m[1]));
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

test('proxy address: accepts host:port forms, rejects anything else', () => {
  const { cleanProxy } = require('../src/hub');
  for (const ok of ['127.0.0.1:7890', 'socks5://127.0.0.1:1080', 'http://proxy.example.com:8080', 'HTTPS://p.example:443']) {
    assert.equal(cleanProxy(ok), ok.trim(), ok);
  }
  assert.equal(cleanProxy(''), '');
  assert.equal(cleanProxy('   '), '');
  assert.equal(cleanProxy(undefined), '');
  for (const bad of ['127.0.0.1', 'host:99999', 'ftp://a.b:21', 'a b:80', 'http://a.b:80/path', 'file:///c:/x', '--proxy-server=x:1', 'a.b:8080;evil.c:1']) {
    assert.equal(cleanProxy(bad), null, bad);
  }
});

// ---- Chinese / Russian text of the Relay panel -----------------------------------------------------
function translatorFor(lang) {
  const vm = require('node:vm');
  const win = { __relayLang: lang };
  vm.runInNewContext(read('page/i18n.js'), { window: win, navigator: { language: 'en-US' } });
  return win;
}

test('i18n: Chinese and Russian have the same phrases, and a missing phrase stays English', () => {
  const zh = translatorFor('zh'), ru = translatorFor('ru');
  assert.deepEqual(Object.keys(zh.__relayDict.zh).sort(), Object.keys(ru.__relayDict.ru).sort());
  assert.equal(zh.__relayT('Sharper video'), '更清晰的视频');
  assert.equal(ru.__relayT('Sharper video'), 'Чёткое видео');
  assert.equal(zh.__relayT('Something nobody translated'), 'Something nobody translated');
  assert.equal(translatorFor('en').__relayT('Sharper video'), 'Sharper video');
  assert.equal(translatorFor('de').__relayT('Sharper video'), 'Sharper video');
});

test('i18n: phrases with a changing part, and names that must never change', () => {
  const zh = translatorFor('zh'), ru = translatorFor('ru');
  assert.equal(zh.__relayT('Downloading speech model 42%'), '正在下载语音模型 42%');
  assert.equal(ru.__relayT('Relay connects through 127.0.0.1:7890'), 'Relay подключается через 127.0.0.1:7890');
  assert.equal(ru.__relayT('Your OpenRouter key is saved on this PC'), 'Ваш ключ OpenRouter сохранён на этом компьютере');
  // the call-button names Relay searches for are labels, never passed through the translator
  const callers = read('page/calls.js') + read('page/captions.js');
  assert.ok(!/__relayT|R\.t\(/.test(read('page/calls.js')), 'calls.js must not translate the labels it searches for');
  assert.ok(/aria-label/.test(callers));
});
