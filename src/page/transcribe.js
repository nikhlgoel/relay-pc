/* Relay panel - a text transcript of a call recording (page side; main-process half: handlers relay:transcribe-* in src/main.js).
   "Transcribe a recording" in the Relay panel: pick a recording, wait while it is turned into text on this PC (the same speech
   model as live captions; nothing is uploaded), then save it as a .txt with a time before every passage, plus a .srt subtitle
   file next to it. The sound is decoded here in the page (Chromium can read the recordings' formats) and sent in pieces of
   about 25 seconds, cut at the quietest moment so words are not split. */
(() => {
  'use strict';
  const R = window.__relay;
  if (!R || R.transcribe) return;

  const RATE = 16000;
  const WINDOW = 25 * RATE;               // a piece is about this long...
  const SEARCH = 5 * RATE;                // ...and is cut at the quietest 100 ms in its last five seconds
  let running = false;

  const two = (n) => String(n).padStart(2, '0');
  const stamp = (sec, srt) => {
    const t = Math.floor(sec), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    const ms = Math.min(999, Math.round((sec - t) * 1000));
    return srt ? two(h) + ':' + two(m) + ':' + two(s) + ',' + String(ms).padStart(3, '0') : (h ? two(h) + ':' : '') + two(m) + ':' + two(s);
  };

  /** Mono 16 kHz samples of the file's sound. */
  async function decode(data) {
    const bytes = data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    const ctx = new OfflineAudioContext(1, 1, RATE);
    const buf = await ctx.decodeAudioData(bytes);
    const out = new Float32Array(buf.length);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const ch = buf.getChannelData(c);
      for (let i = 0; i < out.length; i++) out[i] += ch[i] / buf.numberOfChannels;
    }
    return out;
  }

  /** Where to cut a piece that starts at `from`: the quietest 100 ms of its last five seconds. */
  function cutPoint(pcm, from) {
    const end = Math.min(pcm.length, from + WINDOW);
    if (end >= pcm.length) return pcm.length;
    let best = end, quiet = Infinity;
    const block = RATE / 10;
    for (let at = end - SEARCH; at + block <= end; at += block) {
      let e = 0;
      for (let i = at; i < at + block; i++) e += pcm[i] * pcm[i];
      if (e < quiet) { quiet = e; best = at + block / 2; }
    }
    return Math.round(best);
  }

  const toInt16 = (f) => {
    const o = new Int16Array(f.length);
    for (let i = 0; i < f.length; i++) { const v = Math.max(-1, Math.min(1, f[i])); o[i] = v < 0 ? v * 32768 : v * 32767; }
    return o;
  };

  async function run() {
    if (running) { R.toast('A transcript is already being made'); return; }
    running = true;
    try {
      const picked = await R.call('transcribe-pick');
      if (!picked) return;
      R.toast('Reading ' + picked.name + '...');
      const pcm = await decode(picked.data);
      if (pcm.length < RATE) { R.toast('That recording has no sound to transcribe'); return; }
      const cues = [];
      let from = 0, language = 'auto', lastToast = 0;
      while (from < pcm.length) {
        const to = cutPoint(pcm, from);
        const piece = pcm.subarray(from, to);
        if (piece.length >= RATE / 5) {
          const r = await R.call('transcribe-clip', toInt16(piece), language);
          if (r.language && language === 'auto') language = r.language;                    // after the first passage the language is known
          if (r.text) cues.push({ start: from / RATE, end: to / RATE, text: r.text });
        }
        from = to;
        if (Date.now() - lastToast > 4000) { lastToast = Date.now(); R.toast('Transcribing ' + Math.round(from / pcm.length * 100) + '%'); }
      }
      if (!cues.length) { R.toast('No speech was found in that recording'); return; }
      const txt = cues.map((c) => '[' + stamp(c.start) + '] ' + c.text).join('\r\n') + '\r\n';
      const srt = cues.map((c, i) => (i + 1) + '\r\n' + stamp(c.start, true) + ' --> ' + stamp(c.end, true) + '\r\n' + c.text + '\r\n').join('\r\n');
      const saved = await R.call('transcribe-save', picked.name, txt, srt);
      if (saved) R.toast('Saved ' + saved + ' (and a .srt subtitle file)');
    } catch (err) {
      R.toast('Transcript: ' + (err && err.message ? err.message : 'something went wrong'));
    } finally { running = false; }
  }

  R.on('transcribe-status', (m) => { if (m && m.phase === 'download') R.toast('Downloading the speech model ' + Math.round((m.pct || 0) * 100) + '%'); });
  R.transcribe = { run, _test: { stamp, cutPoint, decode } };
})();
