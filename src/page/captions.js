/* Relay panel - live captions during a call (page side; main-process half: src/captions.js).

   A CC button joins the call toolbar (or press C). While it is on:
     1. the other person's voice is read from the call's own audio (the same tap the
        recorder uses, window.__relayTap), resampled to 16 kHz by an AudioContext,
     2. a small voice-activity segmenter cuts it into clips at natural pauses,
     3. each clip goes to the main process, which turns it into text on this PC,
        detects the language and translates it (default: English),
     4. the caption is shown over the call, inside the call panel, so it is there in
        the normal view and in full screen alike.
   Nothing is shown or recorded when the button is off. */
(() => {
  'use strict';
  const R = window.__relay;
  if (!R || R.captions) return;
  const { el } = R;

  // ---------------------------------------------------------------------------
  // Segmenter: 100 ms frames of 16 kHz audio in, clips of speech out.
  // (Self-contained so test/captions.test.js can run it on its own.)
  // ---------------------------------------------------------------------------
  /* segmenter:start */
  function makeSegmenter(onClip, onSpeech, cfg) {
    const C = Object.assign({
      frameMs: 100,
      preRoll: 3,            // frames of lead-in kept before speech is noticed
      tail: 2,               // frames of trailing silence kept in a clip
      minSpeechMs: 300,      // shorter than this is a click or a cough
      endSilenceMs: 600,     // a normal pause ends a clip
      softAfterMs: 2500,     // a clip this long ends at a shorter pause...
      softSilenceMs: 300,
      hardAfterMs: 5000,     // ...and at an even shorter one
      hardSilenceMs: 150,
      maxMs: 9000,           // never longer than this
      margin: 9,             // dB above the noise floor that counts as voice
      absMin: -50,           // dBFS: never quieter than this
      floorWindow: 80,       // the noise floor is a low percentile of the last 8 s of audio...
      floorPct: 0.15,        // ...so a steady hiss is learned even while a "clip" is open, and speech pauses are not mistaken for it
      floorMax: -40          // a line noisier than this is treated as voice (nothing sensible can be done)
    }, cfg || {});
    let floor = -60;         // running estimate of the noise floor, dBFS
    let pre = [];
    let seg = null;
    let run = 0;
    let speaking = false;
    const hist = [];         // recent frame levels

    function learnFloor(db) {
      hist.push(db);
      if (hist.length > C.floorWindow) hist.shift();
      if (hist.length < 5) return;
      const sorted = hist.slice().sort((a, b) => a - b);
      const target = Math.max(-65, Math.min(C.floorMax, sorted[Math.floor(sorted.length * C.floorPct)]));
      floor += (target - floor) * (target < floor ? 0.3 : 0.08);                  // falls fast, rises slowly
    }

    const level = (f) => {
      let s = 0;
      for (let i = 0; i < f.length; i++) s += f[i] * f[i];
      return 10 * Math.log10(s / f.length + 1e-12);
    };

    function toPcm(frames) {
      let n = 0;
      for (const f of frames) n += f.length;
      let peak = 0;
      for (const f of frames) for (let i = 0; i < f.length; i++) { const a = Math.abs(f[i]); if (a > peak) peak = a; }
      const gain = peak > 0.001 && peak < 0.35 ? Math.min(8, 0.7 / peak) : 1;       // quiet callers: lift to a sane level
      const out = new Int16Array(n);
      let o = 0;
      for (const f of frames) {
        for (let i = 0; i < f.length; i++) {
          const x = Math.max(-1, Math.min(1, f[i] * gain));
          out[o++] = x < 0 ? x * 0x8000 : x * 0x7fff;
        }
      }
      return out.buffer;
    }

    function setSpeaking(v) { if (v !== speaking) { speaking = v; if (onSpeech) onSpeech(v); } }

    function finish() {
      const s = seg;
      seg = null; pre = []; run = 0;
      setSpeaking(false);
      if (!s || s.voiced * C.frameMs < C.minSpeechMs) return;
      const keep = s.frames.length - Math.max(0, s.silence - C.tail);
      onClip(toPcm(s.frames.slice(0, keep)), keep * C.frameMs);
    }

    function step(frame) {
      const db = level(frame);
      learnFloor(db);
      const voiced = db > Math.max(C.absMin, floor + C.margin);
      if (!seg) {
        pre.push(frame);
        if (pre.length > C.preRoll + 2) pre.shift();
        run = voiced ? run + 1 : 0;
        if (run >= 2) { seg = { frames: pre, voiced: run, silence: 0 }; pre = []; run = 0; setSpeaking(true); }
        return;
      }
      seg.frames.push(frame);
      if (voiced) { seg.voiced++; seg.silence = 0; } else seg.silence++;
      const len = seg.frames.length * C.frameMs;
      const sil = seg.silence * C.frameMs;
      if (sil >= C.endSilenceMs || (len >= C.softAfterMs && sil >= C.softSilenceMs) ||
          (len >= C.hardAfterMs && sil >= C.hardSilenceMs) || len >= C.maxMs) finish();
    }

    // The first half second is only watched: steady, low-level sound is line noise (start from that floor),
    // sound that varies like speech is not. Then the same frames are replayed through the normal path.
    let warm = [];
    function calibrate(frames) {
      const levels = frames.map(level).sort((a, b) => a - b);
      const med = levels[Math.floor(levels.length / 2)];
      if (levels[levels.length - 1] - levels[0] < 4 && med < -30) floor = Math.max(-65, Math.min(C.floorMax, med));
    }

    return {
      push(frame) {
        if (warm) {
          warm.push(frame);
          if (warm.length < 5) return;
          const frames = warm;
          warm = null;
          calibrate(frames);
          frames.forEach(step);
          return;
        }
        step(frame);
      },
      flush() { if (warm) { const frames = warm; warm = null; frames.forEach(step); } if (seg) finish(); },
      get floor() { return floor; }
    };
  }
  /* segmenter:end */

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  const CC_ICON = 'M19 4H5c-1.11 0-2 .9-2 2v12c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm-8 7H9.5v-.5h-2v3h2V13H11v1c0 .55-.45 1-1 1H7c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1zm7 0h-1.5v-.5h-2v3h2V13H18v1c0 .55-.45 1-1 1h-3c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1z';
  const RTL = /^(ar|he|fa|ur)$/;
  const S = {
    on: false, starting: false,
    tap: null, ctx: null, node: null, segmenter: null,
    seq: 0, inFlight: 0, ready: new Map(), nextShow: 1, stuckSince: 0,
    lines: [], lastLang: '', speaking: false, lastCaptionAt: 0,
    status: '', pct: -1, toastedAt: 0, popover: null, overlay: null, missing: 0
  };

  const panelEl = () => document.querySelector('[data-testid="move_resize_component"]');
  const prefs = () => (R.state && R.state.captions) || { lang: 'en', size: 'm', original: false, model: 'fast', targets: ['en'], models: {}, consent: false };
  let names = null;
  function langName(code) {
    if (!code) return '';
    try {
      if (!names) names = new Intl.DisplayNames([navigator.language || 'en'], { type: 'language' });
      return names.of(code) || code;
    } catch (e) { return code; }
  }
  const toastOnce = (msg) => { if (Date.now() - S.toastedAt > 45000) { S.toastedAt = Date.now(); R.toast(msg); } };

  // ---------------------------------------------------------------------------
  // Listening to the call
  // ---------------------------------------------------------------------------
  const WORKLET = [
    'class RelayCC extends AudioWorkletProcessor {',
    '  constructor() { super(); this.buf = new Float32Array(1600); this.n = 0; }',
    '  process(inputs) {',
    '    const ch = inputs[0] && inputs[0][0];',
    '    for (let i = 0; i < 128; i++) {',
    '      this.buf[this.n++] = ch ? ch[i] : 0;',
    '      if (this.n === 1600) { const out = this.buf; this.buf = new Float32Array(1600); this.n = 0; this.port.postMessage(out, [out.buffer]); }',
    '    }',
    '    return true;',
    '  }',
    '}',
    "registerProcessor('relay-cc', RelayCC);"
  ].join('\n');

  async function openCapture() {
    const api = window.__relayTap;
    if (!api) throw new Error('no audio tap');
    const ctx = new AudioContext({ sampleRate: 16000, latencyHint: 'playback' });
    try {
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
      try { await ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
      const node = new AudioWorkletNode(ctx, 'relay-cc', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });
      const mute = ctx.createGain();
      mute.gain.value = 0;
      const sink = ctx.createMediaStreamDestination();
      sink.__relayTap = true;                                  // not a speaker: the recorder's tap ignores it
      node.__relayOwn = mute.__relayOwn = true;
      node.connect(mute);
      mute.connect(sink);
      S.segmenter = makeSegmenter(submit, (v) => { S.speaking = v; paintMeta(); });
      node.port.onmessage = (e) => { if (S.on) S.segmenter.push(e.data); };
      S.ctx = ctx;
      S.node = node;
      window.__relayBuildingAudio = true;
      try {
        S.tap = api.start((d) => {
          const src = ctx.createMediaStreamSource(d.stream);
          src.__relayOwn = true;
          src.connect(node);
        });
      } finally { window.__relayBuildingAudio = false; }
      if (ctx.state === 'suspended') await ctx.resume();
    } catch (err) {
      try { ctx.close(); } catch (e) { /* ignore */ }
      throw err;
    }
  }

  function closeCapture() {
    try { if (S.segmenter) S.segmenter.flush(); } catch (e) { /* ignore */ }
    if (S.tap && window.__relayTap) { try { window.__relayTap.stop(S.tap); } catch (e) { /* ignore */ } }
    if (S.node) { try { S.node.port.onmessage = null; S.node.disconnect(); } catch (e) { /* ignore */ } }
    if (S.ctx) { try { S.ctx.close(); } catch (e) { /* ignore */ } }
    S.tap = S.node = S.ctx = S.segmenter = null;
  }

  // ---------------------------------------------------------------------------
  // Clips -> main process -> captions (shown in order)
  // ---------------------------------------------------------------------------
  function submit(pcm) {
    if (!S.on) return;
    if (S.inFlight >= 3) { S.seq++; S.ready.set(S.seq, null); drain(); setStatus('Catching up...'); return; }   // the engine is behind: skip this clip
    const seq = ++S.seq;
    S.inFlight++;
    R.call('caption-audio', pcm, { seq })
      .then((res) => { S.ready.set(seq, res && res.text ? res : null); if (res && res.busy) setStatus('Catching up...'); if (res && res.note) toastOnce('Captions: ' + res.note); })
      .catch(() => { S.ready.set(seq, null); })
      .finally(() => { S.inFlight--; drain(); });
  }

  function drain() {
    while (S.ready.has(S.nextShow)) {
      const res = S.ready.get(S.nextShow);
      S.ready.delete(S.nextShow);
      S.nextShow++;
      S.stuckSince = 0;
      if (res) showCaption(res);
    }
    // a clip that never came back must not hold the rest up for ever
    if (S.ready.size) {
      if (!S.stuckSince) S.stuckSince = Date.now();
      else if (Date.now() - S.stuckSince > 6000) { S.nextShow = Math.min(...S.ready.keys()); S.stuckSince = 0; drain(); }
    }
  }

  // ---------------------------------------------------------------------------
  // The overlay
  // ---------------------------------------------------------------------------
  function ensureOverlay(panel) {
    if (S.overlay && S.overlay.isConnected && S.overlay.parentElement === panel) return S.overlay;
    if (S.overlay) S.overlay.remove();
    if (getComputedStyle(panel).position === 'static') panel.style.position = 'relative';   // the caption is placed against the call panel
    const ov = el('div', { id: 'relay-cc', attrs: { 'aria-live': 'polite', 'aria-atomic': 'false', role: 'log' } },
      el('div', { class: 'cc-lines' }),
      el('button', { class: 'cc-chip', type: 'button', attrs: { 'aria-haspopup': 'dialog', 'aria-label': 'Caption settings' }, on: { click: (e) => { e.stopPropagation(); togglePopover(); } } }));
    ov.addEventListener('pointerdown', (e) => e.stopPropagation());      // the panel is draggable; the chip must not start that
    enableDrag(ov);
    panel.append(ov);
    S.overlay = ov;
    applied.dx = applied.dy = 0;                 // a new overlay starts with no offset applied
    layout();
    paintMeta();
    return ov;
  }

  /** Top edge of the bar that holds the call buttons (so captions sit above all of it, not just above one button). */
  function toolbarTop(panel, pr) {
    const end = panel.querySelector('button[aria-label*="End call" i]');
    if (!end) return null;
    const own = end.getBoundingClientRect();
    if (!own.height) return null;                                  // controls hidden: use the default spot
    for (let n = end.parentElement; n && n !== panel; n = n.parentElement) {
      const r = n.getBoundingClientRect();
      if (r.width >= pr.width * 0.6 && r.height < pr.height * 0.45) return Math.min(r.top, own.top);
    }
    return own.top - 16;
  }

  // Where the captions sit is the viewer's choice: at the bottom (default) or the top of the call, and anywhere in between
  // by dragging them. It is remembered on this PC (a per-viewer convenience, so browser storage is the right place).
  const POS_KEY = 'relay.ccPos';
  const pos = { edge: 'bottom', dx: 0, dy: 0 };
  try {
    const saved = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
    if (saved && (saved.edge === 'top' || saved.edge === 'bottom')) { pos.edge = saved.edge; pos.dx = Number(saved.dx) || 0; pos.dy = Number(saved.dy) || 0; }
  } catch (e) { /* storage unavailable: defaults */ }
  const savePos = () => { try { localStorage.setItem(POS_KEY, JSON.stringify(pos)); } catch (e) { /* ignore */ } };

  function layout() {
    const panel = panelEl();
    const ov = S.overlay;
    if (!panel || !ov) return;
    const pr = panel.getBoundingClientRect();
    let bottom = 96;
    const top = toolbarTop(panel, pr);
    if (top != null) bottom = Math.round(pr.bottom - top + 10);
    bottom = Math.max(56, Math.min(bottom, Math.round(pr.height * 0.55)));
    const scale = { s: 0.85, m: 1, l: 1.3 }[prefs().size] || 1;
    const fs = Math.max(16, Math.min(34, pr.width / 30)) * scale;
    ov.style.setProperty('--cc-bottom', bottom + 'px');
    ov.style.setProperty('--cc-top', Math.round(Math.max(56, Math.min(96, pr.height * 0.12))) + 'px');
    ov.style.setProperty('--cc-fs', fs.toFixed(1) + 'px');
    ov.dataset.size = prefs().size;
    ov.dataset.edge = pos.edge;
    // keep a dragged caption inside the call, also after the window was resized
    const lines = ov.querySelector('.cc-lines');
    const lr = lines ? lines.getBoundingClientRect() : null;
    if (lr && lr.width && (pos.dx || pos.dy)) {
      // where the captions would be with no offset at all = where they are now, minus the offset that is applied right now
      const baseLeft = lr.left - applied.dx, baseTop = lr.top - applied.dy;
      pos.dx = Math.max(pr.left + 8 - baseLeft, Math.min(pr.right - 8 - lr.width - baseLeft, pos.dx));
      pos.dy = Math.max(pr.top + 8 - baseTop, Math.min(pr.bottom - 8 - lr.height - baseTop, pos.dy));
    }
    applied.dx = Math.round(pos.dx); applied.dy = Math.round(pos.dy);
    ov.style.setProperty('--cc-dx', applied.dx + 'px');
    ov.style.setProperty('--cc-dy', applied.dy + 'px');
  }
  const applied = { dx: 0, dy: 0 };                         // the offset currently on screen (see layout)

  /** Drag the captions with the mouse; double-click puts them back. */
  function enableDrag(ov) {
    let start = null;
    ov.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !e.target.closest('.cc-lines')) return;
      start = { x: e.clientX, y: e.clientY, dx: pos.dx, dy: pos.dy };
      ov.setPointerCapture(e.pointerId);
      ov.dataset.dragging = '1';
    });
    ov.addEventListener('pointermove', (e) => {
      if (!start) return;
      pos.dx = start.dx + (e.clientX - start.x);
      pos.dy = start.dy + (e.clientY - start.y);
      layout();
    });
    const end = () => { if (!start) return; start = null; delete ov.dataset.dragging; savePos(); };
    ov.addEventListener('pointerup', end);
    ov.addEventListener('pointercancel', end);
    // (the call panel itself goes full screen on a double-click: that must not happen when this one is meant)
    ov.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      const under = document.elementFromPoint(e.clientX, e.clientY);                  // (while pointer capture is on, e.target is the overlay itself)
      if (under && under.closest('.cc-lines')) { pos.dx = pos.dy = 0; savePos(); layout(); }
    });
  }

  function wordSpans(text) {
    const parts = /\s/.test(text) || text.length < 14 ? text.match(/\S+\s*/g) : text.match(/[\s\S]{1,3}/gu);      // spaced languages by word, Chinese / Japanese / Thai by 3 characters
    return (parts || [text]).map((w, i) => el('span', { class: 'cc-w', text: w, attrs: { style: '--i:' + Math.min(i, 18) } }));
  }

  function showCaption(r) {
    const panel = panelEl();
    if (!panel || !S.on) return;
    const ov = ensureOverlay(panel);
    const box = ov.querySelector('.cc-lines');
    const p = prefs();
    const line = el('p', { class: 'cc-line', attrs: { dir: 'auto' } }, ...wordSpans(r.text));
    if (p.original && r.translated && r.original) line.append(el('span', { class: 'cc-orig', text: r.original, attrs: { dir: 'auto' } }));
    box.append(line);
    const chars = r.text.length;
    S.lines.push({ node: line, until: Date.now() + Math.max(2800, Math.min(8500, 1800 + chars * 62)) });
    while (S.lines.length > 2) retire(S.lines.shift());
    S.lines.forEach((l, i) => { l.node.dataset.old = i < S.lines.length - 1 ? '1' : ''; });
    S.lastLang = r.lang || S.lastLang;
    S.lastCaptionAt = Date.now();
    S.target = r.target;
    setStatus('');
    paintMeta();
  }

  function retire(l) {
    if (!l) return;
    l.node.dataset.out = '1';
    setTimeout(() => l.node.remove(), 320);
  }

  setInterval(() => {
    const now = Date.now();
    while (S.lines.length && S.lines[0].until < now) retire(S.lines.shift());
    if (S.overlay) S.overlay.dataset.idle = S.on && now - S.lastCaptionAt > 6000 && !S.speaking ? '1' : '';
  }, 250);

  function setStatus(text, pct) {
    S.status = text || '';
    S.pct = typeof pct === 'number' ? pct : -1;
    paintMeta();
    updateButton();
  }

  function paintMeta() {
    const ov = S.overlay;
    if (!ov) return;
    const chip = ov.querySelector('.cc-chip');
    const p = prefs();
    let label;
    if (S.status) label = S.status;
    else if (S.lastLang && S.lastLang !== p.lang.split('-')[0] && S.lastCaptionAt) label = langName(S.lastLang) + ' → ' + langName(p.lang);
    else label = S.lastCaptionAt ? langName(p.lang) : 'Listening…';
    chip.textContent = label === S.status || label === 'Listening…' ? R.t(label) : label;
    chip.dataset.speaking = S.speaking ? '1' : '';
    chip.dataset.busy = S.status ? '1' : '';
    ov.dataset.rtl = RTL.test(p.lang) ? '1' : '';
  }

  // ---------------------------------------------------------------------------
  // Settings popover (language, size, original, quality)
  // ---------------------------------------------------------------------------
  const fail = (err) => R.toast(err && err.message ? err.message : 'Something went wrong');
  const set = (name, value) => R.call('caption-set', name, value).catch(fail);

  function seg(label, options, current, onPick) {
    return el('div', { class: 'cc-row' },
      el('span', { class: 'cc-lbl', text: label }),
      el('div', { class: 'relay-seg cc-seg', attrs: { role: 'group', 'aria-label': label } },
        ...options.map((o) => el('button', {
          type: 'button', class: 'relay-seg-b', text: o.text, attrs: { 'aria-pressed': String(o.value === current) },
          on: { click: () => onPick(o.value) }
        }))));
  }

  function renderPopover() {
    const pop = S.popover;
    if (!pop) return;
    const p = prefs();
    const targets = (p.targets || ['en']).slice().sort((a, b) => (a === 'en' ? -1 : b === 'en' ? 1 : langName(a).localeCompare(langName(b))));
    const select = el('select', { class: 'cc-select', attrs: { 'aria-label': 'Translate captions to' },
      on: { change: (e) => set('lang', e.target.value) } },
      ...targets.map((c) => el('option', { value: c, text: langName(c), selected: c === p.lang })));
    // "Automatic" listens and decides; naming the language is more accurate (Hindi and Urdu, or Chinese, are easily mixed up).
    const fromSelect = el('select', { class: 'cc-select', attrs: { 'aria-label': 'Spoken language' },
      on: { change: (e) => set('from', e.target.value) } },
      el('option', { value: 'auto', text: R.t('Automatic'), selected: (p.from || 'auto') === 'auto' }),
      ...targets.map((c) => el('option', { value: c, text: langName(c), selected: c === p.from })));
    const sw = el('button', { class: 'relay-sw', type: 'button', attrs: { role: 'switch', 'aria-checked': String(p.original), 'aria-label': 'Show the original words too' },
      on: { click: () => set('original', !p.original) } }, el('span', { class: 'relay-sw-knob' }));
    const models = p.models || {};
    pop.replaceChildren(
      el('div', { class: 'cc-row' }, el('span', { class: 'cc-lbl', text: 'Spoken language' }), fromSelect),
      el('div', { class: 'cc-row' }, el('span', { class: 'cc-lbl', text: 'Translate to' }), select),
      seg('Text size', [{ text: 'S', value: 's' }, { text: 'M', value: 'm' }, { text: 'L', value: 'l' }], p.size, (v) => set('size', v)),
      seg('Position', [{ text: 'Bottom', value: 'bottom' }, { text: 'Top', value: 'top' }], pos.edge, (v) => { pos.edge = v; pos.dx = pos.dy = 0; savePos(); layout(); renderPopover(); }),
      el('div', { class: 'cc-row' }, el('span', { class: 'cc-lbl', text: 'Show original words' }), sw),
      seg('Accuracy', Object.keys(models).map((id) => ({ text: models[id].label, value: id })), p.model, (v) => {
        set('model', v).then(() => { if (S.on) restart(); });
      }),
      el('div', { class: 'cc-hint', text: 'Drag the captions anywhere on the call; double-click to put them back.' }),
      el('div', { class: 'cc-hint', text: (models.accurate && !models.accurate.ready && p.model !== 'accurate') ? 'Accurate downloads ' + models.accurate.mb + ' MB once and needs a fast graphics card.' : 'Speech is turned into text on this PC.' }));
  }

  function togglePopover() {
    if (S.popover) return closePopover();
    const ov = S.overlay;
    if (!ov) return;
    S.popover = el('div', { class: 'cc-pop', attrs: { role: 'dialog', 'aria-label': 'Caption settings' } });
    ov.append(S.popover);
    renderPopover();
  }
  function closePopover() { if (S.popover) { S.popover.remove(); S.popover = null; } }
  document.addEventListener('pointerdown', (e) => { if (S.popover && !S.popover.contains(e.target) && !(S.overlay && S.overlay.contains(e.target))) closePopover(); }, true);
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.popover) closePopover(); });

  // ---------------------------------------------------------------------------
  // On / off
  // ---------------------------------------------------------------------------
  async function turnOn() {
    if (S.on || S.starting) return;
    const panel = panelEl();
    if (!panel) return;
    S.starting = true;
    ensureOverlay(panel);
    setStatus('Starting captions…');
    let res;
    try { res = await R.call('caption-start'); } catch (err) { res = { ok: false, message: err && err.message }; }
    if (!res || !res.ok) {
      S.starting = false;
      if (res && res.reason !== 'declined') R.toast((res && res.message) || 'Captions could not start');
      cleanupUi();
      return;
    }
    try {
      await openCapture();
    } catch (err) {
      S.starting = false;
      closeCapture();
      R.call('caption-stop').catch(() => {});
      R.toast('Captions could not listen to this call');
      cleanupUi();
      return;
    }
    S.starting = false;
    S.on = true;
    S.seq = 0; S.nextShow = 1; S.ready.clear(); S.inFlight = 0; S.lastCaptionAt = 0; S.lastLang = '';
    setStatus('');
    paintMeta();
  }

  function cleanupUi() {
    S.status = ''; S.pct = -1; S.speaking = false;
    closePopover();
    S.lines.splice(0).forEach((l) => l.node.remove());
    if (S.overlay) { S.overlay.remove(); S.overlay = null; }
    updateButton();
  }

  function turnOff() {
    const wasOn = S.on || S.starting;
    S.on = false;
    S.starting = false;
    closeCapture();
    cleanupUi();
    if (wasOn) R.call('caption-stop').catch(() => {});
  }

  async function restart() { turnOff(); await new Promise((r) => setTimeout(r, 150)); turnOn(); }

  // ---------------------------------------------------------------------------
  // Toolbar button (cloned from "More options" so it matches the toolbar)
  // ---------------------------------------------------------------------------
  function ensureButton(panel) {
    if (panel.querySelector('[data-relay-cc]')) return;
    const more = [...panel.querySelectorAll('button[aria-label]')].find((b) => /^more options$/i.test(b.getAttribute('aria-label')));
    if (!more) return;
    let wrapper = more;
    while (wrapper.parentElement && wrapper.parentElement.children.length === 1) wrapper = wrapper.parentElement;
    if (!wrapper.parentElement) return;
    const clone = wrapper.cloneNode(true);
    clone.dataset.relayCc = '';
    const btn = clone.querySelector('button');
    btn.removeAttribute('aria-expanded');
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (S.on || S.starting) turnOff(); else turnOn();
    });
    btn.addEventListener('pointerdown', (e) => e.stopPropagation());
    wrapper.parentElement.insertBefore(clone, wrapper);
    const path = btn.querySelector('svg path');
    if (path) path.setAttribute('d', CC_ICON);
    updateButton();
  }

  function updateButton() {
    const btn = document.querySelector('[data-relay-cc] button');
    if (!btn) return;
    const label = S.starting ? 'Starting captions…' : S.on ? 'Turn off captions' : 'Turn on captions';
    btn.setAttribute('aria-label', label);
    btn.setAttribute('aria-pressed', String(S.on));
    btn.title = label + ' (C)';
    const svg = btn.querySelector('svg');
    if (svg) {
      svg.style.color = S.on ? 'var(--relay-accent-strong, #7fb2ff)' : '';
      const title = svg.querySelector('title');
      if (title) title.textContent = S.on ? 'captions-on' : 'captions-off';
    }
  }

  // ---------------------------------------------------------------------------
  // Housekeeping
  // ---------------------------------------------------------------------------
  R.on('caption-status', (m) => {
    if (!m) return;
    if (m.phase === 'download') setStatus('Downloading speech model ' + Math.round((m.pct || 0) * 100) + '%', m.pct);
    else if (m.phase === 'loading') setStatus('Loading speech model…');
    else if (m.phase === 'ready') setStatus('');
    else if (m.phase === 'slow') toastOnce('Captions are falling behind. Try Accuracy: Fast in the caption settings (tap the caption label).');
    else if (m.phase === 'error' && m.message && S.on) { R.toast(m.message); turnOff(); }       // (while starting, caption-start's own reply shows it)
  });

  R.subscribe(() => {
    layout(); paintMeta(); if (S.popover) renderPopover();
    if (S.on && prefs().active === false) turnOff();                          // the main process ended the session
  });
  document.addEventListener('fullscreenchange', () => setTimeout(layout, 120));
  addEventListener('resize', () => layout());

  setInterval(() => {
    const panel = panelEl();
    if (panel) ensureButton(panel);
    if (S.on && !panel) { if (++S.missing >= 3) { S.missing = 0; turnOff(); } return; }
    S.missing = 0;
    if (panel && (S.on || S.starting)) { ensureOverlay(panel); layout(); }
    if (S.on && S.ctx && S.ctx.state === 'suspended') S.ctx.resume().catch(() => {});
    drain();
  }, 600);

  R.captions = { turnOn, turnOff, get on() { return S.on; }, makeSegmenter, WORKLET, _state: S };
})();
