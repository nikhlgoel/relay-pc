'use strict';
// Live voice translation: the main-process logic, against a fake engine process (no models, no network).

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { setupVoice, cleanPrefs, toClip, makeReference, voteLanguage, LANGS, REF_SECONDS } = require('../src/voice');

function fakeEngine(log) {
  return {
    fork() {
      const proc = new EventEmitter();
      proc.kill = () => {};
      proc.postMessage = (m) => {
        log.push(m);
        setImmediate(() => {
          if (m.type === 'init') proc.emit('message', { type: 'ready', features: { mt: true, voice: true } });
          else if (m.type === 'job' && m.op === 'translate') proc.emit('message', { type: 'result', id: m.id, text: '[' + m.to + '] ' + m.text });
          else if (m.type === 'job' && m.op === 'synth') proc.emit('message', { type: 'result', id: m.id, pcm: new Float32Array(240).buffer, rate: 24000 });
          else if (m.type === 'job' && m.op === 'speaker') proc.emit('message', { type: 'result', id: m.id, emb: new Float32Array(256).buffer });
          else if (m.type === 'ensure') proc.emit('message', { type: 'ensured', what: m.what });
        });
      };
      return proc;
    }
  };
}

function make(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-voice-'));
  const data = { voiceConsent: { ok: true, google: false }, ...(overrides.store || {}) };
  const store = { get: (k) => data[k], set: (k, v) => { data[k] = v; }, delete: (k) => { delete data[k]; } };
  const log = [];
  const handlers = {};
  const v = setupVoice({
    app: { getPath: () => dir, getPreferredSystemLanguages: () => ['en-US'], getLocale: () => 'en-US' },
    store, handle: (ch, fn) => { handlers[ch] = fn; }, utilityProcess: fakeEngine(log),
    showBox: async () => ({ response: 0, checkboxChecked: false }), event() {}, pushState() {},
    transcribe: overrides.transcribe || (async () => ({ text: 'hello there', language: 'es' })),
    speechReady: () => true, downloadSpeech: async () => {}, modelsRoot: dir, fetch: async () => { throw new Error('offline'); }
  });
  fs.writeFileSync(path.join(dir, 'translategemma-4b-it-Q4_K_M.gguf'), 'x');
  fs.writeFileSync(path.join(dir, 'tone_color.onnx'), 'x');
  return { v, log, handlers, dir, data };
}

const clip = (secs = 1) => new Int16Array(Math.round(16000 * secs)).fill(1000);

test('voice prefs are always valid, whatever is stored', () => {
  assert.deepEqual(cleanPrefs(undefined, 'ru'), { in: true, out: true, hear: 'ru', they: 'auto', duck: 0.15 });
  assert.equal(cleanPrefs({ hear: 'klingon' }, 'xx').hear, 'en');
  assert.equal(cleanPrefs({ they: 'hi' }, 'en').they, 'hi');
  assert.equal(cleanPrefs({ duck: 7 }, 'en').duck, 0.15);
  assert.equal(cleanPrefs({ in: 'yes' }, 'en').in, true);
  assert.ok(['hi', 'zh', 'ru', 'es'].every((l) => LANGS.includes(l)));
});

test('a clip from the page must be sane audio', () => {
  assert.ok(toClip(clip(1)));
  assert.equal(toClip(new Int16Array(10)), null);
  assert.equal(toClip(new Int16Array(16000 * 30)), null);
  assert.equal(toClip('audio'), null);
  assert.equal(toClip(Buffer.alloc(3201)), null);
});

test('a voice is copied after about ten seconds of speech, and never more than twenty are kept', () => {
  const r = makeReference();
  for (let i = 0; i < 9; i++) r.add(Buffer.from(clip(1).buffer));
  assert.equal(r.ready, false);
  r.add(Buffer.from(clip(1).buffer));
  assert.equal(r.ready, true);
  for (let i = 0; i < 40; i++) r.add(Buffer.from(clip(1).buffer));
  assert.ok(r.pcm().length <= 16000 * 2 * 20);
  assert.equal(REF_SECONDS, 10);
});

test('the language of a speaker is the one that dominates the last few clips', () => {
  assert.equal(voteLanguage([]), 'auto');
  assert.equal(voteLanguage(['es']), 'auto');
  assert.equal(voteLanguage(['es', 'es', 'hi']), 'es');
  assert.equal(voteLanguage(['es', 'hi', 'ru', 'zh']), 'auto');
});

test('what the other person says is translated and spoken in the language you want to hear', async () => {
  const { v, log } = make();
  v._test.setSession(v._test.newSession());
  const r = await v._test.handleClip('in', clip(2), { seq: 4 });
  assert.equal(r.text, '[en] hello there');
  assert.equal(r.from, 'es');
  assert.equal(r.to, 'en');
  assert.equal(r.seq, 4);
  assert.equal(r.rate, 24000);
  assert.ok(r.pcm.byteLength > 0);
  const synth = log.find((m) => m.op === 'synth');
  assert.equal(synth.lang, 'en');
  assert.equal(synth.emb, null);                              // the voice has not been copied yet: the plain voice is used
});

test('speech already in the language you want is left alone', async () => {
  const { v } = make({ transcribe: async () => ({ text: 'good morning', language: 'en' }) });
  v._test.setSession(v._test.newSession());
  const r = await v._test.handleClip('in', clip(2), { seq: 1 });
  assert.equal(r.skipped, 'same-language');
  assert.equal(r.pcm, undefined);
});

test('your own voice: the other person hears a spoken notice first, once', async () => {
  const { v, log } = make({ transcribe: async () => ({ text: 'good morning', language: 'en' }), store: { voiceThey: 'hi' } });
  v._test.setSession(v._test.newSession());
  const a = await v._test.handleClip('out', clip(2), { seq: 1 });
  assert.equal(a.to, 'hi');
  assert.ok(a.notice && a.notice.pcm, 'the first sentence carries the notice');
  assert.match(a.notice.text, /^\[hi\] This call is being translated automatically/);
  const b = await v._test.handleClip('out', clip(2), { seq: 2 });
  assert.equal(b.notice, undefined);
  assert.equal(log.filter((m) => m.op === 'synth' && /translated automatically/.test(m.text)).length, 1);
});

test('without a known language for the other person nothing is invented', async () => {
  const { v } = make({ transcribe: async () => ({ text: 'good morning', language: 'en' }) });
  v._test.setSession(v._test.newSession());
  const r = await v._test.handleClip('out', clip(2), { seq: 1 });
  assert.equal(r.skipped, 'unknown-language');
});

test('switched off, or in the wrong direction, nothing happens', async () => {
  const { v, handlers } = make({ store: { voiceIn: false } });
  assert.equal((await v._test.handleClip('in', clip(2), {})).skipped, 'off');
  v._test.setSession(v._test.newSession());
  assert.equal((await v._test.handleClip('in', clip(2), {})).skipped, 'off');
  await assert.rejects(handlers['relay:voice-clip'](null, 'sideways', clip(2), {}), /Bad direction/);
});

test('ten seconds of your voice become a profile that stays on this PC; forgetting it stays forgotten for the call', async () => {
  const { v, handlers, dir } = make({ transcribe: async () => ({ text: 'good morning', language: 'en' }), store: { voiceThey: 'hi' } });
  v._test.setSession(v._test.newSession());
  for (let i = 0; i < 11; i++) await v._test.handleClip('out', clip(1.2), { seq: i });
  await new Promise((r) => setTimeout(r, 100));
  const file = path.join(dir, 'voice', 'me.bin');
  assert.ok(fs.existsSync(file), 'profile saved');
  assert.equal(fs.statSync(file).size, 256 * 4);
  assert.equal(v.state().myVoice, true);
  await handlers['relay:voice-forget']();
  assert.equal(fs.existsSync(file), false);
  for (let i = 0; i < 11; i++) await v._test.handleClip('out', clip(1.2), { seq: 20 + i });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(fs.existsSync(file), false, 'not saved again during the same call');
});

test('the feature is only offered when its engine files ship', () => {
  const { v } = make();
  const src = path.join(__dirname, '..', 'src', 'voice');
  assert.equal(v.available(), fs.existsSync(path.join(src, 'mt-local.js')) && fs.existsSync(path.join(src, 'voiceclone.js')));
});
