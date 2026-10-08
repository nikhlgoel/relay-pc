/* Relay panel - live voice translation during a call (page side; main-process half: src/voice.js).

   A small round button on the left edge of the call (or press T) turns it on and off. While it is on:
     - the other person's speech is cut into sentences (the same listener captions use), translated, and spoken in a copy of
       THEIR voice, while the original is turned down;
     - your microphone is cut into sentences, translated, and spoken in a copy of YOUR voice into the call; the other person
       first hears a spoken notice that the call is translated automatically.
   Safety rules in this file: the other person is never left in silence (your own voice keeps going until a translation is
   certain, and returns the moment translation stops working), and translated sound is never listened to again by the listener. */
(() => {
  'use strict';
  const R = window.__relay;
  if (!R || R.voice) return;
  const { el, icon } = R;

  const V = {
    on: false, starting: false, status: '', btn: null,
    cap: { in: null, out: null },
    seq: { in: 0, out: 0 }, flight: { in: 0, out: 0 },
    ordered: { in: null, out: null },
    pctx: null, inNext: 0, inUntil: 0, duckTimer: 0,
    translatingOut: false, failures: 0
  };

  const panelEl = () => document.querySelector('[data-testid="move_resize_component"]');
  const state = () => (R.state && R.state.voice) || null;
  const callActive = () => { const p = panelEl(); return Boolean(p && p.querySelector('button[aria-label*="End call" i]')); };

  // ---------------------------------------------------------------------------
  // Listening (the other person through the call tap, you through the microphone)
  // ---------------------------------------------------------------------------
  async function openCapture(kind) {
    const C = R.captions;
    if (!C || !C.makeSegmenter) throw new Error('The caption listener is missing');
    const ctx = new AudioContext({ sampleRate: 16000, latencyHint: 'playback' });
    try {
      const url = URL.createObjectURL(new Blob([C.WORKLET], { type: 'text/javascript' }));
      try { await ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
      const node = new AudioWorkletNode(ctx, 'relay-cc', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });
      const mute = ctx.createGain();
      mute.gain.value = 0;
      const sink = ctx.createMediaStreamDestination();
      sink.__relayTap = true;
      node.__relayOwn = mute.__relayOwn = true;
      node.connect(mute);
      mute.connect(sink);
      const cap = { ctx, node, tap: null, src: null };
      V.cap[kind] = cap;
      cap.segmenter = C.makeSegmenter((pcm) => submit(kind, pcm), () => {});
      node.port.onmessage = (e) => { if (V.on) cap.segmenter.push(e.data); };
      window.__relayBuildingAudio = true;
      try {
        if (kind === 'in') {
          if (!window.__relayTap) throw new Error('no audio tap');
          cap.tap = window.__relayTap.start((d) => {
            const s = ctx.createMediaStreamSource(d.stream);
            s.__relayOwn = true;
            s.connect(node);
          });
        } else {
          // your voice as it leaves the microphone chain, before the gate that mutes it while a translation is being sent
          const vo = window.__relayVoiceOut;
          const mic = vo && vo.raw ? vo.raw : window.__relayMicTrack;
          if (!mic || mic.readyState !== 'live') throw new Error('no microphone');
          cap.src = ctx.createMediaStreamSource(new MediaStream([mic]));
          cap.src.__relayOwn = true;
          cap.src.connect(node);
        }
      } finally { window.__relayBuildingAudio = false; }
      if (ctx.state === 'suspended') await ctx.resume();
      if (!V.on) closeCapture(kind);                       // switched off while it was starting
    } catch (err) {
      closeCapture(kind);
      throw err;
    }
  }

  function closeCapture(kind) {
    const cap = V.cap[kind];
    if (!cap) return;
    try { cap.segmenter.flush(); } catch (e) { /* ignore */ }
    if (cap.tap && window.__relayTap) { try { window.__relayTap.stop(cap.tap); } catch (e) { /* ignore */ } }
    try { cap.node.port.onmessage = null; cap.node.disconnect(); } catch (e) { /* ignore */ }
    try { if (cap.src) cap.src.disconnect(); } catch (e) { /* ignore */ }
    try { cap.ctx.close(); } catch (e) { /* ignore */ }
    V.cap[kind] = null;
  }

  // ---------------------------------------------------------------------------
  // Clips -> main process -> translated speech, played in order
  // ---------------------------------------------------------------------------
  function makeOrdered(play) {
    const ready = new Map();
    let next = 1, stuckSince = 0;
    const drain = () => {
      while (ready.has(next)) { const r = ready.get(next); ready.delete(next); next++; stuckSince = 0; if (r) { try { play(r); } catch (e) { /* skip a bad one */ } } }
      if (ready.size) {
        if (!stuckSince) stuckSince = Date.now();
        else if (Date.now() - stuckSince > 8000) { next = Math.min(...ready.keys()); stuckSince = 0; drain(); }
      }
    };
    return { put(seq, r) { ready.set(seq, r); drain(); }, reset() { ready.clear(); next = 1; stuckSince = 0; } };
  }

  function submit(kind, pcm) {
    if (!V.on) return;
    const st = state();
    if (!st || (kind === 'in' && st.in === false) || (kind === 'out' && st.out === false)) return;
    if (kind === 'out' && Date.now() < V.inUntil) return;          // you are hearing a translation: that is not you speaking
    const ordered = V.ordered[kind];                        // a reply for an earlier switch-on must be thrown away, not played
    const seq = ++V.seq[kind];
    if (V.flight[kind] >= 2) { ordered.put(seq, null); return; }
    V.flight[kind]++;
    R.call('voice-clip', kind, pcm, { seq })
      .then((res) => {
        if (!V.on || V.ordered[kind] !== ordered) return;
        if (res && res.pcm) { V.failures = 0; V.ordered[kind].put(seq, { ...res, kind }); }
        else {
          V.ordered[kind].put(seq, null);
          // Nothing was made of what you said (their language, no voice for it, nothing to say): the other person must still hear YOU.
          if (kind === 'out' && res && ['same-language', 'cannot-speak', 'unknown-language', 'empty', 'no-notice'].includes(res.skipped)) sendOwnVoice();
          if (kind === 'out' && res && res.skipped === 'cannot-speak' && !V.toldCannot) {
            V.toldCannot = true;
            R.toast('Your voice can only be translated into English, Hindi, Chinese, Russian or Spanish');
          }
        }
      })
      .catch((err) => { if (V.on && V.ordered[kind] === ordered) { ordered.put(seq, null); noteFailure(); } })
      .finally(() => { if (V.ordered[kind] === ordered) V.flight[kind]--; });
  }

  function noteFailure() {
    if (++V.failures === 3) {
      sendOwnVoice();
      R.toast('Translation is not keeping up - your own voice is being sent');
    }
    if (V.failures > 12 && V.on) turnOff();
  }

  // ---------------------------------------------------------------------------
  // Playing the translation
  // ---------------------------------------------------------------------------
  const f32 = (b) => (b instanceof Float32Array ? b : new Float32Array(b.buffer ? b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) : b));

  function playIn(res) {
    const st = state();
    if (!V.pctx) V.pctx = new AudioContext({ latencyHint: 'interactive' });
    const ctx = V.pctx;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const pcm = f32(res.pcm);
    const buf = ctx.createBuffer(1, pcm.length, res.rate || 24000);
    buf.copyToChannel(pcm, 0);
    const s = ctx.createBufferSource();
    const g = ctx.createGain();
    s.__relayOwn = g.__relayOwn = true;                  // not call audio: never recorded, never captioned, never turned down
    s.buffer = buf;
    g.gain.value = 1.15;
    s.connect(g);
    g.connect(ctx.destination);
    const at = Math.max(ctx.currentTime + 0.03, V.inNext);
    s.start(at);
    V.inNext = at + buf.duration;
    V.inUntil = Date.now() + (V.inNext - ctx.currentTime) * 1000 + 500;
    if (window.__relayDuck) window.__relayDuck.set(st && typeof st.duck === 'number' ? st.duck : 0.15);
    clearTimeout(V.duckTimer);
    V.duckTimer = setTimeout(function release() {
      if (V.pctx && V.pctx.currentTime < V.inNext - 0.05) { V.duckTimer = setTimeout(release, 200); return; }
      if (window.__relayDuck) window.__relayDuck.set(1, 0.3);
    }, Math.max(200, (V.inNext - ctx.currentTime) * 1000 + 250));
    paint();
  }

  function playOut(res) {
    const out = window.__relayVoiceOut;
    if (!out) return;
    if (res.notice && res.notice.pcm) out.play(f32(res.notice.pcm), res.notice.rate || 24000);
    out.play(f32(res.pcm), res.rate || 24000);
    if (!V.translatingOut) { V.translatingOut = true; out.passthrough(false); }        // a translation is certain now: stop sending the original
    paint();
  }

  function sendOwnVoice() {
    V.translatingOut = false;
    const out = window.__relayVoiceOut;
    if (out) out.passthrough(true);
  }

  // ---------------------------------------------------------------------------
  // The button on the call
  // ---------------------------------------------------------------------------
  function ensureButton(panel) {
    if (V.btn && V.btn.isConnected && V.btn.parentElement === panel) return V.btn;
    if (V.btn) V.btn.remove();
    if (getComputedStyle(panel).position === 'static') panel.style.position = 'relative';
    V.btn = el('button', {
      id: 'relay-vx', type: 'button', attrs: { 'aria-pressed': 'false', 'aria-label': 'Live voice translation' },
      on: {
        pointerdown: (e) => e.stopPropagation(),             // never start dragging WhatsApp's call window
        click: (e) => { e.stopPropagation(); toggle(); }
      }
    }, icon('translate', 22), el('span', { class: 'vx-dot' }));
    panel.append(V.btn);
    paint();
    return V.btn;
  }

  function paint() {
    const b = V.btn;
    if (!b) return;
    const st = V.starting ? 'loading' : V.status === 'error' ? 'error' : V.on ? 'on' : 'off';
    b.dataset.state = st;
    b.setAttribute('aria-pressed', String(V.on));
    const their = state() && state().their;
    b.title = R.t(V.on
      ? 'Live translation is on' + (their ? ' (' + their + ')' : '') + ' - click to turn off (T)'
      : V.starting ? 'Starting live translation...' : 'Translate this call out loud (T)');
    b.dataset.speaking = V.pctx && V.pctx.currentTime < V.inNext ? '1' : '';
  }

  function scan() {
    const panel = panelEl();
    if (panel && callActive() && state()) ensureButton(panel);
    else {
      if (V.btn) { V.btn.remove(); V.btn = null; }
      if (V.on) turnOff();                                        // the call is over
    }
  }

  // ---------------------------------------------------------------------------
  // On / off
  // ---------------------------------------------------------------------------
  async function turnOn() {
    if (V.on || V.starting) return;
    const panel = panelEl();
    if (!panel || !callActive()) { R.toast('Start a call first'); return; }
    const st = state();
    if (!st) return;
    V.starting = true;
    V.status = '';
    paint();
    try {
      const r = await R.call('voice-start');
      if (!r || !r.ok) { V.status = r && r.reason === 'declined' ? '' : 'error'; if (r && r.message) R.toast(r.message); return; }
      V.ordered.in = makeOrdered(playIn);
      V.ordered.out = makeOrdered(playOut);
      V.seq.in = V.seq.out = 0;
      V.flight.in = V.flight.out = 0;
      V.failures = 0;
      V.toldCannot = false;
      V.on = true;
      const noMicChain = st.out !== false && !window.__relayVoiceOut;
      const results = await Promise.allSettled([
        st.in !== false ? openCapture('in') : Promise.resolve(),
        st.out !== false && !noMicChain ? openCapture('out') : Promise.resolve()
      ]);
      if (results.some((x) => x.status === 'rejected')) {
        R.toast('Live translation could not listen to this call');
        await turnOff();
        V.status = 'error';
        return;
      }
      if (noMicChain) R.toast('Your own voice is not translated: turn on "Voice clarity" in the Relay panel first');
      else R.toast('Live translation is on - the other person hears a short notice before your first sentence');
    } catch (err) {
      V.status = 'error';
      R.toast('Live translation could not start');
    } finally {
      V.starting = false;
      paint();
    }
  }

  async function turnOff() {
    V.on = false;
    closeCapture('in');
    closeCapture('out');
    sendOwnVoice();
    if (window.__relayVoiceOut) window.__relayVoiceOut.clear();
    if (window.__relayDuck) window.__relayDuck.set(1, 0.2);
    if (V.pctx) { try { V.pctx.close(); } catch (e) { /* ignore */ } V.pctx = null; }
    V.inNext = V.inUntil = 0;
    clearTimeout(V.duckTimer);
    if (V.ordered.in) V.ordered.in.reset();
    if (V.ordered.out) V.ordered.out.reset();
    try { await R.call('voice-stop'); } catch (e) { /* ignore */ }
    paint();
  }

  const toggle = () => (V.on ? turnOff() : turnOn());

  addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.repeat || e.isComposing) return;
    const letter = /^[a-z]$/i.test(e.key) ? e.key : String(e.code || '').replace(/^Key/, '');
    if (letter.toLowerCase() !== 't') return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (!callActive()) return;
    e.preventDefault();
    e.stopPropagation();
    toggle();
  }, true);

  R.on('voice-status', (m) => {
    if (!m) return;
    if (m.phase === 'download') {
      const what = { speech: 'speech', mt: 'translator', voice: 'voice' }[m.what] || 'models';
      R.toast('Downloading the ' + what + ' model ' + Math.round((m.pct || 0) * 100) + '%');
    } else if (m.phase === 'loading') R.toast('Loading live translation...');
    else if (m.phase === 'error') { V.status = 'error'; if (m.message) R.toast(m.message); paint(); }
    else if (m.phase === 'voice-copied') paint();
  });

  setInterval(scan, 1000);
  R.subscribe(() => paint());
  R.voice = { turnOn, turnOff, get on() { return V.on; }, _state: V };
})();
