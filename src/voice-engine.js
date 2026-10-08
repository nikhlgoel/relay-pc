'use strict';
/*
 * Live voice translation: the engine process (started by src/voice.js as an Electron utility process).
 * It holds the two heavy models away from the main process:
 *   - the translator   (src/voice/mt-local.js:   local text translation, any language to any language)
 *   - the voice layer  (src/voice/voiceclone.js: a base voice in the target language, then the speaker's own timbre on top)
 * Messages in:  { type: 'init', modelsDir, device }                  -> 'ready' | 'init-error'
 *               { type: 'ensure', what: 'mt' | 'voice' }               -> 'progress' ..., 'ensured' | 'ensure-error'
 *               { type: 'job', id, op: 'translate' | 'speaker' | 'synth', ... } -> 'result' | 'error'
 * Messages out: { type: 'ready', features } / { type: 'result', id, ... } / { type: 'error', id, message } / { type: 'progress', what, pct }
 * Nothing here touches the network except downloading models, and nothing is written except the models themselves.
 */

const port = process.parentPort;
const send = (m, transfer) => { try { port.postMessage(m, transfer); } catch (e) { /* the parent is gone */ } };

let mt = null, vc = null, translator = null, voice = null;
let modelsDir = '', device = 'auto';
let chain = Promise.resolve();                       // one job at a time: the models share one graphics card

function load(name) {
  try { return require(name); } catch (e) { return null; }
}

async function init(msg) {
  modelsDir = String(msg.modelsDir || '');
  device = msg.device === 'cpu' || msg.device === 'gpu' ? msg.device : 'auto';
  mt = load('./voice/mt-local');
  vc = load('./voice/voiceclone');
  send({ type: 'ready', features: { mt: Boolean(mt), voice: Boolean(vc) } });
}

async function ensure(what) {
  const mod = what === 'mt' ? mt : vc;
  if (!mod) throw new Error('This build has no ' + (what === 'mt' ? 'translator' : 'voice') + ' engine');
  const progress = (pct) => send({ type: 'progress', what, pct });
  if (what === 'mt') await mod.ensureModel(modelsDir, progress); else await mod.ensureModels(modelsDir, progress);
}

async function getTranslator() {
  if (!translator) translator = await mt.createTranslator({ modelsDir, device: device === 'cpu' ? 'cpu' : 'gpu' });
  return translator;
}

async function getVoice() {
  if (!voice) voice = await vc.createEngine({ modelsDir, provider: 'auto' });
  return voice;
}

const toF32 = (ab) => new Float32Array(ab.buffer ? ab.buffer.slice(ab.byteOffset, ab.byteOffset + ab.byteLength) : ab);

async function job(m) {
  if (m.op === 'translate') {
    const t = await getTranslator();
    return { text: await t.translate(String(m.text || ''), String(m.from || 'auto'), String(m.to || 'en')) };
  }
  if (m.op === 'speaker') {
    const v = await getVoice();
    const i16 = new Int16Array(m.pcm.buffer ? m.pcm.buffer.slice(m.pcm.byteOffset, m.pcm.byteOffset + m.pcm.byteLength) : m.pcm);
    const f = new Float32Array(i16.length);
    for (let i = 0; i < i16.length; i++) f[i] = i16[i] / 32768;
    const emb = await v.speakerFromPcm(f, 16000);
    return { emb: Float32Array.from(emb).buffer };
  }
  if (m.op === 'synth') {
    const v = await getVoice();
    const emb = m.emb ? toF32(m.emb) : null;
    const r = await v.synth(String(m.text || ''), String(m.lang || 'en'), emb);
    const pcm = Float32Array.from(r.pcm);
    return { pcm: pcm.buffer, rate: r.sampleRate };
  }
  throw new Error('Unknown job');
}

if (port) {
  port.on('message', (e) => {
    const m = e && e.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'init') { init(m).catch((err) => send({ type: 'init-error', message: String((err && err.message) || err) })); return; }
    if (m.type === 'ensure') {
      chain = chain.then(() => ensure(m.what).then(
        () => send({ type: 'ensured', what: m.what }),
        (err) => send({ type: 'ensure-error', what: m.what, message: String((err && err.message) || err) })));
      return;
    }
    if (m.type === 'job') {
      chain = chain.then(async () => {
        try {
          const r = await job(m);
          const transfer = [];
          if (r.pcm) transfer.push(r.pcm);
          if (r.emb) transfer.push(r.emb);
          send({ type: 'result', id: m.id, ...r }, transfer);
        } catch (err) { send({ type: 'error', id: m.id, message: String((err && err.message) || err) }); }
      });
      return;
    }
    if (m.type === 'quit') {
      Promise.resolve().then(async () => {
        try { if (translator) await translator.dispose(); } catch (err) { /* ignore */ }
        try { if (voice) await voice.dispose(); } catch (err) { /* ignore */ }
        process.exit(0);
      });
    }
  });
}

module.exports = { _test: { load } };
