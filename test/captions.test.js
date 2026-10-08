'use strict';
// Live call captions: the pieces that can be checked without a GPU, a call or the network.
// (The engine and the on-screen result are exercised end to end by hand against synthetic speech.)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
const {
  setupCaptions, MODELS, TARGETS, MODEL_BASE, DEFAULTS, toPcmBuffer, cleanTranscript, pickLanguage, cleanPrefs, chooseGpu, baseLang,
  MAX_PCM_BYTES, MIN_PCM_BYTES
} = require('../src/captions');
const { translateCaption, gtxCode } = require('../src/translate');
const { parseDeviceLine } = require('../src/captions-engine');

// --- the page's segmenter, taken out of the page module and run on its own ------------
const pageSrc = fs.readFileSync(path.join(SRC, 'page', 'captions.js'), 'utf8');
const block = /\/\* segmenter:start \*\/([\s\S]*?)\/\* segmenter:end \*\//.exec(pageSrc);
assert.ok(block, 'segmenter block not found in src/page/captions.js');
const makeSegmenter = new Function(block[1] + '\nreturn makeSegmenter;')();

const FRAME = 1600;                                    // 100 ms at 16 kHz
/** n frames of a 200 Hz tone at `amp` (voice stand-in), over optional steady noise. */
function tone(n, amp, noise = 0, startFrame = 0) {
  const out = [];
  for (let f = 0; f < n; f++) {
    const a = new Float32Array(FRAME);
    for (let i = 0; i < FRAME; i++) {
      const t = (startFrame + f) * FRAME + i;
      a[i] = amp * Math.sin(2 * Math.PI * 200 * t / 16000) + noise * (Math.sin(t * 12.9898) * 43758.5453 % 1);
    }
    out.push(a);
  }
  return out;
}
function run(frames, cfg) {
  const clips = [];
  const speech = [];
  const seg = makeSegmenter((pcm, ms) => clips.push({ pcm, ms }), (v) => speech.push(v), cfg);
  frames.forEach((f) => seg.push(f));
  seg.flush();
  return { clips, speech, seg };
}
const peakOf = (buf) => { let p = 0; for (const v of new Int16Array(buf)) p = Math.max(p, Math.abs(v)); return p / 32768; };

test('segmenter: silence and steady line noise produce nothing', () => {
  assert.equal(run(tone(80, 0)).clips.length, 0);
  assert.equal(run(tone(80, 0, 0.004)).clips.length, 0);          // about -48 dBFS hiss
});

test('segmenter: one phrase becomes one clip, with a little lead-in and tail', () => {
  const frames = [...tone(5, 0), ...tone(20, 0.2), ...tone(12, 0)];
  const { clips, speech } = run(frames);
  assert.equal(clips.length, 1);
  assert.ok(clips[0].ms >= 2000 && clips[0].ms <= 2800, 'clip is ' + clips[0].ms + ' ms');
  assert.equal(clips[0].pcm.byteLength, clips[0].ms / 100 * FRAME * 2);        // 16-bit samples
  assert.deepEqual(speech, [true, false]);                                      // the "speaking" light turned on, then off
});

test('segmenter: a pause longer than ~0.6 s starts a new clip', () => {
  const frames = [...tone(15, 0.2), ...tone(9, 0), ...tone(15, 0.2, 0, 24), ...tone(10, 0)];
  assert.equal(run(frames).clips.length, 2);
});

test('segmenter: a short breath between words does not split a phrase', () => {
  const frames = [...tone(10, 0.2), ...tone(2, 0), ...tone(10, 0.2, 0, 12), ...tone(10, 0)];
  assert.equal(run(frames).clips.length, 1);
});

test('segmenter: a click or cough (under 0.3 s) is ignored', () => {
  assert.equal(run([...tone(8, 0), ...tone(2, 0.3), ...tone(12, 0)]).clips.length, 0);
});

test('segmenter: non-stop speech is cut at a short pause once it is long, and never runs past the cap', () => {
  // 6 s of speech with a 0.3 s dip in the middle: cut there (soft cut after 2.5 s)
  const dip = run([...tone(30, 0.2), ...tone(3, 0), ...tone(30, 0.2, 0, 33), ...tone(10, 0)]);
  assert.equal(dip.clips.length, 2);
  // 15 s with no pause at all: forced cuts, each at most 9 s
  const nonstop = run([...tone(150, 0.2), ...tone(10, 0)]);
  assert.ok(nonstop.clips.length >= 2);
  for (const c of nonstop.clips) assert.ok(c.ms <= 9000, 'clip of ' + c.ms + ' ms');
});

test('segmenter: a quiet caller is lifted to a usable level, a loud one is left alone', () => {
  const quiet = run([...tone(8, 0), ...tone(15, 0.04), ...tone(10, 0)]).clips[0];
  const loud = run([...tone(15, 0.6), ...tone(10, 0)]).clips[0];
  assert.ok(quiet, 'quiet speech should still be heard');
  assert.ok(peakOf(quiet.pcm) > 0.04 * 6 && peakOf(quiet.pcm) < 0.7, 'quiet clip peak ' + peakOf(quiet.pcm));     // lifted, by at most 8x
  assert.ok(Math.abs(peakOf(loud.pcm) - 0.6) < 0.02, 'loud clip peak ' + peakOf(loud.pcm));
});

test('segmenter: speech over a noisy line (-43 dBFS) is found, and the noise alone never makes a clip', () => {
  assert.equal(run(tone(60, 0, 0.012)).clips.length, 0);                          // hiss from the very first frame, for 6 s
  assert.equal(run(tone(300, 0, 0.012)).clips.length, 0);                         // ...and for 30 s: no endless 9 s clips of noise
  assert.equal(run([...tone(30, 0, 0.012), ...tone(20, 0.25, 0.012, 30), ...tone(10, 0, 0.012, 50)]).clips.length, 1);
});

test('segmenter: a quiet line that turns noisy mid-call is learned, not mistaken for speech for ever', () => {
  const clips = run([...tone(30, 0), ...tone(200, 0, 0.012, 30)]).clips;          // 20 s of new hiss
  assert.ok(clips.length <= 1, 'got ' + clips.length + ' clips from hiss');        // at most the first moments before it is learned
});

test('segmenter: the other person already talking when captions are switched on is not lost', () => {
  const { clips } = run([...tone(30, 0.2), ...tone(10, 0)]);
  assert.equal(clips.length, 1);
  assert.ok(clips[0].ms >= 2000, 'clip is ' + clips[0].ms + ' ms');
});

// --- transcript clean-up ------------------------------------------------------------------
test('cleanTranscript drops sound tags, music notes and the stock phrases Whisper invents on silence', () => {
  assert.equal(cleanTranscript('  Hello   there  '), 'Hello there');
  assert.equal(cleanTranscript('[BLANK_AUDIO]'), '');
  assert.equal(cleanTranscript('(upbeat music)'), '');
  assert.equal(cleanTranscript('♪ ♪'), '');
  assert.equal(cleanTranscript('Thanks for watching!'), '');
  assert.equal(cleanTranscript('Subtitles by the Amara.org community'), '');
  assert.equal(cleanTranscript('...'), '');
  assert.equal(cleanTranscript(null), '');
  assert.equal(cleanTranscript('Okay [laughs] fine'), 'Okay fine');
});

test('cleanTranscript keeps real short answers and other languages, and tames a stuck loop', () => {
  assert.equal(cleanTranscript('Thank you.'), 'Thank you.');
  assert.equal(cleanTranscript('Yes.'), 'Yes.');
  assert.equal(cleanTranscript('हाँ, ठीक है'), 'हाँ, ठीक है');
  assert.equal(cleanTranscript('你好吗'), '你好吗');
  const loop = cleanTranscript('the the the the the the the the');
  assert.ok(loop.split(/[\s,]+/).length <= 3, loop);
});

// --- clips from the page ------------------------------------------------------------------------
test('toPcmBuffer accepts sensible audio and refuses everything else', () => {
  assert.ok(toPcmBuffer(new ArrayBuffer(32000)));
  assert.ok(toPcmBuffer(new Uint8Array(32000)));
  assert.ok(toPcmBuffer(Buffer.alloc(MIN_PCM_BYTES)));
  assert.equal(toPcmBuffer(new ArrayBuffer(MIN_PCM_BYTES - 2)), null);              // under 0.1 s
  assert.equal(toPcmBuffer(new ArrayBuffer(MAX_PCM_BYTES + 2)), null);              // over 15 s
  assert.equal(toPcmBuffer(new ArrayBuffer(32001)), null);                           // odd length is not 16-bit audio
  assert.equal(toPcmBuffer('hello'), null);
  assert.equal(toPcmBuffer(null), null);
  assert.equal(toPcmBuffer({ length: 32000 }), null);
});

test('pickLanguage: short clips follow the language that dominates the call, long ones are detected afresh', () => {
  assert.equal(pickLanguage([], 1), 'auto');
  assert.equal(pickLanguage(['hi', 'hi', 'hi', 'en'], 1.0), 'hi');
  assert.equal(pickLanguage(['hi', 'hi', 'hi', 'en'], 4.0), 'auto');                 // a switch of language is still noticed
  assert.equal(pickLanguage(['hi', 'en'], 1.0), 'auto');                             // no clear winner
  assert.equal(pickLanguage(['en'], 1.0), 'auto');                                    // one vote is not enough
});

test('preferences are always valid, whatever is stored', () => {
  assert.deepEqual(cleanPrefs(undefined), DEFAULTS);
  assert.deepEqual(cleanPrefs({ lang: 'xx', size: 'huge', original: 'yes', model: 'turbo' }), DEFAULTS);
  assert.deepEqual(cleanPrefs({ lang: 'hi', size: 'l', original: true, model: 'accurate', from: 'ru' }), { lang: 'hi', size: 'l', original: true, model: 'accurate', from: 'ru' });
  assert.equal(cleanPrefs({ from: 'klingon' }).from, 'auto');                         // a spoken language must be one Relay knows
  assert.equal(cleanPrefs({ from: 'auto' }).from, 'auto');
  assert.equal(DEFAULTS.lang, 'en');                                                  // English unless the user picks another
});

test('the target languages are unique, lower-case codes, English first', () => {
  assert.equal(TARGETS[0], 'en');
  assert.equal(new Set(TARGETS).size, TARGETS.length);
  for (const c of TARGETS) assert.match(c, /^[a-z]{2}$/);
  for (const c of ['hi', 'es', 'ar', 'zh', 'ja']) assert.ok(TARGETS.includes(c), c);
});

test('GPU choice: the discrete card, unless it is already the default', () => {
  const intel = { index: 0, name: 'Intel UHD', discrete: false };
  const nv = { index: 1, name: 'NVIDIA RTX', discrete: true };
  assert.equal(chooseGpu([intel, nv]), 1);
  assert.equal(chooseGpu([{ ...nv, index: 0 }, intel]), null);
  assert.equal(chooseGpu([intel]), null);
  assert.equal(chooseGpu([]), null);
  assert.equal(chooseGpu(undefined), null);
});

test('the engine reads GPU lines from whisper.cpp\'s log', () => {
  const nv = parseDeviceLine('ggml_vulkan: 1 = NVIDIA GeForce RTX 3050 6GB Laptop GPU (NVIDIA) | uma: 0 | fp16: 1 | bf16: 1');
  assert.deepEqual([nv.index, nv.name, nv.discrete], [1, 'NVIDIA GeForce RTX 3050 6GB Laptop GPU', true]);
  const igpu = parseDeviceLine('ggml_vulkan: 0 = Intel(R) RaptorLake-S Mobile Graphics Controller (Intel Corporation) | uma: 1 | fp16: 1');
  assert.deepEqual([igpu.index, igpu.discrete], [0, false]);
  assert.equal(parseDeviceLine('whisper_init_state: kv self size = 6.29 MB'), null);
});

test('the speech models are pinned: official host, exact size and SHA-256', () => {
  assert.match(MODEL_BASE, /^https:\/\/huggingface\.co\/ggerganov\/whisper\.cpp\/resolve\/main\/$/);
  for (const [id, m] of Object.entries(MODELS)) {
    assert.match(m.sha256, /^[0-9a-f]{64}$/, id);
    assert.ok(m.bytes > 10e6, id);
    assert.match(m.file, /^ggml-[a-z0-9_.-]+\.bin$/, id);
    assert.ok(Math.abs(m.mb - m.bytes / 1e6) < 12, id + ' size label');
  }
  assert.equal(DEFAULTS.model, 'fast');
});

// --- translation of a caption ----------------------------------------------------------------------
const reply = (src, text) => ({ ok: true, status: 200, json: async () => ({ src, sentences: [{ trans: text }] }) });

test('translateCaption: asks Google for the target and the language heard, and returns the translation', async () => {
  let sent;
  const r = await translateCaption('हाँ', 'en', { from: 'hi', fetch: async (url, init) => { sent = new URLSearchParams(init.body); return reply('hi', 'Yes'); } });
  assert.equal(sent.get('sl'), 'hi');
  assert.equal(sent.get('tl'), 'en');
  assert.deepEqual([r.translated, r.text, r.lang], [true, 'Yes', 'hi']);
});

test('translateCaption: English output gets the casual touch, other languages do not', async () => {
  const en = await translateCaption('x', 'en', { fetch: async () => reply('es', 'I do not know.') });
  assert.equal(en.text, "I don't know");
  const de = await translateCaption('x', 'de', { fetch: async () => reply('en', 'Ich weiss es nicht.') });
  assert.equal(de.text, 'Ich weiss es nicht.');
});

test('translateCaption: the same words back are not a translation', async () => {
  const r = await translateCaption('Okay', 'en', { fetch: async () => reply('en', 'okay') });
  assert.equal(r.translated, false);
});

test('translateCaption: Whisper and Google code differences, and a fallback when Google does not know the code', async () => {
  assert.equal(gtxCode('zh'), 'zh-CN');
  assert.equal(gtxCode('he'), 'iw');
  assert.equal(gtxCode('HI'), 'hi');
  const sl = [];
  const r = await translateCaption('abc', 'en', {
    from: 'yue',
    fetch: async (u, init) => { const p = new URLSearchParams(init.body); sl.push(p.get('sl')); return p.get('sl') === 'auto' ? reply('zh-CN', 'Hello') : { ok: false, status: 400 }; }
  });
  assert.deepEqual(sl, ['zh-TW', 'auto']);
  assert.equal(r.text, 'Hello');
});

test('translateCaption: failures are reported in plain words, never with the caption text', async () => {
  await assert.rejects(translateCaption('secret words', 'en', { fetch: async () => { throw new Error('net::ERR_INTERNET_DISCONNECTED'); } }), (e) => e.message === 'No internet connection');
  await assert.rejects(translateCaption('secret words', 'en', { fetch: async () => ({ ok: false, status: 429 }) }), (e) => /429/.test(e.message) && !/secret/.test(e.message));
});

test('baseLang trims region and case', () => {
  assert.equal(baseLang('pt-BR'), 'pt');
  assert.equal(baseLang('EN'), 'en');
  assert.equal(baseLang(undefined), '');
});

// ---- model download: mirrors ---------------------------------------------------------------------
function downloaderWith(locale, fetchImpl) {
  const os = require('node:os');
  const dir = require('node:fs').mkdtempSync(require('node:path').join(os.tmpdir(), 'relay-models-'));
  process.env.RELAY_TEST = '1';
  process.env.RELAY_CAPTION_MODELS = dir;
  const store = { get: () => undefined, set() {}, delete() {}, has: () => false };
  const noop = () => {};
  const h = setupCaptions({
    app: { getPath: () => dir, getLocale: () => locale }, store, net: { fetch: fetchImpl },
    handle: noop, utilityProcess: {}, showBox: noop, event: noop, pushState: noop, isOnBattery: () => false
  });
  return h._test.downloadModel;
}

test('model download: a blocked huggingface.co falls back to hf-mirror.com, and a damaged file is still refused', async () => {
  const asked = [];
  const dl = downloaderWith('en-US', async (url) => {
    asked.push(new URL(url).host);
    if (url.includes('huggingface.co')) throw new Error('net::ERR_CONNECTION_TIMED_OUT');
    return new Response(new Uint8Array(1000));
  });
  await assert.rejects(dl('fast', () => {}), /damaged/);
  assert.deepEqual(asked, ['huggingface.co', 'hf-mirror.com']);
});

test('model download: on a Chinese Windows the mirror is tried first', async () => {
  const asked = [];
  const dl = downloaderWith('zh-CN', async (url) => { asked.push(new URL(url).host); return new Response(new Uint8Array(10)); });
  await assert.rejects(dl('fast', () => {}), /damaged/);
  assert.equal(asked[0], 'hf-mirror.com');
});

test('model download: every server unreachable reports a network problem in plain words', async () => {
  const dl = downloaderWith('ru-RU', async () => { throw new Error('net::ERR_CONNECTION_RESET'); });
  await assert.rejects(dl('accurate', () => {}), /No internet connection/);
});
