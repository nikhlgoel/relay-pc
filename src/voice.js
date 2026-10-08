'use strict';
/*
 * Live voice translation, main-process half (page side: src/page/voice.js; engine process: src/voice-engine.js).
 *
 *   other person's voice -> speech to text (whisper, src/captions.js) -> translation -> speech in a copy of THEIR voice -> you
 *   your voice           -> speech to text -> translation -> speech in a copy of YOUR voice                          -> them
 *
 * The copy of a voice is made by two layers: a plain voice in the target language, then the speaker's own timbre on top.
 * What is kept: your own voice profile (a small file on this PC; "Forget my voice" deletes it). The other person's voice is
 * only ever held in memory, for the length of the call. Nothing is recorded and no audio leaves the PC. Text leaves it only
 * if the local translator is not installed and the user ticked "use Google Translate" in the notice.
 * The other person hears a spoken notice, in their language, before the first translated sentence.
 *
 * Every page request is a `relay:voice-*` channel; the page never sees file paths or keys.
 */

const fs = require('fs');
const path = require('path');
const { translateCaption } = require('./translate');

const DEFAULTS = { in: true, out: true, hear: '', they: 'auto', duck: 0.15 };
// The languages the voice engine can SPEAK (src/voice/voiceclone.js); any language can be listened to and translated from.
const LANGS = ['en', 'hi', 'zh', 'ru', 'es'];
const REF_SECONDS = 10;                  // how much of a voice is needed to copy it
const REF_MAX_BYTES = 16000 * 2 * 20;    // never keep more than 20 s (16 kHz, 16-bit)
const MAX_CLIP_BYTES = 16000 * 2 * 12;
const JOB_TIMEOUT = 30000;
const DISCLOSURE = 'This call is being translated automatically.';

const baseLang = (c) => String(c || '').toLowerCase().split(/[-_]/)[0];

/** Whatever is stored (or sent by the page) -> valid voice preferences. */
function cleanPrefs(p, osLang) {
  const o = { ...DEFAULTS, hear: LANGS.includes(osLang) ? osLang : 'en' };
  if (p && typeof p === 'object') {
    if (typeof p.in === 'boolean') o.in = p.in;
    if (typeof p.out === 'boolean') o.out = p.out;
    if (LANGS.includes(p.hear)) o.hear = p.hear;
    if (p.they === 'auto' || LANGS.includes(p.they)) o.they = p.they;
    if (typeof p.duck === 'number' && p.duck >= 0 && p.duck <= 1) o.duck = p.duck;
  }
  return o;
}

/** A clip from the page: 16-bit mono 16 kHz PCM as an Int16Array/ArrayBuffer/Buffer -> Buffer, or null if it is not sane. */
function toClip(data) {
  let buf = null;
  if (Buffer.isBuffer(data)) buf = data;
  else if (data instanceof ArrayBuffer) buf = Buffer.from(data);
  else if (ArrayBuffer.isView(data)) buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (!buf || buf.length < 3200 || buf.length > MAX_CLIP_BYTES || buf.length % 2) return null;
  return buf;
}

/** Keeps the first REF_MAX_BYTES of one speaker's speech; says when there is enough to copy the voice. */
function makeReference() {
  const parts = [];
  let bytes = 0;
  return {
    add(buf) { if (bytes < REF_MAX_BYTES) { const take = buf.subarray(0, REF_MAX_BYTES - bytes); parts.push(take); bytes += take.length; } },
    get seconds() { return bytes / 32000; },
    get ready() { return bytes / 32000 >= REF_SECONDS; },
    pcm() { return Buffer.concat(parts); },
    clear() { parts.length = 0; bytes = 0; }
  };
}

const toArrayBuffer = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);

function voteLanguage(recent) {
  const last = recent.slice(-6);
  const votes = new Map();
  for (const l of last) votes.set(l, (votes.get(l) || 0) + 1);
  const top = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
  return top && top[1] >= 2 && top[1] / last.length >= 0.5 ? top[0] : 'auto';
}

function setupVoice(ctx) {
  const { app, store, handle, utilityProcess, showBox, event, pushState, transcribe, speechReady, downloadSpeech, modelsRoot } = ctx;
  const osLang = () => { try { return String(app.getPreferredSystemLanguages()[0] || app.getLocale() || 'en').slice(0, 2).toLowerCase(); } catch (e) { return 'en'; } };
  const prefs = () => cleanPrefs({
    in: store.get('voiceIn'), out: store.get('voiceOut'), hear: store.get('voiceHear'), they: store.get('voiceThey'), duck: store.get('voiceDuck')
  }, osLang());
  const consent = () => { const c = store.get('voiceConsent'); return c && typeof c === 'object' && c.ok === true ? { ok: true, google: c.google === true } : null; };

  const dir = () => (process.env.RELAY_TEST && process.env.RELAY_VOICE_MODELS) || modelsRoot || path.join(app.getPath('userData'), 'voice-models');
  const profileFile = () => path.join(app.getPath('userData'), 'voice', 'me.bin');
  const readProfile = () => { try { const b = fs.readFileSync(profileFile()); return b.length >= 64 && b.length % 4 === 0 ? b : null; } catch (e) { return null; } };

  // --- the engine process --------------------------------------------------------------
  let engine = null;                     // { proc, ready, readyPromise, features, jobs, nextId, waiters }
  const modelsPresent = () => {
    const has = (name) => { try { return fs.readdirSync(dir()).some((f) => f.toLowerCase().startsWith(name) && !/\.part$/i.test(f)); } catch (e) { return false; } };
    return { mt: has('translategemma'), voice: has('tone_color') || has('openvoice') };
  };

  function startEngine() {
    if (engine) return engine.readyPromise;
    const proc = ctx.spawnEngine
      ? ctx.spawnEngine(path.join(__dirname, 'voice-engine.js'))
      : utilityProcess.fork(path.join(__dirname, 'voice-engine.js'), [], { serviceName: 'Relay voice', stdio: 'ignore' });
    const e = engine = { proc, ready: false, features: null, jobs: new Map(), nextId: 1, waiters: new Map() };
    e.readyPromise = new Promise((resolve, reject) => {
      proc.on('message', (m) => {
        if (!m) return;
        if (m.type === 'ready') { e.ready = true; e.features = m.features; resolve(e); }
        else if (m.type === 'init-error') reject(new Error(m.message));
        else if (m.type === 'progress') event('voice-status', { phase: 'download', what: m.what, pct: m.pct });
        else if (m.type === 'ensured' || m.type === 'ensure-error') {
          const w = e.waiters.get(m.what);
          if (w) { e.waiters.delete(m.what); if (m.type === 'ensured') w.resolve(); else w.reject(new Error(m.message)); }
        } else if (m.type === 'result' || m.type === 'error') {
          const j = e.jobs.get(m.id);
          if (!j) return;
          e.jobs.delete(m.id);
          if (m.type === 'result') j.resolve(m); else j.reject(new Error(m.message));
        }
      });
      proc.once('exit', () => {
        if (engine === e) { engine = null; if (session) restartNeeded = true; }
        reject(new Error('The voice engine stopped'));
        for (const j of e.jobs.values()) j.reject(new Error('The voice engine stopped'));
        for (const w of e.waiters.values()) w.reject(new Error('The voice engine stopped'));
      });
    });
    e.readyPromise.catch(() => {});
    proc.postMessage({ type: 'init', modelsDir: dir(), device: 'gpu' });
    return e.readyPromise;
  }

  function killEngine() {
    if (!engine) return;
    const p = engine.proc;
    try { p.postMessage({ type: 'quit' }); } catch (e) { /* ignore */ }
    setTimeout(() => { try { p.kill(); } catch (e) { /* gone */ } }, 1500);
    engine = null;
  }

  async function ensureModels(what) {
    const e = await startEngine();
    if (!e.features || !e.features[what]) throw new Error('This build of Relay has no ' + (what === 'mt' ? 'translator' : 'voice') + ' engine');
    await new Promise((resolve, reject) => { e.waiters.set(what, { resolve, reject }); e.proc.postMessage({ type: 'ensure', what }); });
  }

  async function job(op, payload, transfer, timeout) {
    const e = await startEngine();
    return new Promise((resolve, reject) => {
      const id = e.nextId++;
      const timer = setTimeout(() => { e.jobs.delete(id); reject(new Error('The voice engine took too long')); }, timeout || JOB_TIMEOUT);
      e.jobs.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (er) => { clearTimeout(timer); reject(er); } });
      e.proc.postMessage({ type: 'job', id, op, ...payload }, transfer || []);
    });
  }

  // The engine holds gigabytes: released a couple of minutes after the last call translation ends.
  let idleTimer = null;
  const armIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(killEngine, 120000); };

  // --- one call ----------------------------------------------------------------------------
  let session = null;
  let restartNeeded = false;                 // the engine process died during a call: the next clip starts it again
  let modelsMissingMt = false;
  const newSession = () => ({
    startedAt: Date.now(), refIn: makeReference(), refOut: makeReference(), embIn: null, embOut: null, buildingIn: false, buildingOut: false,
    theirLang: '', announced: false, recent: { in: [], out: [] }, busy: { in: 0, out: 0 }, localMt: true, failures: 0
  });

  const state = () => {
    const p = prefs();
    const have = modelsPresent();
    return {
      ...p, languages: LANGS, consent: Boolean(consent()), active: Boolean(session),
      mt: have.mt, voice: have.voice, myVoice: Boolean(readProfile()), their: session ? session.theirLang : ''
    };
  };

  async function askConsent() {
    const detail = 'During a call Relay listens to the other person and to your microphone, turns the speech into text on this PC, translates it, and speaks the translation in a copy of the speaker\'s voice. ' +
      'Nothing is recorded and no audio leaves your computer. A small profile of your own voice is kept on this PC (delete it any time in the Relay panel); the other person\'s voice is only held in memory during the call.\n\n' +
      'The other person hears a spoken notice that the call is being translated automatically. A translation can be wrong or sound unlike the speaker - do not rely on it for anything important. ' +
      'Use it only where everyone on the call is fine with it, and never to pass yourself off as someone else.\n\n' +
      'The first time, about 3 GB of models are downloaded (translator and voices). The translator is Google Gemma, used under the Gemma Terms of Use (ai.google.dev/gemma/terms); the voices are Kokoro and Piper (open licences) with OpenVoice.';
    const { response, checkboxChecked } = await showBox({
      type: 'question', title: 'Live voice translation', message: 'Translate your calls out loud?', detail,
      buttons: ['Turn on', 'Cancel'], defaultId: 0, cancelId: 1,
      checkboxLabel: 'If the translator is not installed, use Google Translate (sends only text)', checkboxChecked: false
    });
    if (response !== 0) return false;
    store.set('voiceConsent', { ok: true, google: Boolean(checkboxChecked) });
    pushState();
    return true;
  }

  // --- translating text -----------------------------------------------------------------
  async function translateText(text, from, to) {
    if (!text || baseLang(from) === baseLang(to)) return text;
    const s = session;
    if (s && s.localMt && !modelsMissingMt && modelsPresent().mt) {
      try { return (await job('translate', { text, from: from || 'auto', to })).text; } catch (err) {
        if (/no translator engine|not found|missing|ENOENT|download/i.test(err.message)) s.localMt = false;       // not usable: Google, if allowed
        else throw err;
      }
    }
    const c = consent();
    if (c && c.google) {
      const r = await translateCaption(text, to, { fetch: ctx.fetch, from });
      return r.text || text;
    }
    throw new Error('No translator is installed');
  }

  /** Once there are about ten seconds of someone's speech, their voice is copied (in the background). */
  function buildEmbedding(direction) {
    const s = session;
    if (!s) return;
    const key = direction === 'in' ? 'In' : 'Out';
    if (s['emb' + key] || s['building' + key]) return;
    if (direction === 'out' && s.noSave) return;
    if (direction === 'out') {
      const saved = readProfile();
      if (saved) { s.embOut = Buffer.from(saved); return; }
    }
    const ref = direction === 'in' ? s.refIn : s.refOut;
    if (!ref.ready) return;
    s['building' + key] = true;
    const pcm = ref.pcm();
    job('speaker', { pcm: toArrayBuffer(pcm) })
      .then((r) => {
        if (session !== s) return;
        const emb = Buffer.from(r.emb);
        s['emb' + key] = emb;
        if (direction === 'out') {
          fs.promises.mkdir(path.dirname(profileFile()), { recursive: true }).then(() => fs.promises.writeFile(profileFile(), emb)).then(() => pushState()).catch(() => {});
        }
        event('voice-status', { phase: 'voice-copied', direction });
      })
      .catch((err) => { console.warn('[voice] could not copy a voice:', err.message); })
      .finally(() => { s['building' + key] = false; ref.clear(); });
  }

  // --- one clip, either direction ---------------------------------------------------------
  /** direction 'in': the other person speaking; 'out': you speaking. Returns the audio to play, or { skipped } when there is nothing to say. */
  async function handleClip(direction, data, meta) {
    const s = session;
    if (!s) return { skipped: 'off' };
    if (restartNeeded) {
      restartNeeded = false;
      event('voice-status', { phase: 'loading' });
      job('warm', {}, [], 5 * 60 * 1000).catch((err) => console.warn('[voice] restart failed:', err.message));
      return { skipped: 'restarting' };
    }
    const buf = toClip(data);
    if (!buf) throw new Error('Bad audio');
    const p = prefs();
    if ((direction === 'in' && !p.in) || (direction === 'out' && !p.out)) return { skipped: 'off' };
    if (s.busy[direction] >= 2) return { skipped: 'busy' };
    s.busy[direction]++;
    try {
      (direction === 'in' ? s.refIn : s.refOut).add(buf);
      buildEmbedding(direction);

      const secs = buf.length / 32000;
      const fixed = direction === 'in' && typeof ctx.theirLanguage === 'function' ? ctx.theirLanguage() : 'auto';       // "Spoken language" chosen in the caption settings
      const hint = fixed && fixed !== 'auto' ? fixed : secs < 2.2 ? voteLanguage(s.recent[direction]) : 'auto';
      const r = await transcribe(buf, hint);
      if (!r.text || session !== s) return { skipped: 'silence' };
      const spoken = r.language || '';
      if (spoken) { s.recent[direction].push(spoken); if (s.recent[direction].length > 8) s.recent[direction].shift(); }
      if (direction === 'in' && spoken) s.theirLang = spoken;

      const target = direction === 'in' ? p.hear : (p.they !== 'auto' ? p.they : s.theirLang);
      if (!target) return { skipped: 'unknown-language', text: r.text };
      if (baseLang(spoken) === baseLang(target)) return { skipped: 'same-language', text: r.text, lang: spoken };

      const translated = await translateText(r.text, spoken || 'auto', target);
      const norm = (t) => String(t).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
      if (norm(translated) === norm(r.text)) return { skipped: 'same-language', text: r.text, lang: spoken };
      const emb = direction === 'in' ? s.embIn : s.embOut;
      const out = { text: translated, original: r.text, from: spoken, to: target, seq: meta && Number.isInteger(meta.seq) ? meta.seq : 0, voiceCopied: Boolean(emb) };

      // what the other person hears first: a spoken notice, in their language, in your voice
      if (direction === 'out' && !s.announced) {
        s.announced = true;
        try {
          const note = await translateText(DISCLOSURE, 'en', target);
          const n = await job('synth', { text: note, lang: target, emb: emb ? toArrayBuffer(emb) : null });
          out.notice = { pcm: n.pcm, rate: n.rate, text: note };
        } catch (err) { /* the call goes on; the on-screen icon is the other half of the notice */ }
      }
      const a = await job('synth', { text: translated, lang: target, emb: emb ? toArrayBuffer(emb) : null });
      out.pcm = a.pcm;
      out.rate = a.rate;
      s.failures = 0;
      return out;
    } catch (err) {
      s.failures++;
      throw err;
    } finally {
      s.busy[direction]--;
    }
  }

  // --- channels -----------------------------------------------------------------------------
  handle('relay:voice-set', (_e, name, value) => {
    const keys = { in: 'voiceIn', out: 'voiceOut', hear: 'voiceHear', they: 'voiceThey', duck: 'voiceDuck' };
    if (!keys[name]) throw new Error('Unknown setting');
    const next = cleanPrefs({ ...prefs(), [name]: value }, osLang());
    if (next[name] !== value) throw new Error('That is not a valid choice');
    store.set(keys[name], value);
    pushState();
    return state();
  });

  handle('relay:voice-forget', async () => {
    try { await fs.promises.unlink(profileFile()); } catch (e) { /* none */ }
    if (session) { session.embOut = null; session.noSave = true; session.refOut.clear(); }
    pushState();
    return state();
  });

  let starting = null;
  handle('relay:voice-start', () => {
    if (starting) return starting;
    starting = (async () => {
      if (!consent() && !(await askConsent())) return { ok: false, reason: 'declined' };
      try {
        event('voice-status', { phase: 'loading' });
        if (!speechReady()) {
          event('voice-status', { phase: 'download', what: 'speech', pct: 0 });
          await downloadSpeech((pct) => event('voice-status', { phase: 'download', what: 'speech', pct }));
        }
        const e = await startEngine();
        const c = consent();
        // Checks every file's size and fingerprint (under a second when all are there) and downloads whatever is missing or damaged.
        if (c && c.google) await ensureModels('mt').catch(() => {});        // best effort: Google covers a missing translator
        else await ensureModels('mt');
        await ensureModels('voice');
        event('voice-status', { phase: 'loading' });
        const warm = await job('warm', {}, [], 5 * 60 * 1000);          // models into memory (the very first start also compiles shaders)
        if (!warm.mt) modelsMissingMt = true;
        clearTimeout(idleTimer);
        session = newSession();
        pushState();
        event('voice-status', { phase: 'ready', local: Boolean(e.features && e.features.mt) });
        return { ok: true };
      } catch (err) {
        console.warn('[voice] could not start:', err.message);
        const message = /internet|ENOTFOUND|fetch failed|ERR_/i.test(err.message)
          ? 'No internet connection - the voice models could not be downloaded.'
          : 'Live translation could not start: ' + String(err.message || err).slice(0, 140);
        event('voice-status', { phase: 'error', message });
        return { ok: false, reason: 'error', message };
      }
    })().finally(() => { starting = null; });
    return starting;
  });

  handle('relay:voice-stop', () => {
    session = null;
    armIdle();
    pushState();
    return true;
  });

  handle('relay:voice-clip', async (_e, direction, data, meta) => {
    if (direction !== 'in' && direction !== 'out') throw new Error('Bad direction');
    return handleClip(direction, data, meta);
  });

  /** The engine modules ship with the app; until they do, the panel and the call button stay hidden. */
  const available = () => ['mt-local.js', 'voiceclone.js'].every((f) => fs.existsSync(path.join(__dirname, 'voice', f)));

  return {
    state, available,
    reset: () => { if (session) { session = null; armIdle(); pushState(); } },       // the page went away (reload, crash)
    shutdown: () => { session = null; killEngine(); },
    _test: { handleClip, newSession, setSession: (s) => { session = s; } }
  };
}

module.exports = { setupVoice, cleanPrefs, toClip, makeReference, voteLanguage, LANGS, DEFAULTS, REF_SECONDS, DISCLOSURE };
