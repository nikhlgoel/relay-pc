'use strict';
/*
 * Speech-to-text engine for live call captions. Runs in its own process (Electron
 * utilityProcess, started by src/captions.js) so that a graphics-driver crash can
 * never take Relay down in the middle of a call, and so the model's memory is given
 * back by simply ending the process.
 *
 * It wraps whisper.cpp (MIT) through @fugood/node-whisper-win32-x64-vulkan, the GPU
 * build: on the CPU the same model needs 6-12 seconds per clip, which is useless for
 * live captions, while any recent GPU takes 0.15-2 seconds.
 *
 *   parent -> engine   { type: 'init', model, threads }
 *                      { type: 'run', id, pcm: ArrayBuffer (16-bit mono 16 kHz), language: 'auto' | 'xx' }
 *   engine -> parent   { type: 'ready', devices, ms }          after the model is loaded and warmed up
 *                      { type: 'init-error', message }
 *                      { type: 'result', id, text, language, ms }
 *                      { type: 'error', id, message }
 *
 * Which GPU is used is decided by the parent through the GGML_VK_VISIBLE_DEVICES
 * environment variable of this process. Audio is never written to disk.
 */

const port = process.parentPort;
let ctx = null;
let chain = Promise.resolve();

const send = (msg) => { try { port.postMessage(msg); } catch (e) { /* the parent is gone */ } };

/** "ggml_vulkan: 1 = NVIDIA GeForce RTX 3050 (NVIDIA) | uma: 0 | ..." -> { index, name, discrete } */
function parseDeviceLine(text) {
  const m = /ggml_vulkan:\s*(\d+)\s*=\s*(.+?)\s*\(([^)]*)\)\s*\|\s*uma:\s*(\d)/.exec(String(text));
  return m ? { index: Number(m[1]), name: m[2], vendor: m[3], discrete: m[4] === '0' } : null;
}

async function init({ model, threads }) {
  const t0 = Date.now();
  const devices = [];
  let usedGpu = false, noGpu = false;
  let mod;
  try {
    mod = require('@fugood/node-whisper-win32-x64-vulkan');
  } catch (e) {
    return send({ type: 'init-error', message: 'The speech engine could not be loaded (' + e.message + ')' });
  }
  try {
    // The engine's log lines arrive a moment AFTER the context is created, not while it is being made.
    mod.WhisperContext.toggleNativeLog(true, (level, text) => {
      const line = String(text);
      const d = parseDeviceLine(line);
      if (d) devices.push(d);
      if (/whisper_backend_init_gpu: using Vulkan\d*\s+backend/.test(line)) usedGpu = true;
      if (/no GPU found/i.test(line)) noGpu = true;
      if (level === 'error') send({ type: 'log', text: line.slice(0, 300) });
    });
  } catch (e) { /* logging is optional */ }

  try {
    ctx = await new mod.WhisperContext({ filePath: model, useGpu: true });
  } catch (e) {
    return send({ type: 'init-error', message: 'The speech model could not be loaded (' + e.message + ')' });
  }
  for (let waited = 0; waited < 3000 && !usedGpu && !noGpu; waited += 50) await new Promise((r) => setTimeout(r, 50));
  try { mod.WhisperContext.toggleNativeLog(false); } catch (e) { /* ignore */ }
  if (!usedGpu) {
    // The GPU backend did not come up: do not pretend; the CPU is far too slow for live captions.
    try { await ctx.release(); } catch (e) { /* ignore */ }
    ctx = null;
    return send({ type: 'init-error', message: 'No graphics card with Vulkan support was found', noGpu: true });
  }

  // First use compiles the GPU kernels (several seconds); do it now, not on the first sentence.
  try {
    const { promise } = ctx.transcribeData(new ArrayBuffer(32000), { language: 'en', maxThreads: threads || 2, temperature: 0, beamSize: 1, bestOf: 1, maxContext: 0 });
    await promise;
  } catch (e) { /* a failed warm-up shows up on the first real clip */ }
  send({ type: 'ready', devices, ms: Date.now() - t0 });
}

function run({ id, pcm, language, threads, translate }) {
  chain = chain.then(async () => {
    if (!ctx) return send({ type: 'error', id, message: 'The speech engine is not running' });
    const t0 = Date.now();
    try {
      const data = pcm instanceof ArrayBuffer ? pcm : (pcm && pcm.buffer ? pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) : null);
      if (!data || data.byteLength < 3200) return send({ type: 'result', id, text: '', language: '', ms: 0 });
      const { promise } = ctx.transcribeData(data, {
        language: /^[a-z]{2,3}$/.test(language || '') ? language : 'auto',
        translate: translate === true,   // Whisper's own speech-to-English, fully offline
        maxThreads: threads || 2,
        temperature: 0,
        beamSize: 1,
        bestOf: 1,
        maxContext: 0                // each clip stands alone; the previous one must not leak in
      });
      const r = await promise;
      send({ type: 'result', id, text: String(r.result || ''), language: String(r.language || ''), ms: Date.now() - t0 });
    } catch (e) {
      send({ type: 'error', id, message: String((e && e.message) || e) });
    }
  });
}

// (Outside Electron - the unit tests - there is no parent port; only the helper is used.)
if (port) {
  port.on('message', (e) => {
    const m = e && e.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'init') init(m).catch((err) => send({ type: 'init-error', message: String((err && err.message) || err) }));
    else if (m.type === 'run') run(m);
    else if (m.type === 'quit') {
      chain.then(async () => {
        try { if (ctx) await ctx.release(); } catch (err) { /* ignore */ }
        process.exit(0);
      });
    }
  });
}

module.exports = { parseDeviceLine };
