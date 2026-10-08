'use strict';
// node --test test/voiceclone.test.js
// The pure parts (model table, FFT/STFT, resampling, downloads against a local server) always run.
// The engine tests need the downloaded models (RELAY_VOICE_MODELS=<folder>) and the native packages
// (onnxruntime-node, sherpa-onnx-node); without them they are skipped.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const vc = require('../src/voice/voiceclone');

const { makeFft, hannWindow, spectrogram, transpose, resample, trimSilence, cosine, f32ToB64, b64ToF32, SR, N_FFT, HOP, N_BINS } = vc._dsp;

// --- the model table ------------------------------------------------------------------------------------------------

test('every model file has a pinned https source, size, SHA-256, licence and languages', () => {
  const names = Object.keys(vc.MODELS);
  assert.ok(names.length >= 10);
  for (const name of names) {
    const m = vc.MODELS[name];
    assert.ok(!path.isAbsolute(name) && !name.split('/').includes('..'), name);
    assert.match(m.url, /^https:\/\//, name);
    if (m.url.startsWith('https://huggingface.co/')) assert.match(m.url, /\/resolve\/[0-9a-f]{40}\//, name + ' must be pinned to a commit');
    assert.ok(Number.isInteger(m.bytes) && m.bytes > 0, name);
    assert.match(m.sha256, /^[0-9a-f]{64}$/, name);
    assert.ok(typeof m.licence === 'string' && m.licence.length > 3, name);
    assert.ok(Array.isArray(m.languages) && m.languages.length > 0, name);
  }
  // src/voice.js recognises the installed voice models by a file name starting with tone_color
  assert.ok(vc.MODELS['tone_color.onnx']);
  assert.ok(vc.MODELS['tone_extract.onnx']);
});

test('the five required languages are in the table, and each supported one has its files and base voices', () => {
  for (const l of ['en', 'hi', 'zh', 'ru', 'es']) assert.ok(vc.LANGS[l], l);
  for (const [l, L] of Object.entries(vc.LANGS)) {
    assert.strictEqual(typeof L.supported, 'boolean', l);
    if (!L.supported) continue;
    assert.ok(['kokoro', 'piper'].includes(L.engine), l);
    assert.ok(L.voices.length >= 1, l);
    for (const v of L.voices) {
      assert.ok(Number.isInteger(v.sid) && v.sid >= 0, v.name);
      const se = b64ToF32(v.se);
      assert.strictEqual(se.length, 256, v.name);
      assert.ok(se.every(Number.isFinite), v.name);
    }
    const files = Object.entries(vc.MODELS).filter(([, m]) => m.languages.includes(l)).map(([n]) => n);
    assert.ok(files.includes('tone_color.onnx') && files.includes('tone_extract.onnx'), l);
    assert.ok(files.some((n) => n.endsWith('.onnx') && !n.startsWith('tone_')), l + ' needs a base TTS model');
  }
});

test('download sources: pinned URL first, hf-mirror.com as fallback (or first when asked)', () => {
  const m = vc.MODELS['tone_extract.onnx'];
  const s = vc._test.sourcesFor(m, false);
  assert.strictEqual(s[0], m.url);
  assert.ok(s.includes(m.url.replace('https://huggingface.co/', 'https://hf-mirror.com/')));
  const c = vc._test.sourcesFor(m, true);
  assert.match(c[0], /^https:\/\/hf-mirror\.com\//);
  assert.strictEqual(vc._test.mirrorOf('https://example.com/x'), null);
});

// --- DSP ------------------------------------------------------------------------------------------------------------

function naiveDft(re) {
  const n = re.length, outRe = new Float64Array(n), outIm = new Float64Array(n);
  for (let k = 0; k < n; k++) for (let t = 0; t < n; t++) { const a = -2 * Math.PI * k * t / n; outRe[k] += re[t] * Math.cos(a); outIm[k] += re[t] * Math.sin(a); }
  return { outRe, outIm };
}

test('FFT matches a naive DFT', () => {
  for (const n of [8, 64, 1024]) {
    const fft = makeFft(n);
    const x = Float64Array.from({ length: n }, (_, i) => Math.sin(i * 0.3) + 0.5 * Math.cos(i * 1.7) + ((i * 7919) % 13) / 13);
    const re = Float64Array.from(x), im = new Float64Array(n);
    fft(re, im);
    const { outRe, outIm } = naiveDft(x);
    for (let k = 0; k < n; k++) {
      assert.ok(Math.abs(re[k] - outRe[k]) < 1e-6 * n, `n=${n} re[${k}]`);
      assert.ok(Math.abs(im[k] - outIm[k]) < 1e-6 * n, `n=${n} im[${k}]`);
    }
  }
  assert.throws(() => makeFft(100));
});

test('Hann window is torch.hann_window (periodic)', () => {
  const w = hannWindow(1024);
  assert.strictEqual(w[0], 0);
  assert.ok(Math.abs(w[512] - 1) < 1e-12);
  assert.ok(Math.abs(w[256] - 0.5) < 1e-12);
  assert.ok(Math.abs(w[1] - w[1023]) < 1e-12);       // periodic: w[i] == w[n-i]
});

test('spectrogram: frame count, layout and values match spectrogram_torch(center=False) with reflect padding', () => {
  const n = 22050;
  const f0 = 21 * SR / N_FFT;                          // exactly on bin 21
  const y = Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin(2 * Math.PI * f0 * i / SR));
  const { data, frames } = spectrogram(y);
  assert.strictEqual(frames, Math.floor((n + (N_FFT - HOP) - N_FFT) / HOP) + 1);
  assert.strictEqual(data.length, frames * N_BINS);
  // peak bin of a middle frame
  const mid = Math.floor(frames / 2) * N_BINS;
  let best = 0;
  for (let k = 1; k < N_BINS; k++) if (data[mid + k] > data[mid + best]) best = k;
  assert.strictEqual(best, 21);
  // magnitude of a windowed full-scale sine on its bin: A * N/4 for a Hann window
  assert.ok(Math.abs(data[mid + 21] - 0.5 * N_FFT / 4) < 1);
  // frame 0 recomputed by hand: reflect pad 384, Hann, naive DFT, sqrt(|X|^2 + 1e-6)
  const pad = (N_FFT - HOP) / 2;
  const frame = new Float64Array(N_FFT), w = hannWindow(N_FFT);
  for (let i = 0; i < N_FFT; i++) { const j = i - pad; frame[i] = (j < 0 ? y[-j] : y[j]) * w[i]; }
  const { outRe, outIm } = naiveDft(frame);
  for (const k of [0, 5, 21, 100, 512]) assert.ok(Math.abs(data[k] - Math.sqrt(outRe[k] ** 2 + outIm[k] ** 2 + 1e-6)) < 1e-3, 'bin ' + k);
  // silence gives the 1e-6 floor
  const z = spectrogram(new Float32Array(4096));
  assert.ok(Math.abs(z.data[10] - 0.001) < 1e-9);
});

test('transpose swaps [frames][bins] to [bins][frames]', () => {
  const d = Float32Array.from([1, 2, 3, 4, 5, 6]);            // 2 frames x 3 bins
  assert.deepStrictEqual(Array.from(transpose(d, 2, 3)), [1, 4, 2, 5, 3, 6]);
});

function toneFreq(x, sr) {
  // zero crossings per second / 2
  let z = 0;
  for (let i = 1; i < x.length; i++) if ((x[i - 1] < 0) !== (x[i] < 0)) z++;
  return z / 2 / (x.length / sr);
}

test('resample keeps length ratio, pitch and level; identity when the rates match', () => {
  const x = Float32Array.from({ length: 16000 }, (_, i) => 0.6 * Math.sin(2 * Math.PI * 440 * i / 16000));
  assert.deepStrictEqual(Array.from(resample(x, 16000, 16000)), Array.from(x));
  for (const [from, to] of [[16000, 22050], [24000, 22050], [22050, 16000], [48000, 22050]]) {
    const src = Float32Array.from({ length: from }, (_, i) => 0.6 * Math.sin(2 * Math.PI * 440 * i / from));
    const y = resample(src, from, to);
    assert.strictEqual(y.length, Math.round(from * to / from));
    assert.ok(Math.abs(toneFreq(y.subarray(500, y.length - 500), to) - 440) < 3, `${from}->${to}`);
    let rms = 0;
    for (let i = 500; i < y.length - 500; i++) rms += y[i] * y[i];
    rms = Math.sqrt(rms / (y.length - 1000));
    assert.ok(Math.abs(rms - 0.6 / Math.SQRT2) < 0.01, `${from}->${to} rms ${rms}`);
  }
  assert.throws(() => resample(x, 0, 16000));
});

test('resample removes what does not fit below the new Nyquist (no aliasing)', () => {
  const from = 24000, to = 16000;                       // 10 kHz tone cannot exist at 16 kHz
  const x = Float32Array.from({ length: from }, (_, i) => 0.5 * Math.sin(2 * Math.PI * 10000 * i / from));
  const y = resample(x, from, to);
  let rms = 0;
  for (let i = 200; i < y.length - 200; i++) rms += y[i] * y[i];
  assert.ok(Math.sqrt(rms / (y.length - 400)) < 0.01);
});

test('trimSilence drops the pauses and keeps the speech', () => {
  const sr = 16000;
  const x = new Float32Array(sr * 3);
  for (let i = sr; i < 2 * sr; i++) x[i] = 0.3 * Math.sin(i * 0.1);
  const y = trimSilence(x, sr);
  assert.ok(y.length >= sr && y.length < sr * 1.2, String(y.length));
  assert.strictEqual(trimSilence(new Float32Array(sr), sr).length, 0);
});

test('cosine and the base64 float packing', () => {
  assert.ok(Math.abs(cosine([1, 0], [1, 0]) - 1) < 1e-12);
  assert.ok(Math.abs(cosine([1, 0], [0, 1])) < 1e-12);
  assert.strictEqual(cosine([0, 0], [1, 1]), 0);
  const f = Float32Array.from({ length: 256 }, (_, i) => Math.sin(i));
  assert.deepStrictEqual(Array.from(b64ToF32(f32ToB64(f))), Array.from(f));
});

// --- downloads (against a local server; no internet) -------------------------------------------------------------

function serve(routes) {
  const srv = http.createServer((req, res) => {
    const body = routes[req.url];
    if (!body) { res.statusCode = 404; return res.end(); }
    res.setHeader('content-length', body.length);
    res.end(body);
  });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok({ srv, base: 'http://127.0.0.1:' + srv.address().port })));
}

test('ensureModels downloads, verifies, renames .part, falls back to the next source and skips good files', async () => {
  const good = crypto.randomBytes(300000), other = crypto.randomBytes(1000);
  const { srv, base } = await serve({ '/a.bin': good, '/sub/b.bin': other, '/bad.bin': crypto.randomBytes(1000) });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-vc-'));
  try {
    const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
    const table = {
      'a.onnx': { url: base + '/missing.bin', alt: [base + '/a.bin'], bytes: good.length, sha256: sha(good), licence: 'test', languages: ['en'] },
      'espeak-ng-data/b.bin': { url: base + '/sub/b.bin', bytes: other.length, sha256: sha(other), licence: 'test', languages: ['en'] }
    };
    const seen = [];
    await vc.ensureModels(dir, (p) => seen.push(p), { table });
    assert.deepStrictEqual(fs.readFileSync(path.join(dir, 'a.onnx')), good);
    assert.deepStrictEqual(fs.readFileSync(path.join(dir, 'espeak-ng-data', 'b.bin')), other);
    assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith('.part')));
    assert.strictEqual(seen[seen.length - 1], 1);
    // second run: nothing to fetch even with the server gone
    await new Promise((ok) => srv.close(ok));
    await vc.ensureModels(dir, null, { table });
    // a damaged file is replaced; when every source is gone the error says so in plain words
    fs.writeFileSync(path.join(dir, 'a.onnx'), Buffer.alloc(good.length));
    await assert.rejects(vc.ensureModels(dir, null, { table }), /could not be downloaded|no longer/);
  } finally {
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureModels rejects a corrupted download and leaves no .part behind', async () => {
  const body = crypto.randomBytes(5000);
  const { srv, base } = await serve({ '/x.bin': body });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-vc-'));
  try {
    const table = { 'x.onnx': { url: base + '/x.bin', bytes: body.length, sha256: '0'.repeat(64), licence: 't', languages: ['en'] } };
    await assert.rejects(vc.ensureModels(dir, null, { table }), /damaged/);
    assert.deepStrictEqual(fs.readdirSync(dir), []);
    await assert.rejects(vc.ensureModels(dir, null, { table: { '../evil': table['x.onnx'] } }), /Bad model file name/);
  } finally {
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- the real engine (only with the models downloaded) --------------------------------------------------------------

const MODELS_DIR = process.env.RELAY_VOICE_MODELS || '';
function engineSkipReason() {
  if (!MODELS_DIR) return 'set RELAY_VOICE_MODELS to the folder with the downloaded voice models';
  for (const n of Object.keys(vc.MODELS)) if (!fs.existsSync(path.join(MODELS_DIR, n))) return 'voice models not downloaded (' + n + ' missing)';
  for (const p of ['onnxruntime-node', 'sherpa-onnx-node']) { try { require.resolve(p); } catch (e) { return p + ' is not installed'; } }
  return false;
}
const skip = engineSkipReason();

test('engine: models verify, base voice, speaker embedding and converted speech', { skip, timeout: 300000 }, async () => {
  await vc.ensureModels(MODELS_DIR, null);                     // all present: verifies only
  const e = await vc.createEngine({ modelsDir: MODELS_DIR, provider: 'auto' });
  try {
    assert.deepStrictEqual(e.languages().sort(), Object.keys(vc.LANGS).filter((l) => vc.LANGS[l].supported).sort());
    const base = await e.synth('Hello, this is a short test.', 'en', null);
    assert.ok(base.pcm.length > base.sampleRate * 0.5 && base.sampleRate > 0);
    // a "speaker": the base voice itself, resampled to 16 kHz as the app sends it
    const ref = resample(base.pcm, base.sampleRate, 16000);
    const emb = await e.speakerFromPcm(ref, 16000);
    assert.strictEqual(emb.length, 256);
    assert.ok(emb.every(Number.isFinite));
    for (const l of e.languages()) {
      const text = { en: 'See you tomorrow at nine.', es: 'Nos vemos mañana a las nueve.', hi: 'कल नौ बजे मिलते हैं।', zh: '明天九点见。', ru: 'Увидимся завтра в девять.' }[l] || 'Hello.';
      const r = await e.synth(text, l, emb);
      assert.strictEqual(r.sampleRate, SR, l);
      assert.ok(r.pcm.length > SR * 0.4, l);
      let peak = 0;
      for (const v of r.pcm) peak = Math.max(peak, Math.abs(v));
      assert.ok(peak > 0.01 && peak <= 0.99, l + ' peak ' + peak);
    }
    await assert.rejects(e.synth('x', 'xx', null), /No voice/);
  } finally {
    await e.dispose();
  }
});
