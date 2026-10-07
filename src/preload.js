'use strict';

const { ipcRenderer, webFrame } = require('electron');

// ===========================================================================
// Unread badge.
// WhatsApp Web puts the count in the document title as "(3) WhatsApp".
// ===========================================================================
let lastCount = -1;

function report(n) {
  if (n === lastCount) return;
  lastCount = n;
  ipcRenderer.send('unread-count', n);
}

function countFromTitle() {
  const m = /\((\d+)\)/.exec(document.title || '');
  report(m ? parseInt(m[1], 10) : 0);
}

function watchBadge() {
  countFromTitle();

  const titleEl = document.querySelector('title');
  if (titleEl) {
    new MutationObserver(countFromTitle)
      .observe(titleEl, { childList: true, subtree: true });
  }
  // Catch the case where <title> is replaced wholesale.
  new MutationObserver(countFromTitle)
    .observe(document.head || document.documentElement, { childList: true });

}

// ===========================================================================
// Clicking a native notification or service-worker message should bring the
// window forward to the front of the screen.
// ===========================================================================
function hookNotifications() {
  // Events dispatched from the page's own world are visible here.
  window.addEventListener('wa-new-notification', () => {
    ipcRenderer.send('flash-window');
  });

  window.addEventListener('wa-activate-window', () => {
    ipcRenderer.send('activate-window');
  });

  // Hook window.Notification and window.focus in WhatsApp's own JavaScript
  // world. This used to append an inline <script>, which WhatsApp's CSP blocks
  // (nonce-only script-src), so none of it ever ran: clicking a toast while the
  // app sat in the tray did nothing. webFrame.executeJavaScript is exempt.
  //
  // Deliberately NOT hooked: serviceWorker 'message'. The worker posts messages
  // for reasons other than notification clicks, and each one would have pulled
  // the window to the front.
  const pageWorld = () => {
    if (window.__waNotificationHook) return;
    window.__waNotificationHook = true;

    function notifyActivation() {
      window.dispatchEvent(new CustomEvent('wa-activate-window'));
    }

    // WhatsApp calls window.focus() from its notification click handler.
    const origFocus = window.focus;
    window.focus = function () {
      notifyActivation();
      return origFocus.apply(this, arguments);
    };

    const NativeNotification = window.Notification;
    if (NativeNotification) {
      function AppNotification(title, options) {
        const n = new NativeNotification(title, options);
        window.dispatchEvent(new CustomEvent('wa-new-notification'));
        n.addEventListener('click', notifyActivation);
        return n;
      }
      AppNotification.prototype = NativeNotification.prototype;
      // permission is a live static getter on the native class; the prototype
      // chain keeps it live instead of freezing a copy at hook time.
      Object.setPrototypeOf(AppNotification, NativeNotification);
      window.Notification = AppNotification;
    }
  };

  try {
    webFrame.executeJavaScript(`(${pageWorld.toString()})();`);
  } catch (err) {
    console.warn('[Notifications] hook injection failed:', err);
  }
}

// ===========================================================================
// Desktop-app cleanup.
//
// We *are* the desktop app, so anything that only makes sense in a browser tab
// is hidden: the "Get WhatsApp for Windows" banner, the "Stay logged in on this
// browser" option (the session is always kept) and the "Get started" sign-up
// line. Class names are generated and change constantly, so each rule matches
// visible text and hides a structurally chosen ancestor. Anything inside a chat
// row or the conversation is left alone, so a message that happens to contain
// the same words is never touched.
// ===========================================================================
const PROMO_LINK =
  'a[href*="whatsapp.com/download"], a[href*="/download/"], a[download]';
const CHAT_CONTENT = '[role="row"], [role="listitem"], [role="article"], #main';
const MAX_BANNER_HEIGHT = 200;

/** First ancestor of `el` (within a few levels) for which `test` holds. */
function ancestorWhere(el, test) {
  let node = el.parentElement;
  for (let i = 0; node && i < 6; i++, node = node.parentElement) {
    if (test(node)) return node;
  }
  return null;
}

/** Climb to the outermost ancestor that is still banner-sized. */
function bannerRoot(el) {
  let node = el;
  while (node.parentElement) {
    const parent = node.parentElement;
    if (parent === document.body || parent.id === 'app' || parent.id === 'pane-side') break;
    if (parent.getBoundingClientRect().height > MAX_BANNER_HEIGHT) break;
    node = parent;
  }
  return node;
}

const DESKTOP_RULES = [
  { text: /^(get|download) whatsapp for (windows|mac|desktop)\b/i, target: bannerRoot },
  // Smallest container that holds both the label and its checkbox.
  { text: /^stay logged in on this browser/i,
    target: (el) => ancestorWhere(el, (a) => a.querySelector('input[type="checkbox"]')) },
  // The row holding "Don't have a WhatsApp account? Get started".
  { text: /^don.t have a whatsapp account\?/i,
    target: (el) => ancestorWhere(el, (a) => /get started/i.test(a.textContent)) }
];

function hideElement(el) {
  if (!el || el.closest(CHAT_CONTENT)) return;
  if (el === document.body || el.id === 'pane-side' || el.id === 'app') return;
  el.dataset.waHidden = '';
}

/** Hide every browser-only element inside `root` (which may itself be one). */
function stripBrowserOnly(root) {
  root = root || document;

  if (root.matches && root.matches(PROMO_LINK)) hideElement(bannerRoot(root));
  if (!root.querySelectorAll) return;
  for (const link of root.querySelectorAll(PROMO_LINK)) hideElement(bannerRoot(link));

  // Leaf elements only, and the length check keeps the regexes off long text.
  for (const el of root.querySelectorAll('span, div, label, button')) {
    if (el.childElementCount !== 0) continue;
    const text = el.textContent.trim();
    if (!text || text.length > 60) continue;
    for (const rule of DESKTOP_RULES) {
      if (rule.text.test(text)) hideElement(rule.target(el));
    }
  }
}

/**
 * Switching chats remounts the sidebar and the login screen renders late, which
 * re-inserts these elements. Hide each one the moment it is added:
 * MutationObserver callbacks run before the browser paints, so nothing flashes.
 * Message nodes are by far the most common mutation and never hold these, so
 * skipping them keeps this cheap on a busy conversation.
 */
function watchForBrowserOnly() {
  stripBrowserOnly();
  new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.closest && node.closest(CHAT_CONTENT)) continue;
        stripBrowserOnly(node);
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
}

// ===========================================================================
// Layout: resizable sidebar, header insets, window dragging.
//
// WhatsApp Web lays the app out as one flex row - rail | chat list | chat - and
// pins the chat list to 360px. theme.css overrides that one column's width from
// the --wa-side-width variable; this code finds the columns, hosts the drag
// handle, and keeps everything in step when React remounts the layout.
//
// The columns are found structurally (the row is the main screen's child, the
// side column is the row child holding #pane-side) rather than by walking up
// until a width test passes, which could stop on the wrong ancestor when a
// panel opened and left the width stuck.
// ===========================================================================
const MIN_WIDTH = 260;
const MAX_FRACTION = 0.6;
const DEFAULT_FRACTION = 0.3;

let splitter = null;
let panes = null;   // { row, side, main }
let width = 0;

function commonAncestor(a, b) {
  if (!a || !b) return null;
  for (let node = a.parentElement; node; node = node.parentElement) {
    if (node.contains(b)) return node;
  }
  return null;
}

function locatePanes() {
  const list = document.getElementById('pane-side');
  if (!list) return null;
  const mainEl = document.getElementById('main');

  const screenEl = document.querySelector('[data-testid="wa-web-main-screen"]');
  const row = (screenEl && [...screenEl.children].find((c) => c.contains(list))) ||
    commonAncestor(list, mainEl);
  if (!row) return null;

  const side = [...row.children].find((c) => c.contains(list));
  if (!side) return null;
  const main = mainEl ? [...row.children].find((c) => c.contains(mainEl)) : null;
  return { row, side, main };
}

function markPanes() {
  const found = locatePanes();
  if (!found) return false;

  found.side.dataset.waPane = 'side';
  if (found.main) found.main.dataset.waPane = 'main';

  // The narrow icon rail is the <header> that is a direct child of the row.
  const rail = [...found.row.children].find((c) => c.tagName === 'HEADER');
  if (rail) rail.dataset.waPane = 'rail';

  // Header gradients fade into whatever surface colour the theme paints.
  if (!document.documentElement.style.getPropertyValue('--wa-surface')) {
    const surface = getComputedStyle(found.row).backgroundColor;
    if (surface && !/rgba\(0, 0, 0, 0\)/.test(surface)) {
      document.documentElement.style.setProperty('--wa-surface', surface);
    }
  }

  panes = found;
  if (splitter && splitter.parentElement !== found.side) found.side.appendChild(splitter);
  return true;
}

/** Strip the 1px divider colour from the column wrappers (never the width). */
function stripHairlines() {
  if (!panes || !panes.row.isConnected) return;
  for (const el of [panes.row, ...panes.row.children]) {
    const s = getComputedStyle(el);
    for (const side of ['Left', 'Right']) {
      // Any scale factor: 1px, 1.09545px, 1.25px ...
      const w = parseFloat(s['border' + side + 'Width']);
      if (w >= 0.5 && w <= 3.5) {
        el.style.setProperty('border-' + side.toLowerCase() + '-color', 'transparent', 'important');
      }
    }
  }
}

/** Headers that reach the window's top-right corner must clear the native buttons. */
function insetHeadersForWindowControls() {
  const edge = window.innerWidth - 8;
  for (const header of document.querySelectorAll('header')) {
    const r = header.getBoundingClientRect();
    header.toggleAttribute('data-wa-under-controls', r.width > 0 && r.top < 30 && r.right >= edge);
  }
}

function clamp(px) {
  const max = Math.max(MIN_WIDTH, window.innerWidth * MAX_FRACTION);
  return Math.round(Math.min(max, Math.max(MIN_WIDTH, px)));
}

function applyWidth(px) {
  width = clamp(px);
  document.documentElement.style.setProperty('--wa-side-width', width + 'px');
}

function createSplitter() {
  splitter = document.createElement('div');
  splitter.id = 'wa-splitter';
  splitter.title = 'Drag to resize · double-click to reset';

  splitter.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !panes) return;
    e.preventDefault();
    const left = panes.side.getBoundingClientRect().left;
    splitter.setPointerCapture(e.pointerId);
    splitter.dataset.dragging = '';
    document.documentElement.dataset.waDragging = '';

    let frame = 0;
    const onMove = (ev) => {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; applyWidth(ev.clientX - left); });
    };
    const onUp = () => {
      splitter.removeEventListener('pointermove', onMove);
      splitter.removeEventListener('pointerup', onUp);
      splitter.removeEventListener('pointercancel', onUp);
      delete splitter.dataset.dragging;
      delete document.documentElement.dataset.waDragging;
      ipcRenderer.send('pane-width:set', width);
    };
    splitter.addEventListener('pointermove', onMove);
    splitter.addEventListener('pointerup', onUp);
    splitter.addEventListener('pointercancel', onUp);
  });

  splitter.addEventListener('dblclick', () => {
    applyWidth(window.innerWidth * DEFAULT_FRACTION);
    ipcRenderer.send('pane-width:set', width);
  });
}

/** An invisible drag handle across the top edge, first in <body> so that every
 *  control after it keeps its own no-drag region (see theme.css). */
function createDragStrip() {
  const strip = document.createElement('div');
  strip.id = 'wa-dragstrip';
  document.body.insertBefore(strip, document.body.firstChild);
}

function setAccent(accent) {
  if (!accent) return;
  document.documentElement.style.setProperty('--wa-accent-color', accent.hex);
  document.documentElement.style.setProperty('--wa-accent-rgb', accent.rgb);
}

async function setupLayout() {
  createDragStrip();
  createSplitter();

  ipcRenderer.invoke('privacyBlur:get').then((on) => {
    if (on) document.body.classList.add('privacy-blur-active');
  });
  ipcRenderer.invoke('system:accent-color').then(setAccent).catch(() => {});
  ipcRenderer.on('accent-color-updated', (_e, accent) => setAccent(accent));

  const saved = await ipcRenderer.invoke('pane-width:get');
  const initial = saved || window.innerWidth * DEFAULT_FRACTION;
  applyWidth(initial);

  const refresh = () => {
    if (markPanes()) stripHairlines();
    insetHeadersForWindowControls();
  };

  // The chat list mounts well after first paint, and React remounts the layout
  // on login, logout and some navigations. The row's own children only change
  // when that happens, so watch them and re-mark immediately; the slow timer is
  // the safety net (and skips work while the window is hidden).
  let observedRow = null;
  const rowObserver = new MutationObserver(refresh);
  const tick = () => {
    if (document.hidden) return;
    refresh();
    if (panes && panes.row !== observedRow) {
      rowObserver.disconnect();
      rowObserver.observe(panes.row, { childList: true });
      observedRow = panes.row;
    }
  };
  setInterval(tick, 700);
  tick();

  window.addEventListener('resize', () => { applyWidth(width || initial); refresh(); });
  document.addEventListener('fullscreenchange', () => setTimeout(refresh, 100));
  ipcRenderer.on('window-resized', () => { applyWidth(width || initial); refresh(); });
}

// ===========================================================================
// Voice & video call quality.
//
// Runs in the page's own JavaScript world (webFrame.executeJavaScript) so it
// can wrap navigator.mediaDevices.getUserMedia before WhatsApp's scripts
// capture a reference to it.
//
//  Microphone: Chromium's DSP (echo cancellation, noise suppression, AGC) runs
//    on capture, then a WebAudio chain: high-pass (desk rumble / mic handling),
//    presence EQ, compressor, make-up gain, limiter.
//  Camera: frames are redrawn through a canvas whose exposure adapts to how
//    dark the picture is. A fixed filter over-brightened well-lit rooms and the
//    old code also wrote absolute brightness/contrast values into the camera
//    driver, which stuck around after the call.
//
// If anything throws, the page gets the untouched device track.
// ===========================================================================
function hookMediaDevices() {
  function mainWorldPipeline() {
    if (window.__waEnhancedMediaHook) return;
    window.__waEnhancedMediaHook = true;

    const md = navigator.mediaDevices;
    if (!md || !md.getUserMedia) return;
    const origGetUserMedia = md.getUserMedia.bind(md);
    // Filled in from the tray toggles by the preload; both default to on.
    const prefs = () => window.__waMedia || { video: true, audio: true };

    const enabledDesc = Object.getOwnPropertyDescriptor(MediaStreamTrack.prototype, 'enabled');

    /** Make `out` (our processed track) look like the device track `raw`. */
    function mirror(out, raw, cleanup) {
      const define = (name, get) => {
        try { Object.defineProperty(out, name, { get, configurable: true }); } catch {}
      };
      define('label', () => raw.label);
      define('id', () => raw.id);
      for (const m of ['getCapabilities', 'getConstraints', 'getSettings']) {
        if (raw[m]) out[m] = () => raw[m]();
      }
      out.applyConstraints = (c) => raw.applyConstraints(c);
      // Muting must reach the device too, so the camera light goes off.
      try {
        Object.defineProperty(out, 'enabled', {
          configurable: true,
          get() { return enabledDesc.get.call(out); },
          set(v) { enabledDesc.set.call(out, v); try { raw.enabled = v; } catch {} }
        });
      } catch {}

      let closed = false;
      const close = () => {
        if (closed) return false;
        closed = true;
        try { cleanup(); } catch {}
        return true;
      };
      const nativeStop = out.stop.bind(out);
      out.stop = () => {
        close();
        try { raw.stop(); } catch {}
        nativeStop();
      };
      // Unplugged / grabbed by another app: stop() never fires 'ended' by
      // itself, so say so explicitly or the call shows a frozen frame forever.
      raw.addEventListener('ended', () => {
        if (close()) {
          nativeStop();
          out.dispatchEvent(new Event('ended'));
        }
      });
      raw.addEventListener('mute', () => out.dispatchEvent(new Event('mute')));
      raw.addEventListener('unmute', () => out.dispatchEvent(new Event('unmute')));
      return out;
    }

    // ---- Microphone ------------------------------------------------------
    let audioCtx = null;
    let chains = 0;

    function enhanceAudioTrack(raw) {
      if (!audioCtx || audioCtx.state === 'closed') {
        audioCtx = new AudioContext({ latencyHint: 'interactive' });
      }
      const ctx = audioCtx;
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});

      const src = ctx.createMediaStreamSource(new MediaStream([raw]));

      const highpass = ctx.createBiquadFilter();
      highpass.type = 'highpass';
      highpass.frequency.value = 90;

      const presence = ctx.createBiquadFilter();
      presence.type = 'peaking';
      presence.frequency.value = 3200;
      presence.Q.value = 0.9;
      presence.gain.value = 2.5;               // consonant clarity

      const compressor = ctx.createDynamicsCompressor();
      compressor.threshold.value = -30;        // evens out quiet and loud talking
      compressor.knee.value = 20;
      compressor.ratio.value = 3;
      compressor.attack.value = 0.004;
      compressor.release.value = 0.18;

      const makeup = ctx.createGain();
      makeup.gain.value = 1.8;                 // about +5 dB; the limiter catches peaks

      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -2;            // no clipping after the boost
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.001;
      limiter.release.value = 0.05;

      const dest = ctx.createMediaStreamDestination();
      src.connect(highpass);
      highpass.connect(presence);
      presence.connect(compressor);
      compressor.connect(makeup);
      makeup.connect(limiter);
      limiter.connect(dest);

      chains++;
      const out = dest.stream.getAudioTracks()[0];
      return mirror(out, raw, () => {
        src.disconnect();
        limiter.disconnect();
        // Release the audio device when the last call / recording is over.
        if (--chains === 0 && audioCtx) {
          audioCtx.close().catch(() => {});
          audioCtx = null;
        }
      });
    }

    // ---- Camera ----------------------------------------------------------
    const TARGET_LUMA = 120;   // mid-tone a well exposed face sits around

    function enhanceVideoTrack(raw) {
      const s = raw.getSettings ? raw.getSettings() : {};

      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.srcObject = new MediaStream([raw]);

      const canvas = document.createElement('canvas');
      canvas.width = s.width || 1280;
      canvas.height = s.height || 720;
      const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
      if (!ctx) throw new Error('no 2d context');

      const probe = document.createElement('canvas');
      probe.width = 32;
      probe.height = 18;
      const pctx = probe.getContext('2d', { willReadFrequently: true });

      // captureStream(0) + requestFrame(): one output frame per camera frame,
      // not a fixed 30 fps clock that duplicates frames and wastes encoder time.
      const out = canvas.captureStream(0).getVideoTracks()[0];
      if (!out) throw new Error('no capture track');

      let active = true;
      let exposure = 1;
      let frame = 0;

      const schedule = () => {
        if (!active) return;
        if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(render);
        else requestAnimationFrame(render);
      };

      function render() {
        if (!active) return;
        if (video.videoWidth) {
          if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
          }
          // Re-measure the scene about twice a second and ease toward it, so
          // the picture never pumps.
          if (frame++ % 15 === 0) {
            pctx.drawImage(video, 0, 0, 32, 18);
            const px = pctx.getImageData(0, 0, 32, 18).data;
            let sum = 0;
            for (let i = 0; i < px.length; i += 4) {
              sum += px[i] * 0.2126 + px[i + 1] * 0.7152 + px[i + 2] * 0.0722;
            }
            const luma = sum / (px.length / 4) || 1;
            const wanted = Math.min(1.7, Math.max(0.95, TARGET_LUMA / luma));
            exposure += (wanted - exposure) * 0.25;
          }
          ctx.filter = 'brightness(' + exposure.toFixed(3) + ') contrast(1.08) saturate(1.06)';
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          if (out.requestFrame) out.requestFrame();
        }
        schedule();
      }

      video.play().then(schedule, schedule);

      return mirror(out, raw, () => {
        active = false;
        video.srcObject = null;
      });
    }

    function swap(stream, raw, build) {
      try {
        const out = build(raw);
        stream.removeTrack(raw);
        stream.addTrack(out);
      } catch (e) {
        console.warn('[Relay] media enhancement skipped:', e);
      }
    }

    md.getUserMedia = async function (constraints) {
      const c = constraints || {};
      const p = prefs();
      const next = { ...c };

      if (c.audio) {
        next.audio = {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          ...(typeof c.audio === 'object' ? c.audio : {})
        };
      }
      if (c.video) {
        const v = typeof c.video === 'object' ? { ...c.video } : {};
        if (!v.width && !v.height) {
          v.width = { ideal: 1280 };
          v.height = { ideal: 720 };
        }
        if (!v.frameRate) v.frameRate = { ideal: 30 };
        next.video = v;
      }

      const stream = await origGetUserMedia(next);
      if (p.audio) for (const t of stream.getAudioTracks()) swap(stream, t, enhanceAudioTrack);
      if (p.video) for (const t of stream.getVideoTracks()) swap(stream, t, enhanceVideoTrack);
      return stream;
    };
  }

  try {
    webFrame.executeJavaScript('(' + mainWorldPipeline.toString() + ')();');
  } catch (err) {
    console.warn('[Call Enhancement] Injection failed:', err);
  }
}

// Hook media devices immediately at startup, before the page's own scripts run.
try {
  hookMediaDevices();
} catch (e) {
  console.warn('hookMediaDevices error:', e);
}

// The tray toggles arrive asynchronously; the page-world pipeline reads them
// when a call or recording actually asks for the devices, long after this
// resolves.
ipcRenderer.invoke('media:prefs')
  .then((p) => webFrame.executeJavaScript('window.__waMedia = ' + JSON.stringify({
    video: Boolean(p && p.video),
    audio: Boolean(p && p.audio)
  })))
  .catch(() => {});

// ===========================================================================
window.addEventListener('DOMContentLoaded', () => {
  watchBadge();
  hookNotifications();
  watchForBrowserOnly();
  setupLayout();
});
