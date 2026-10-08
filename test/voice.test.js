'use strict';
// Live voice translation: the main-process logic, against a fake engine process (no models, no network).

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { setupVoice, cleanPrefs, toClip, makeReference, voteLanguage, LANGS, REF_SECONDS } = require('../src/voice');

function fakeEngine(log, translate, procs, synth) {
  return {
    fork() {
      const proc = new EventEmitter();
      if (procs) procs.push(proc);
      proc.kill = () => {};
      proc.postMessage = (m) => {
        log.push(m);
        setImmediate(() => {
          if (m.type === 'init') proc.emit('message', { type: 'ready', features: { mt: true, voice: true } });
          else if (m.type === 'job' && m.op === 'warm') proc.emit('message', { type: 'result', id: m.id, mt: true, voice: true });
          else if (m.type === 'job' && m.op === 'translate') {
            const t = translate ? translate(m) : '[' + m.to + '] ' + m.text;
            if (t && t.__error) proc.emit('message', { type: 'error', id: m.id, message: t.__error }); else proc.emit('message', { type: 'result', id: m.id, text: t });
          } else if (m.type === 'job' && m.op === 'synth') {
            const r = synth ? synth(m) : null;
            if (r && r.__error) proc.emit('message', { type: 'error', id: m.id, message: r.__error });
            else proc.emit('message', { type: 'result', id: m.id, pcm: r ? r.pcm : new Float32Array(240).buffer, rate: 24000 });
          }
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
    store, handle: (ch, fn) => { handlers[ch] = fn; }, utilityProcess: fakeEngine(log, overrides.translate, overrides.procs, overrides.synth),
    showBox: async () => ({ response: overrides.decline ? 1 : 0, checkboxChecked: false }), event: overrides.event || (() => {}), pushState() {},
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

test('audio travels between the app and the engine as plain JSON and comes back identical', () => {
  const { encode, decode } = require('../src/voice-ipc');
  const f = new Float32Array([0.5, -0.25, 1]);
  const msg = { type: 'job', id: 3, op: 'synth', text: 'hola', emb: f, nested: { pcm: new Int16Array([1, -2, 3]).buffer, list: [Buffer.from([9, 8])] } };
  const wire = JSON.parse(JSON.stringify(encode(msg)));
  const back = decode(wire);
  assert.equal(back.text, 'hola');
  assert.deepEqual([...new Float32Array(back.emb)], [0.5, -0.25, 1]);
  assert.deepEqual([...new Int16Array(back.nested.pcm)], [1, -2, 3]);
  assert.deepEqual([...new Uint8Array(back.nested.list[0])], [9, 8]);
  assert.equal(encode(null), null);
  assert.deepEqual(decode({ a: { __bin: 'AQI=', extra: 1 } }).a, { __bin: 'AQI=', extra: 1 }, 'a lookalike object is left alone');
});

test('a translation that is just the same words is not spoken back', async () => {
  const { v } = make({ translate: (m) => m.text });
  v._test.setSession(v._test.newSession());
  const r = await v._test.handleClip('in', clip(2), { seq: 1 });
  assert.equal(r.skipped, 'same-language');
});

test('a long clip is detected afresh; only a short one follows the recent language of the call', async () => {
  const seen = [];
  const { v } = make({ transcribe: async (buf, hint) => { seen.push(hint); return { text: 'hola', language: 'es' }; } });
  const sess = v._test.newSession();
  sess.recent.in = ['es', 'es', 'es'];
  v._test.setSession(sess);
  await v._test.handleClip('in', clip(1), { seq: 1 });      // short: follows the votes
  await v._test.handleClip('in', clip(5), { seq: 2 });      // long: auto
  assert.deepEqual(seen, ['es', 'auto']);
});

test('regression: the engine process ends with the app and is stopped at once on quit', () => {
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'src', 'voice-engine.js'), 'utf8'), /process\.on\('disconnect', \(\) => process\.exit\(0\)\)/);
  const killed = [];
  const procs = [];
  const { v } = make({ procs });
  v._test.setSession(v._test.newSession());
  return v._test.handleClip('in', clip(2), { seq: 1 }).then(() => {
    procs[0].kill = () => killed.push(1);
    v.shutdown();
    assert.equal(killed.length, 1, 'the engine is killed straight away, not after a delay');
  });
});

test('regression: starting a call forgets an old crash, so its first sentence is not thrown away', async () => {
  const procs = [];
  const { v, handlers } = make({ procs });
  v._test.setSession(v._test.newSession());
  await v._test.handleClip('in', clip(2), { seq: 1 });
  procs[0].emit('exit', 1);                                 // crashed while nobody was talking
  v._test.setSession(null);
  assert.equal((await handlers['relay:voice-start']()).ok, true);
  const r = await v._test.handleClip('in', clip(2), { seq: 2 });
  assert.equal(r.skipped, undefined, 'translated, not "restarting"');
});

test('their language has no voice here: nothing is spoken, nothing counts as a failure, and the reason is given', async () => {
  const { v } = make({ transcribe: async () => ({ text: 'good morning', language: 'en' }) });
  const s = v._test.newSession();
  s.theirLang = 'fr';
  v._test.setSession(s);
  const r = await v._test.handleClip('out', clip(2), { seq: 1 });
  assert.equal(r.skipped, 'cannot-speak');
  assert.equal(s.failures, 0);
});

test('a translation that comes back empty is never spoken', async () => {
  const { v } = make({ translate: () => '   ' });
  v._test.setSession(v._test.newSession());
  assert.equal((await v._test.handleClip('in', clip(2), { seq: 1 })).skipped, 'empty');
});

test('a voice that comes back as no sound at all is not played either', async () => {
  const { v } = make({ synth: () => ({ pcm: new ArrayBuffer(0) }) });
  v._test.setSession(v._test.newSession());
  assert.equal((await v._test.handleClip('in', clip(2), { seq: 1 })).skipped, 'empty');
});

test('if the spoken notice cannot be made, your translation is not sent; the next sentence tries the notice again', async () => {
  let fail = true;
  const { v } = make({
    transcribe: async () => ({ text: 'good morning', language: 'en' }), store: { voiceThey: 'hi' },
    synth: (m) => (fail && /translated automatically/.test(m.text) ? { __error: 'synth broke' } : null)
  });
  v._test.setSession(v._test.newSession());
  const a = await v._test.handleClip('out', clip(2), { seq: 1 });
  assert.equal(a.skipped, 'no-notice');
  assert.equal(a.pcm, undefined);
  fail = false;
  const b = await v._test.handleClip('out', clip(2), { seq: 2 });
  assert.ok(b.notice && b.pcm, 'the notice and the translation go out together once it works');
});

test('a language the speech model names but the translator has no code for (Cantonese) is translated with automatic detection', async () => {
  const sources = [];
  const { v } = make({
    transcribe: async () => ({ text: 'nei hou', language: 'yue' }),
    translate: (m) => { sources.push(m.from); return m.from === 'yue' ? { __error: 'Unsupported language: yue' } : 'hello'; }
  });
  v._test.setSession(v._test.newSession());
  const r = await v._test.handleClip('in', clip(2), { seq: 1 });
  assert.equal(r.text, 'hello');
  assert.deepEqual(sources, ['yue', 'auto']);
});

test('"Download now" in the Add-ons fetches the translator and the voices without a call, and reports progress', async () => {
  const events = [];
  const { v, handlers, log } = make({ event: (ch, d) => events.push([ch, d]) });
  const r = await handlers['relay:voice-prepare']();
  assert.equal(r.ok, true);
  assert.deepEqual(log.filter((m) => m.type === 'ensure').map((m) => m.what), ['mt', 'voice']);
  const status = events.filter(([ch]) => ch === 'addon-status').map(([, d]) => d);
  assert.equal(status[0].id, 'voice');
  assert.ok(status.some((d) => d.done && d.pct === 1), 'finishes with done');
  assert.equal(v.state().active, false, 'no call is started by it');
  assert.equal((await handlers['relay:voice-prepare']()).ok, true, 'can be run again');
  v.shutdown();                                                // the engine is released after a while: stop that timer so the test can end
});

test('"Download now" asks first, and a refusal downloads nothing', async () => {
  const { handlers, log } = make({ decline: true, store: { voiceConsent: undefined } });
  const r = await handlers['relay:voice-prepare']();
  assert.deepEqual(r, { ok: false, reason: 'declined' });
  assert.equal(log.length, 0, 'the engine was not even started');
});

test('voice translation uses the more accurate speech model unless the user chose one', async () => {
  const a = make();
  assert.equal((await a.handlers['relay:voice-start']()).ok, true);
  assert.equal(a.data.captionModel, 'accurate');
  a.v.shutdown();
  const b = make({ store: { captionModel: 'fast' } });
  assert.equal((await b.handlers['relay:voice-start']()).ok, true);
  assert.equal(b.data.captionModel, 'fast', 'an explicit choice is respected');
  b.v.shutdown();
});

test('an engine that dies during a call is started again by the next clip, which is skipped meanwhile', async () => {
  const procs = [];
  const { v, log } = make({ procs });
  v._test.setSession(v._test.newSession());
  await v._test.handleClip('in', clip(2), { seq: 1 });     // starts the first engine
  procs[0].emit('exit', 1);                                // it crashes
  const r = await v._test.handleClip('in', clip(2), { seq: 2 });
  assert.equal(r.skipped, 'restarting');
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(procs.length, 2, 'a second engine process was started');
  assert.ok(log.some((m) => m.op === 'warm'), 'and warmed up');
});
