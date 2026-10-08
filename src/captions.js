'use strict';
/*
 * Live captions for calls - main-process half (page side: src/page/captions.js).
 *
 * The page listens to the other person's side of the call, cuts it into short
 * clips at natural pauses, and sends each clip here. Each clip is
 *
 *   1. turned into text ON THIS PC by whisper.cpp (src/captions-engine.js, a
 *      separate process on the GPU) - the audio never leaves the computer and is
 *      never written to disk; Whisper also reports which language was spoken,
 *   2. cleaned of its usual silence-hallucinations ("Thanks for watching"),
 *   3. translated into the viewer's language (default English). Only that TEXT
 *      goes to Google Translate, and only if the user ticked that box in the
 *      one-time notice. Without it, captions are shown in the spoken language.
 *
 * The speech model (Whisper, MIT) is downloaded once, from Hugging Face, checked
 * against a pinned size and SHA-256, and kept in Relay's own data folder.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { translateCaption } = require('./translate');

const MODEL_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/';
// Same files, same SHA-256 check. hf-mirror.com is reachable from mainland China when huggingface.co is not.
const MODEL_MIRRORS = [MODEL_BASE, 'https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/'];
const CONNECT_MS = 15000;                // a server that has not answered by then is skipped for the next one
const MODELS = {
  fast: {
    file: 'ggml-base-q5_1.bin', bytes: 59707625, mb: 60, label: 'Fast',
    sha256: '422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898'
  },
  accurate: {
    file: 'ggml-small-q5_1.bin', bytes: 190085487, mb: 190, label: 'Accurate',
    sha256: 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb'
  }
};

// What a caption can be translated into (names are shown by the page from these codes).
const TARGETS = [
  'en', 'hi', 'bn', 'ta', 'te', 'mr', 'gu', 'kn', 'ml', 'pa', 'ur', 'ne',
  'es', 'fr', 'de', 'it', 'pt', 'ru', 'uk', 'pl', 'nl', 'tr', 'el', 'sv', 'ro', 'cs', 'hu',
  'ar', 'fa', 'he', 'id', 'ms', 'vi', 'th', 'ja', 'ko', 'zh', 'sw'
];
const SIZES = ['s', 'm', 'l'];
const DEFAULTS = { lang: 'en', size: 'm', original: false, model: 'fast', from: 'auto' };   // from: the language the other person speaks ('auto' = detect)

const SAMPLE_RATE = 16000;
const MIN_PCM_BYTES = 3200;                          // 100 ms
const MAX_PCM_BYTES = SAMPLE_RATE * 2 * 15;          // 15 s - the page cuts at 8-12 s
const MAX_IN_FLIGHT = 4;                             // beyond this the engine is not keeping up: clips are dropped, not queued forever
const JOB_TIMEOUT = 45000;
const IDLE_MS = 2 * 60 * 1000;                       // the engine (and its memory) is released this long after captions stop

// --- pure helpers (unit tested) ---------------------------------------------------

/** What the page sent -> a Buffer of 16-bit mono PCM, or null if it is not a sensible clip. */
function toPcmBuffer(data) {
  let b = null;
  if (data instanceof ArrayBuffer) b = Buffer.from(data);
  else if (ArrayBuffer.isView(data)) b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (!b || b.length < MIN_PCM_BYTES || b.length > MAX_PCM_BYTES || b.length % 2) return null;
  return b;
}

/**
 * Whisper's text -> something worth showing, or ''. Drops sound tags and music
 * notes, the stock phrases it invents on silence and noise, and runaway loops.
 */
function cleanTranscript(raw) {
  let t = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
  t = t.replace(/\[[^\]]{0,40}\]|\([^)]{0,40}\)|\*[^*]{0,40}\*|[♪♫♬]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t || !/\p{L}/u.test(t)) return '';
  if (/^(thanks? for watching|thank you for watching|please subscribe|subtitles? by|subtitles? made|amara\.org|transcribed by|www\.)/i.test(t)) return '';
  // "the the the the the" / "Yeah. Yeah. Yeah. Yeah." -> kept twice, not five times
  t = t.replace(/(\b.{1,40}?)(?:[\s,.!?-]+\1\b){3,}/gi, '$1, $1');
  return t.trim();
}

/**
 * Short clips are easily mistaken for another language ("Yes." / "Okay"), so while
 * one language clearly dominates the last few clips, short clips are told what it is.
 * Longer clips are always detected afresh, so a switch of language is still noticed.
 */
function pickLanguage(recent, seconds) {
  if (seconds >= 2.2 || !recent.length) return 'auto';
  const last = recent.slice(-6);
  const votes = new Map();
  for (const l of last) votes.set(l, (votes.get(l) || 0) + 1);
  const [lang, n] = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
  return n >= 2 && n / last.length >= 0.5 ? lang : 'auto';
}

const baseLang = (c) => String(c || '').toLowerCase().split(/[-_]/)[0];

/** Whatever is stored (or sent by the page) -> valid caption preferences. */
function cleanPrefs(p) {
  const o = { ...DEFAULTS };
  if (p && typeof p === 'object') {
    if (TARGETS.includes(p.lang)) o.lang = p.lang;
    if (SIZES.includes(p.size)) o.size = p.size;
    if (typeof p.original === 'boolean') o.original = p.original;
    if (MODELS[p.model]) o.model = p.model;
    if (p.from === 'auto' || TARGETS.includes(p.from)) o.from = p.from;
  }
  return o;
}

/** Which GPU to ask for: the first discrete one, unless the default (device 0) already is. */
function chooseGpu(devices) {
  const list = Array.isArray(devices) ? devices : [];
  const discrete = list.find((d) => d && d.discrete);
  if (!discrete || discrete.index === 0) return null;
  return discrete.index;
}

// --- main-process wiring ----------------------------------------------------------

function setupCaptions(ctx) {
  const { app, store, net, handle, showBox, utilityProcess, event, pushState, isOnBattery } = ctx;

  const modelsDir = () => (process.env.RELAY_TEST && process.env.RELAY_CAPTION_MODELS) || path.join(app.getPath('userData'), 'models');
  const modelPath = (id) => path.join(modelsDir(), MODELS[id].file);
  const modelReady = (id) => {
    try { return fs.statSync(modelPath(id)).size === MODELS[id].bytes; } catch (e) { return false; }
  };

  // Chinese, Russian, Hindi ... are recognised far better by the larger model (the quick one mixes up close languages),
  // so a PC that is not set to English starts with it; the choice stays the user's (Relay panel / caption settings).
  const defaultModel = () => {
    try { return String(app.getPreferredSystemLanguages()[0] || app.getLocale() || 'en').slice(0, 2).toLowerCase() === 'en' ? undefined : 'accurate'; } catch (e) { return undefined; }
  };
  const prefs = () => cleanPrefs({
    lang: store.get('captionLang'), size: store.get('captionSize'),
    original: store.get('captionOriginal'), model: store.get('captionModel') || defaultModel(), from: store.get('captionFrom')
  });
  const consent = () => {
    const c = store.get('captionConsent');
    return c && typeof c === 'object' && c.ok === true ? { ok: true, translate: c.translate === true } : null;
  };

  let engine = null;                 // { proc, ready, readyPromise, devices, model, gpu, jobs: Map, nextId }
  let idleTimer = null;
  let session = null;                // { recent: [], speed: 0, slow: 0 } while captions are on
  let starting = null;
  let inFlight = 0;

  function state() {
    const p = prefs();
    const c = consent();
    return {
      ...p,
      targets: TARGETS,
      models: Object.fromEntries(Object.keys(MODELS).map((id) => [id, { label: MODELS[id].label, mb: MODELS[id].mb, ready: modelReady(id) }])),
      consent: Boolean(c),
      translate: Boolean(c && c.translate),
      active: Boolean(session)
    };
  }

  // --- the engine process --------------------------------------------------------
  function killEngine() {
    clearTimeout(idleTimer);
    const e = engine;
    engine = null;
    if (!e) return;
    for (const j of e.jobs.values()) j.reject(new Error('The speech engine stopped'));
    e.jobs.clear();
    try { e.proc.postMessage({ type: 'quit' }); } catch (err) { /* already gone */ }
    setTimeout(() => { try { e.proc.kill(); } catch (err) { /* already gone */ } }, 1500);
  }

  function launchEngine(modelId, gpu) {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    if (gpu != null) env.GGML_VK_VISIBLE_DEVICES = String(gpu); else delete env.GGML_VK_VISIBLE_DEVICES;
    const proc = utilityProcess.fork(path.join(__dirname, 'captions-engine.js'), [], { env, serviceName: 'Relay captions', stdio: 'ignore' });
    const e = { proc, ready: false, devices: [], model: modelId, gpu, jobs: new Map(), nextId: 1, readyPromise: null };
    e.readyPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The speech engine took too long to start')), 120000);
      proc.on('message', (m) => {
        if (!m || typeof m !== 'object') return;
        if (m.type === 'ready') { clearTimeout(timer); e.ready = true; e.devices = m.devices || []; resolve(e); }
        else if (m.type === 'init-error') { clearTimeout(timer); reject(Object.assign(new Error(m.message || 'The speech engine could not start'), { noGpu: Boolean(m.noGpu) })); }
        else if (m.type === 'result' || m.type === 'error') {
          const j = e.jobs.get(m.id);
          if (!j) return;
          e.jobs.delete(m.id);
          if (m.type === 'result') j.resolve(m); else j.reject(new Error(m.message || 'The speech engine failed'));
        }
      });
      proc.on('exit', (code) => {
        clearTimeout(timer);
        for (const j of e.jobs.values()) j.reject(new Error('The speech engine stopped unexpectedly'));
        e.jobs.clear();
        if (engine === e) engine = null;
        reject(new Error('The speech engine stopped unexpectedly (' + code + ')'));
      });
    });
    e.readyPromise.catch(() => {});             // handled by whoever awaits it
    proc.postMessage({ type: 'init', model: modelPath(modelId), threads: 2 });
    return e;
  }

  /** Starts the engine (once), preferring the discrete GPU. Resolves to the engine record. */
  async function ensureEngine(modelId) {
    clearTimeout(idleTimer);
    if (engine && engine.model !== modelId) killEngine();
    if (engine) return engine.readyPromise;

    // The discrete GPU is ~10x faster but wakes up a hybrid-graphics laptop's second chip: only when plugged in.
    const onBattery = Boolean(isOnBattery && isOnBattery());
    let gpu = !onBattery && Number.isInteger(store.get('captionGpu')) ? store.get('captionGpu') : null;
    let e = engine = launchEngine(modelId, gpu);
    try {
      await e.readyPromise;
    } catch (err) {
      if (engine === e) killEngine();
      if (gpu == null) throw err;
      // the remembered GPU is gone (undocked, driver change): forget it and start over once
      store.delete('captionGpu');
      gpu = null;
      e = engine = launchEngine(modelId, null);
      await e.readyPromise;
    }
    if (gpu == null && !onBattery) {
      const better = chooseGpu(e.devices);
      if (better != null) {
        // Device 0 was the integrated GPU; the discrete one is ~10x faster. Restart pointed at it.
        killEngine();
        const e2 = engine = launchEngine(modelId, better);
        try {
          await e2.readyPromise;
          store.set('captionGpu', better);
          return e2;
        } catch (err) {
          if (engine === e2) killEngine();
          const e3 = engine = launchEngine(modelId, null);          // the better GPU would not start: the first choice still works
          await e3.readyPromise;
          return e3;
        }
      }
    }
    return e;
  }

  function run(pcm, language, translate) {
    const e = engine;
    if (!e || !e.ready) return Promise.reject(new Error('The speech engine is not ready'));
    return new Promise((resolve, reject) => {
      const id = e.nextId++;
      const timer = setTimeout(() => {
        e.jobs.delete(id);
        reject(new Error('The speech engine took too long'));
        if (engine === e) killEngine();                   // wedged driver: the next captions start a fresh one
      }, JOB_TIMEOUT);
      e.jobs.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (er) => { clearTimeout(timer); reject(er); } });
      const copy = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength);
      e.proc.postMessage({ type: 'run', id, pcm: copy, language, threads: 2, translate: translate === true });
    });
  }

  // --- the model ------------------------------------------------------------------
  const downloads = new Map();       // model id -> Promise (one download at a time per model)

  function downloadModel(id, onProgress) {
    if (downloads.has(id)) return downloads.get(id);
    const m = MODELS[id];
    const p = (async () => {
      await fs.promises.mkdir(modelsDir(), { recursive: true });
      const final = modelPath(id);
      const part = final + '.part';
      let out = null;
      try {
        // The first server that answers wins; in China hf-mirror.com goes first (huggingface.co is usually blocked there).
        const order = /^zh/i.test(app.getLocale()) ? MODEL_MIRRORS.slice().reverse() : MODEL_MIRRORS;
        let res = null, lastErr = null;
        for (const base of order) {
          const ctl = new AbortController();
          const t = setTimeout(() => ctl.abort(), CONNECT_MS);
          try {
            const r = await net.fetch(base + m.file, { signal: ctl.signal });
            if (r.ok && r.body) { res = r; break; }
            lastErr = new Error('The download server answered ' + r.status);
          } catch (err) { lastErr = err; } finally { clearTimeout(t); }
        }
        if (!res) throw lastErr || new Error('ERR_CONNECTION no download server could be reached');
        const total = Number(res.headers.get('content-length')) || m.bytes;
        out = fs.createWriteStream(part);
        const hash = crypto.createHash('sha256');
        let got = 0, lastReport = 0;
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          hash.update(value);
          got += value.length;
          if (!out.write(value)) await new Promise((r) => out.once('drain', r));
          const now = Date.now();
          if (now - lastReport > 250) { lastReport = now; onProgress(Math.min(1, got / total)); }
        }
        await new Promise((resolve, reject) => { out.once('error', reject); out.end(resolve); });
        out = null;
        if (got !== m.bytes || hash.digest('hex') !== m.sha256) throw new Error('The downloaded speech model was damaged - please try again');
        await fs.promises.rename(part, final);
        onProgress(1);
      } catch (err) {
        if (out) { try { out.destroy(); } catch (e) { /* ignore */ } }
        fs.promises.unlink(part).catch(() => {});
        const msg = String((err && err.message) || err);
        throw /ERR_INTERNET|ERR_NAME|ERR_CONNECTION|ERR_NETWORK|ENOTFOUND|fetch failed/i.test(msg) ? new Error('No internet connection') : err;
      }
    })().finally(() => downloads.delete(id));
    downloads.set(id, p);
    return p;
  }

  // --- the one-time notice ------------------------------------------------------------
  const TEXT = {
    en: {
      title: 'Live captions', message: 'Show captions for the other person on your calls?',
      need: (mb) => 'A one-time download of the speech model (about ' + mb + ' MB, from huggingface.co or its mirror hf-mirror.com) is needed first.\n\n',
      body: 'Relay listens to the other person’s voice during the call and turns it into text on this PC. ' +
        'The audio never leaves your computer and is not saved.\n\n' +
        'To translate the captions, only the text is sent to Google Translate (translate.googleapis.com). ' +
        'Nothing is stored by Relay. Untick the box below to show captions in the language that is spoken, with no translation. ' +
        'If Google Translate cannot be reached, English captions are made on this PC instead.\n\n' +
        'The other person is not told. In some places everyone on a call has to agree to it being transcribed - only use captions where that is fine.',
      buttons: ['Turn on captions', 'Cancel'], box: 'Translate captions with Google Translate (sends only the caption text)'
    },
    zh: {
      title: '实时字幕', message: '在通话中为对方显示字幕？',
      need: (mb) => '首次使用需要下载一次语音模型（约 ' + mb + ' MB，来自 huggingface.co 或镜像 hf-mirror.com）。\n\n',
      body: 'Relay 会在通话中聆听对方的声音，并在这台电脑上将其转换为文字。音频不会离开您的电脑，也不会被保存。\n\n' +
        '如需翻译字幕，只会把字幕文字发送给 Google 翻译（translate.googleapis.com），Relay 不保存任何内容。取消勾选下方选项，则按对方所说的语言显示字幕，不做翻译。' +
        '如果无法连接 Google 翻译，英文字幕会改为在本机生成。\n\n' +
        '对方不会收到通知。某些地区要求通话各方同意才能转写——请仅在合规的场合使用字幕。',
      buttons: ['开启字幕', '取消'], box: '使用 Google 翻译来翻译字幕（仅发送字幕文字）'
    },
    ru: {
      title: 'Живые субтитры', message: 'Показывать субтитры для собеседника во время звонков?',
      need: (mb) => 'Сначала нужно один раз скачать модель распознавания речи (около ' + mb + ' МБ, с huggingface.co или зеркала hf-mirror.com).\n\n',
      body: 'Relay слушает голос собеседника во время звонка и превращает его в текст на этом компьютере. ' +
        'Звук не покидает ваш компьютер и не сохраняется.\n\n' +
        'Для перевода субтитров в Google Переводчик (translate.googleapis.com) отправляется только текст. Relay ничего не хранит. ' +
        'Снимите флажок ниже, чтобы показывать субтитры на языке, на котором говорят, без перевода. ' +
        'Если Google Переводчик недоступен, английские субтитры создаются на этом компьютере.\n\n' +
        'Собеседника об этом не предупреждают. В некоторых местах для расшифровки разговора нужно согласие всех участников — используйте субтитры только там, где это допустимо.',
      buttons: ['Включить субтитры', 'Отмена'], box: 'Переводить субтитры через Google Переводчик (отправляется только текст субтитров)'
    }
  };
  const uiText = () => {
    let code = 'en';
    try { code = String(app.getPreferredSystemLanguages()[0] || app.getLocale() || 'en').slice(0, 2).toLowerCase(); } catch (e) { /* English */ }
    return TEXT[code] || TEXT.en;
  };

  async function askConsent(modelId) {
    const m = MODELS[modelId];
    const t = uiText();
    const need = modelReady(modelId) ? '' : t.need(m.mb);
    const { response, checkboxChecked } = await showBox({
      type: 'question',
      title: t.title,
      message: t.message,
      detail: need + t.body,
      buttons: t.buttons,
      defaultId: 0,
      cancelId: 1,
      checkboxLabel: t.box,
      checkboxChecked: true
    });
    if (response !== 0) return false;
    store.set('captionConsent', { ok: true, translate: Boolean(checkboxChecked) });
    pushState();
    return true;
  }

  // The engine died during a call: start it again (once at a time). If that fails, captions end with a message.
  let onlineFails = 0, onlineDownUntil = 0;     // Google Translate unreachable (blocked network)? see the caption handler
  let recovering = null;
  function recover() {
    if (recovering || !session) return;
    recovering = ensureEngine(prefs().model)
      .catch((err) => {
        console.warn('[captions] engine could not be restarted:', err.message);
        session = null;
        pushState();
        event('caption-status', { phase: 'error', message: 'Captions stopped: the speech engine could not be restarted.' });
      })
      .finally(() => { recovering = null; });
  }

  // --- channels ---------------------------------------------------------------------
  handle('relay:caption-set', (_e, name, value) => {
    const keys = { lang: 'captionLang', size: 'captionSize', original: 'captionOriginal', model: 'captionModel', from: 'captionFrom' };
    if (!keys[name]) throw new Error('Unknown setting');
    const next = cleanPrefs({ ...prefs(), [name]: value });
    if (next[name] !== value) throw new Error('That is not a valid choice');
    store.set(keys[name], value);
    pushState();
    return state();
  });

  handle('relay:caption-start', () => {
    if (starting) return starting;
    starting = (async () => {
      const id = prefs().model;
      if (!consent() && !(await askConsent(id))) return { ok: false, reason: 'declined' };
      try {
        if (!modelReady(id)) {
          event('caption-status', { phase: 'download', pct: 0, mb: MODELS[id].mb });
          await downloadModel(id, (pct) => event('caption-status', { phase: 'download', pct, mb: MODELS[id].mb }));
          pushState();
        }
        event('caption-status', { phase: 'loading' });
        const e = await ensureEngine(id);
        session = { recent: [], speed: 0, slow: 0 };
        pushState();
        const dev = e.devices.find((d) => d.index === (e.gpu == null ? 0 : e.gpu)) || e.devices[0];
        event('caption-status', { phase: 'ready', gpu: dev ? dev.name : '' });
        return { ok: true };
      } catch (err) {
        console.warn('[captions] could not start:', err.message);
        killEngine();
        const message = err.noGpu
          ? 'Live captions need a graphics card with Vulkan support, and none was found. Updating your graphics driver usually fixes this.'
          : /internet/i.test(err.message) ? 'No internet connection - the speech model could not be downloaded.'
            : 'Captions could not start: ' + String(err.message || err).slice(0, 140);
        event('caption-status', { phase: 'error', message });
        return { ok: false, reason: 'error', message };
      }
    })().finally(() => { starting = null; });
    return starting;
  });

  handle('relay:caption-stop', () => {
    session = null;
    pushState();
    clearTimeout(idleTimer);
    idleTimer = setTimeout(killEngine, IDLE_MS);
    return true;
  });

  handle('relay:caption-audio', async (_e, data, meta) => {
    const pcm = toPcmBuffer(data);
    if (!pcm) throw new Error('Bad audio');
    if (!session) return null;                                                  // a late clip after captions were turned off
    if (!engine || !engine.ready) { recover(); return { busy: true }; }          // the engine died (driver reset, killed): bring it back
    if (inFlight >= MAX_IN_FLIGHT) return { busy: true };
    const s = session;
    inFlight++;
    try {
      const secs = pcm.length / (SAMPLE_RATE * 2);
      const asked = prefs().from !== 'auto' ? prefs().from : pickLanguage(s.recent, secs);
      const r = await run(pcm, asked);
      const original = cleanTranscript(r.text);
      if (!original || session !== s) return { text: '' };
      const spoken = baseLang(r.language) || (asked !== 'auto' ? asked : '');
      if (spoken) { s.recent.push(spoken); if (s.recent.length > 8) s.recent.shift(); }

      // Falling behind the speaker? (the Accurate model on a weak GPU)
      s.speed = s.speed ? s.speed * 0.7 + (r.ms / 1000 / secs) * 0.3 : r.ms / 1000 / secs;
      if (s.speed > 1 && ++s.slow === 3) event('caption-status', { phase: 'slow', model: prefs().model });
      if (s.speed <= 1) s.slow = 0;

      const p = prefs();
      const out = { seq: meta && Number.isInteger(meta.seq) ? meta.seq : 0, original, text: original, lang: spoken, target: p.lang, translated: false, ms: r.ms };
      const c = consent();
      if (c && c.translate && spoken !== baseLang(p.lang)) {
        // English can also be produced by the speech model itself, with no internet: used when Google Translate cannot be reached
        // (blocked networks) and, after two failures in a row, instead of waiting on it for a minute.
        const offlineEnglish = async () => {
          if (baseLang(p.lang) !== 'en' || session !== s) return false;
          const r2 = await run(pcm, spoken || 'auto', true);
          const t2 = cleanTranscript(r2.text);
          if (!t2) return false;
          out.text = t2; out.translated = true; out.offline = true;
          return true;
        };
        try {
          if (Date.now() < onlineDownUntil && await offlineEnglish()) return out;
          if (Date.now() >= onlineDownUntil) {
            const t = await translateCaption(original, p.lang, { fetch: net.fetch.bind(net), from: spoken });
            onlineFails = 0;
            if (t.translated) { out.text = t.text; out.translated = true; }
            if (!out.lang && t.lang) out.lang = baseLang(t.lang);
          }
        } catch (err) {
          if (++onlineFails >= 2) onlineDownUntil = Date.now() + 60000;
          try { if (!(await offlineEnglish())) out.note = err.message; } catch (e2) { out.note = err.message; }   // shown once; the caption stays in the spoken language
        }
      }
      return out;
    } finally {
      inFlight--;
    }
  });

  /** Speech to text for other features (live voice translation): { text, language }; starts the speech engine on demand. */
  async function transcribe(pcm, language) {
    clearTimeout(idleTimer);
    const id = prefs().model;
    if (!modelReady(id)) throw new Error('The speech model is not downloaded yet');
    await ensureEngine(id);
    const r = await run(pcm, /^[a-z]{2,3}$/.test(language || '') ? language : 'auto');
    clearTimeout(idleTimer);
    if (!session) idleTimer = setTimeout(killEngine, IDLE_MS);
    return { text: cleanTranscript(r.text), language: baseLang(r.language), ms: r.ms };
  }

  return {
    state, transcribe, modelReady: () => modelReady(prefs().model), downloadSpeechModel: (onProgress) => downloadModel(prefs().model, onProgress),
    shutdown: () => { session = null; killEngine(); },
    _test: { downloadModel, modelPath, modelReady, ensureEngine, killEngine, getEngine: () => engine }
  };
}

module.exports = {
  setupCaptions, MODELS, TARGETS, SIZES, DEFAULTS, MODEL_BASE,
  toPcmBuffer, cleanTranscript, pickLanguage, cleanPrefs, chooseGpu, baseLang, MAX_PCM_BYTES, MIN_PCM_BYTES
};
