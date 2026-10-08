/* Relay panel - a sharper, steadier picture from the people you call (page side).
   The other person's video reaches WhatsApp at whatever size their phone and network allow (often 320-640 px wide)
   and WhatsApp stretches it to fill your window, which is the soft look. Two things help without touching the call itself:
     1. the stretched picture gets a light sharpening filter at your screen's resolution (an SVG filter on the
        call's own canvas or video, so nothing is copied and nothing about the layout changes);
     2. the video receiver keeps a short (120 ms) buffer, which evens out the stutter of an uneven connection.
   Only pictures that are really being enlarged are touched; your own preview and small tiles are left alone.
   Relay panel > "Sharper video" switches it off. */
(() => {
  'use strict';
  const R = window.__relay;
  if (!R || R.video) return;

  const SVG = 'http://www.w3.org/2000/svg';
  const FILTER_ID = 'relay-sharp-video';
  const STRENGTH = 0.55;                // 0 = off; 0.55 is clear without halos on faces
  const MIN_SCALE = 1.15;               // only pictures shown at least this much larger than they were sent

  let on = true;
  let timer = 0;
  const applied = new WeakSet();

  function ensureFilter() {
    if (document.getElementById(FILTER_ID + '-svg')) return;
    const k = STRENGTH;
    const svg = document.createElementNS(SVG, 'svg');
    svg.id = FILTER_ID + '-svg';
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.setAttribute('aria-hidden', 'true');
    svg.style.cssText = 'position:absolute;width:0;height:0;pointer-events:none';
    svg.innerHTML =
      '<filter id="' + FILTER_ID + '" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">' +
      '<feConvolveMatrix order="3" preserveAlpha="true" divisor="1" edgeMode="duplicate" ' +
      'kernelMatrix="0 ' + -k + ' 0 ' + -k + ' ' + (1 + 4 * k) + ' ' + -k + ' 0 ' + -k + ' 0"/>' +
      '</filter>';
    (document.body || document.documentElement).append(svg);
  }

  /** The size a picture was sent at, or 0 if the element is not a picture. */
  function sourceSize(e) {
    if (e instanceof HTMLCanvasElement) return { w: e.width, h: e.height };
    if (e instanceof HTMLVideoElement) return { w: e.videoWidth, h: e.videoHeight };
    return { w: 0, h: 0 };
  }

  function wanted(e) {
    const { w, h } = sourceSize(e);
    if (w < 100 || h < 56) return false;                      // level meters, icons
    const r = e.getBoundingClientRect();
    if (r.width < 160 || r.height < 90) return false;          // thumbnails: nothing to gain
    return r.width / w >= MIN_SCALE || r.height / h >= MIN_SCALE;
  }

  function scan() {
    const panel = document.querySelector('[data-testid="move_resize_component"]');
    const pictures = panel && on ? [...panel.querySelectorAll('canvas, video')] : [];
    const keep = new Set();
    let n = 0;
    for (const e of pictures) {
      if (!wanted(e)) continue;
      keep.add(e);
      if (++n > 6) break;                                       // a big group call: the largest tiles are enough
      if (!applied.has(e)) {
        ensureFilter();
        e.dataset.relaySharp = '1';
        e.style.setProperty('filter', 'url(#' + FILTER_ID + ')', 'important');
        applied.add(e);
      }
    }
    for (const e of document.querySelectorAll('[data-relay-sharp]')) {
      if (keep.has(e)) continue;
      e.style.removeProperty('filter');
      delete e.dataset.relaySharp;
      applied.delete(e);
    }
    return n;
  }

  function loop() {
    scan();
    timer = setTimeout(loop, document.hidden ? 4000 : 1000);
  }

  // ---- a short, steady buffer for incoming video --------------------------------------------
  // Every RTCPeerConnection WhatsApp opens gets a 'track' listener; the behaviour of the connection is untouched.
  function patchPeerConnection() {
    const Orig = window.RTCPeerConnection;
    if (!Orig || Orig.__relayVideo) return;
    class RelayPeerConnection extends Orig {
      constructor(...args) {
        super(...args);
        try {
          this.addEventListener('track', (ev) => {
            try {
              if (on && ev.track && ev.track.kind === 'video' && ev.receiver && 'jitterBufferTarget' in ev.receiver) {
                ev.receiver.jitterBufferTarget = 120;
              }
            } catch (e) { /* an older engine: no buffer hint, nothing lost */ }
          });
        } catch (e) { /* never let a hook break a call */ }
      }
    }
    Object.defineProperty(RelayPeerConnection, 'name', { value: 'RTCPeerConnection' });
    Object.defineProperty(RelayPeerConnection, '__relayVideo', { value: true });
    window.RTCPeerConnection = RelayPeerConnection;
    if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = RelayPeerConnection;
  }
  try { patchPeerConnection(); } catch (e) { /* leave WebRTC as it is */ }

  R.subscribe((s) => {
    const next = !s || s.sharpVideo !== false;
    if (next === on && timer) return;
    on = next;
    if (!timer) loop(); else scan();
  });
  if (!timer) loop();

  R.video = { scan, FILTER_ID };
})();
