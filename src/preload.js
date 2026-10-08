'use strict';

const { ipcRenderer, webFrame } = require('electron');

// The theme is a dark one, but WhatsApp starts every new profile in light mode.
// Pick dark once; after that the user's own choice in Settings > Theme wins.
try {
  if (window.localStorage.getItem('theme') === null) {
    window.localStorage.setItem('theme', '"dark"');
  }
} catch {}

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
  const pageWorld = (relayIcon) => {
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
        if (window.__relayDnd) {              // do not disturb: swallow the toast
          const quiet = new EventTarget();
          quiet.close = () => {};
          return quiet;
        }
        // A toast without an image would show a generic icon; give it Relay's.
        const n = new NativeNotification(title, relayIcon && !(options && options.icon) ? { ...options, icon: relayIcon } : options);
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
    webFrame.executeJavaScript(`(${pageWorld.toString()})(${JSON.stringify(relayIconUri)});`);
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
// WhatsApp's own dialogs and popovers (for example the message explaining why a
// call cannot start) are never hidden, whatever they say.
const MODAL = '[role="dialog"], [role="alertdialog"], [role="menu"], [aria-modal="true"], [data-animate-modal-popup]';

/** First ancestor of `el` (within a few levels) for which `test` holds. */
function ancestorWhere(el, test) {
  let node = el.parentElement;
  for (let i = 0; node && i < 6; i++, node = node.parentElement) {
    if (test(node)) return node;
  }
  return null;
}

/** Climb to the outermost ancestor that is still banner-sized. */
function bannerRoot(el, maxHeight = MAX_BANNER_HEIGHT) {
  let node = el;
  while (node.parentElement) {
    const parent = node.parentElement;
    if (parent === document.body || parent.id === 'app' || parent.id === 'pane-side') break;
    if (parent.getBoundingClientRect().height > maxHeight) break;
    node = parent;
  }
  return node;
}

const DESKTOP_RULES = [
  { text: /^(get|download) whatsapp for (windows|mac|desktop)\b/i, target: (el) => bannerRoot(el) },
  // Empty-state cards in Calls and elsewhere: an illustration, a line such as
  // "Download WhatsApp for Windows to start returning missed calls" and a
  // button. A card is taller than a banner, so allow a bigger one.
  { text: /^download whatsapp for windows to\b/i, target: (el) => bannerRoot(el, 420) },
  { text: /^(download whatsapp|download app|get the app|get the windows app)$/i,
    target: (el) => bannerRoot(el, 420) },
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

/**
 * Tag the element that holds WhatsApp's logo / wordmark so theme.css can draw
 * Relay's instead. Matched by the SVG's own <title>, which is stable, unlike
 * class names.
 */
function applyBranding(root) {
  if (!root.querySelectorAll) return;
  for (const title of root.querySelectorAll('svg > title')) {
    const name = title.textContent;
    const kind = { 'wa-logo': 'logo', 'wa-wordmark': 'wordmark', 'wa-square-icon': 'square', 'WhatsApp logo': 'qr' }[name];
    if (!kind) continue;
    const host = title.parentElement.parentElement;
    if (host && !host.dataset.relayBrand) host.dataset.relayBrand = kind;
  }
}

/** Hide every browser-only element inside `root` (which may itself be one). */
function stripBrowserOnly(root) {
  root = root || document;
  applyBranding(root);

  if (root.matches && root.matches(PROMO_LINK)) hideElement(bannerRoot(root));
  if (!root.querySelectorAll) return;
  for (const link of root.querySelectorAll(PROMO_LINK)) {
    if (!link.closest(MODAL)) hideElement(bannerRoot(link));
  }

  // Leaf elements only, and the length check keeps the regexes off long text.
  for (const el of root.querySelectorAll('span, div, label, button')) {
    if (el.childElementCount !== 0) continue;
    const text = el.textContent.trim();
    if (!text || text.length > 100 || el.closest(MODAL)) continue;
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
const MIN_WIDTH = 240;
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

// ---------------------------------------------------------------------------
// Theme colour. Relay's whole palette (the glow, accents, switches, surfaces) is
// built from one colour: the one you picked as your chat theme in WhatsApp (read
// from the outgoing-bubble colour of the open chat), else the Windows accent
// colour, else blue. Everything is set as CSS variables on <html>, so it changes
// the moment the theme does. theme.css only ever refers to the variables.
// ---------------------------------------------------------------------------
const THEME_KEY = 'relay.themeBase';
const FALLBACK_BASE = '#5288c1';
let systemAccentHex = null;
let appliedBase = '';

function hexToHsl(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  const l = (mx + mn) / 2;
  let h = 0, s = 0;
  if (d) {
    s = d / (1 - Math.abs(2 * l - 1));
    h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  return [h, s * 100, l * 100];
}

function hslToRgb(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))));
  return [f(0), f(8), f(4)];
}

const rgbHex = ([r, g, b]) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');

/** Any CSS colour string -> '#rrggbb' (or null). */
function toHex(css) {
  const probe = document.createElement('span');
  probe.style.color = css;
  if (!probe.style.color) return null;
  document.documentElement.append(probe);
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(probe).color);
  probe.remove();
  return m ? rgbHex([+m[1], +m[2], +m[3]]) : null;
}

/** Every variable the theme uses, derived from one base colour. */
/** WCAG relative luminance and contrast ratio, for keeping text readable on any theme colour. */
function relLuminance([r, g, b]) {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrastRatio(a, b) {
  const [hi, lo] = [relLuminance(a), relLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function buildPalette(baseHex) {
  let [h, s] = hexToHsl(baseHex);
  s = Math.max(40, Math.min(72, s));
  const tone = (l, sat = s) => hslToRgb(h, sat, l);
  const surf = (l) => hslToRgb(h, Math.min(30, s * 0.62), l);
  const p = {};
  const set = (name, rgb) => { p[name] = rgbHex(rgb); p[name + '-RGB'] = rgb.join(', '); };

  // Deep blues and violets are dark even at mid lightness; lift the accent until it stands out
  // from the list background (4:1), and pick black or white text, whichever reads better on it.
  const base1 = surf(9);
  let lift = 56;
  while (lift < 76 && contrastRatio(tone(lift), base1) < 4) lift += 2;
  const accent = tone(lift), soft = tone(Math.min(92, lift + 16)), strong = tone(Math.min(88, lift + 7));
  const deep = tone(23, s * 0.9), mid = tone(30, s * 0.85), pale = tone(88);
  const onAccent = contrastRatio([255, 255, 255], accent) >= contrastRatio([11, 20, 26], accent) ? [255, 255, 255] : [11, 20, 26];
  p['--relay-on-accent'] = rgbHex(onAccent);
  p['--relay-accent'] = rgbHex(accent);
  p['--relay-accent-rgb'] = accent.join(', ');
  p['--relay-accent-soft'] = rgbHex(soft);
  p['--relay-accent-strong'] = rgbHex(strong);
  p['--relay-accent-deep'] = rgbHex(deep);
  p['--relay-accent-mid'] = rgbHex(mid);
  p['--relay-accent-pale'] = rgbHex(pale);

  const r0 = surf(5.5), r1 = surf(9), r2 = surf(12.5), r3 = surf(16);
  [['0', r0], ['1', r1], ['2', r2], ['3', r3]].forEach(([k, v]) => { p['--relay-' + k] = rgbHex(v); p['--relay-' + k + '-rgb'] = v.join(', '); });

  // WhatsApp's own tokens (each has an -RGB twin it uses inside rgba()).
  const T = (names, rgb) => names.forEach((n) => set(n, rgb));
  T(['--WDS-systems-chat-background-wallpaper', '--WDS-systems-chat-surface-tray'], r0);
  T(['--WDS-surface-default', '--WDS-background-wash-plain', '--WDS-background-wash-inset', '--WDS-components-surface-nav-bar'], r1);
  T(['--WDS-surface-elevated-default', '--WDS-surface-emphasized', '--WDS-background-elevated-wash-plain',
    '--WDS-background-elevated-wash-inset', '--WDS-systems-bubble-surface-system', '--WDS-systems-bubble-surface-e2e',
    '--WDS-systems-bubble-surface-business'], r2);
  T(['--WDS-surface-elevated-emphasized', '--WDS-systems-chat-surface-composer', '--WDS-systems-bubble-surface-incoming'], r3);
  set('--WDS-systems-bubble-surface-outgoing', mid);
  set('--WDS-components-filter-surface-selected', deep);
  for (const n of ['--app-background', '--navbar-background']) p[n] = rgbHex(r1);
  p['--splashscreen-startup-background'] = p['--splashscreen-startup-background-plain'] = rgbHex(r0);
  p['--splashscreen-startup-background-rgb'] = r0.join(', ');

  // WhatsApp's green scale, remapped onto the base colour.
  [['100', 92], ['200', 82], ['300', 72], ['400', 63], ['450', 56], ['500', 48], ['600', 40], ['700', 32], ['750', 30], ['800', 23]]
    .forEach(([k, l]) => { p['--WDS-green-' + k] = rgbHex(tone(l)); });
  Object.assign(p, {
    '--WDS-accent': p['--relay-accent'], '--WDS-accent-deemphasized': p['--relay-accent-deep'],
    '--WDS-accent-emphasized': p['--relay-accent-pale'], '--WDS-content-action-emphasized': p['--relay-accent-soft'],
    '--WDS-content-external-link': p['--relay-accent-soft'], '--WDS-persistent-always-branded': p['--relay-accent'],
    '--WDS-persistent-activity-indicator': p['--relay-accent-strong'], '--WDS-secondary-positive': p['--relay-accent-soft'],
    '--WDS-secondary-positive-deemphasized': p['--relay-accent-deep'], '--icon-primary': p['--relay-accent'],
    '--badge-pending': p['--relay-accent'], '--green-deep': p['--relay-accent'], '--status-ring-unread': p['--relay-accent-strong'],
    '--ptt-green': p['--relay-accent-strong']
  });
  return p;
}

const paletteKeys = new Set();

/** Relay's look is a dark one. If WhatsApp itself is set to its Light theme (dark text), step aside
 *  instead of putting dark surfaces under dark text. WhatsApp's own text colour tells which it is. */
function whatsAppIsLight() {
  const text = getComputedStyle(document.documentElement).getPropertyValue('--WDS-content-default').trim();
  const hex = text && toHex(text);
  return Boolean(hex) && relLuminance([parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]) < 0.35;
}

function clearPalette() {
  for (const k of paletteKeys) document.documentElement.style.removeProperty(k);
  paletteKeys.clear();
  appliedBase = '';
}

function applyTheme(baseHex) {
  let base = baseHex || FALLBACK_BASE;
  if (hexToHsl(base)[1] < 14) base = FALLBACK_BASE;       // a grey has no hue to build a palette from
  if (base === appliedBase) return;
  appliedBase = base;
  const palette = buildPalette(base);
  const root = document.documentElement.style;
  for (const [k, v] of Object.entries(palette)) { root.setProperty(k, v, 'important'); paletteKeys.add(k); }
  ipcRenderer.send('theme-palette', {
    accent: palette['--relay-accent'], rgb: palette['--relay-accent-rgb'], soft: palette['--relay-accent-soft'],
    strong: palette['--relay-accent-strong'], onAccent: palette['--relay-on-accent'], r0: palette['--relay-0'], r1: palette['--relay-1'], r2: palette['--relay-2'], r3: palette['--relay-3']
  });
}

/** The chat-theme colour, if you picked one: the open chat's outgoing-bubble colour. */
function readChatThemeBase() {
  const main = document.querySelector('#main');
  if (!main) return null;
  const mine = document.documentElement.style.getPropertyValue('--WDS-systems-bubble-surface-outgoing').trim();
  const v = getComputedStyle(main).getPropertyValue('--WDS-systems-bubble-surface-outgoing').trim();
  if (!v || v.toLowerCase() === mine.toLowerCase()) return 'none';     // no chat theme chosen
  const hex = toHex(v);
  return hex && hexToHsl(hex)[1] >= 18 ? hex : 'none';              // greys carry no colour
}

let chatThemeBase = null;
function refreshTheme() {
  const light = whatsAppIsLight();
  document.documentElement.toggleAttribute('data-relay-light', light);
  if (light) { if (paletteKeys.size) clearPalette(); return; }
  const found = readChatThemeBase();
  if (found) {
    const next = found === 'none' ? '' : found;
    if (next !== chatThemeBase) {
      chatThemeBase = next;
      try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* private mode */ }   // remembered for the next start
    }
  }
  applyTheme(chatThemeBase || systemAccentHex || FALLBACK_BASE);
}

/**
 * Headers are drag handles for the frameless window, but WhatsApp's clickable bits
 * (the back arrow in a side panel, for one) are plain <div>s with no role, which
 * CSS cannot single out - and a drag region swallows clicks. Anything in a header
 * that shows a pointer cursor is marked no-drag.
 */
// An element is looked at again every few seconds, not once: a control that is disabled (grey, default cursor)
// when first seen and enabled later - the search and menu buttons of a chat that is still loading - used to stay
// in the drag region for ever, which swallows the hover AND the click.
const headerChecked = new WeakMap();                 // element -> time of the last look
const HEADER_RECHECK_MS = 2500;
function markClickableInHeaders() {
  const now = Date.now();
  for (const el of document.querySelectorAll('header *')) {
    if (el.dataset.waNodrag !== undefined) continue;
    const last = headerChecked.get(el);
    if (last && now - last < HEADER_RECHECK_MS) continue;
    headerChecked.set(el, now);
    if (el.childElementCount > 6 || el.tagName === 'svg' || el.tagName === 'path') continue;
    const cs = getComputedStyle(el);
    if (cs.cursor === 'pointer' || el.hasAttribute('aria-disabled') || /^(button|a|input)$/i.test(el.tagName) ||
        (el.getAttribute('role') || '') === 'button') el.dataset.waNodrag = '';
  }
}

/**
 * A drag region is measured from the layout, not from what is on top: a header that is hidden under a side
 * drawer (Settings, Status, Channels...) keeps dragging - and swallowing clicks - underneath it. Headers whose
 * centre is covered by something that is not inside them stop being drag regions (theme.css).
 */
function releaseCoveredHeaders() {
  for (const h of document.querySelectorAll('header, [data-wa-pane="rail"]')) {
    const r = h.getBoundingClientRect();
    if (!r.width || !r.height) { delete h.dataset.relayCovered; continue; }
    const pts = [[r.left + r.width / 2, r.top + Math.min(r.height / 2, 24)], [r.left + 8, r.top + 8], [r.right - 8, r.top + 8]];
    const covered = pts.every(([x, y]) => {
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false;
      const top = document.elementFromPoint(x, y);
      return top && !h.contains(top) && !top.contains(h);
    });
    if (covered) h.dataset.relayCovered = ''; else delete h.dataset.relayCovered;
  }
}

/**
 * WhatsApp pins the left drawer (Settings, Status, Channels, Communities...) to 342px, but the sidebar can be
 * dragged wider; on some layouts the drawer also starts at the very left edge over the icon rail. Either way a strip of
 * the chat list showed beside it. The drawer is stretched to the sidebar's right edge.
 */
function fitSideDrawer() {
  const d = document.querySelector('[data-testid="drawer-left"]');
  const side = document.getElementById('side');
  if (!d || !side) return;
  const dr = d.getBoundingClientRect(), sr = side.getBoundingClientRect();
  if (!dr.width || !sr.width) return;
  const want = Math.round(sr.right - dr.left);
  const off = () => { if (d.dataset.relayFit !== undefined) { for (const p of ['flex', 'width', 'max-width']) d.style.removeProperty(p); delete d.dataset.relayFit; } };
  if (want > 346 && want < innerWidth * 0.8) {                       // wider than WhatsApp's own 342px drawer
    if (Math.abs(dr.width - want) > 2) {
      for (const [p, v] of [['flex', '0 0 ' + want + 'px'], ['width', want + 'px'], ['max-width', want + 'px']]) d.style.setProperty(p, v, 'important');
      d.dataset.relayFit = '';
    }
  } else off();                                                       // sidebar back at its normal width: leave the drawer alone
}

/** The title typeface, as a FontFace built from bytes (no network, so WhatsApp's CSP has no say). */
function loadTitleFont() {
  try {
    const b64 = ipcRenderer.sendSync('font:get');
    if (!b64) return;
    webFrame.executeJavaScript(`(() => { try {
      const bin = atob(${JSON.stringify(b64)}); const u = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      new FontFace('Relay Serif', u.buffer, { weight: '500' }).load().then((f) => document.fonts.add(f)).catch(() => {});
    } catch (e) {} })()`);
  } catch (e) { /* the title falls back to Georgia */ }
}
loadTitleFont();

function setAccent(accent) {
  if (!accent) return;
  document.documentElement.style.setProperty('--wa-accent-color', accent.hex);
  document.documentElement.style.setProperty('--wa-accent-rgb', accent.rgb);
  systemAccentHex = accent.hex;
  refreshTheme();
}

// First paint uses the colour remembered from last time, not a flash of blue.
try {
  const saved = localStorage.getItem(THEME_KEY);
  if (/^#[0-9a-f]{6}$/i.test(saved || '')) chatThemeBase = saved;
} catch (e) { /* storage unavailable */ }

async function setupLayout() {
  applyTheme(chatThemeBase || systemAccentHex || FALLBACK_BASE);
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
    reportCallState();                 // also while hidden: the screen-awake lock must be released
    if (document.hidden) return;
    refresh();
    refreshTheme();
    markClickableInHeaders();
    releaseCoveredHeaders();
    fitSideDrawer();
    installCallFullscreenButton();
    syncSharePreview();
    if (panes && panes.row !== observedRow) {
      rowObserver.disconnect();
      rowObserver.observe(panes.row, { childList: true });
      observedRow = panes.row;
    }
  };
  setInterval(tick, 700);
  tick();

  // Dragging a window edge fires resize dozens of times a second, from both the page and
  // the main process; each refresh measures layout. One refresh per frame is plenty.
  let refreshQueued = false, refreshIdle = 0;
  const refreshSoon = () => {
    if (refreshQueued) return;
    refreshQueued = true;
    requestAnimationFrame(() => {
      refreshQueued = false;
      applyWidth(width || initial);               // cheap: one CSS variable
      clearTimeout(refreshIdle);
      refreshIdle = setTimeout(refresh, 90);      // the layout-measuring part waits for the drag to pause
    });
  };
  window.addEventListener('resize', refreshSoon);
  document.addEventListener('fullscreenchange', () => setTimeout(refresh, 100));
  ipcRenderer.on('window-resized', refreshSoon);
}

// ===========================================================================
// Call window: full screen.
//
// The call is a floating, resizable panel (data-testid="move_resize_component").
// Making that one element fullscreen is enough: WhatsApp re-lays the call out
// for the new size, including the video resolution, and restores it on exit.
// A button is cloned from the toolbar's "More options" button so it picks up the
// toolbar's own styling; double-clicking the picture does the same.
// ===========================================================================
const FULLSCREEN_ENTER = 'M5 5h5v2H7v3H5V5zm9 0h5v5h-2V7h-3V5zM5 14h2v3h3v2H5v-5zm12 0h2v5h-5v-2h3v-3z';
const FULLSCREEN_EXIT = 'M8 5v3H5v2h5V5H8zm6 0v5h5V8h-3V5h-2zM5 14v2h3v3h2v-5H5zm9 0v5h2v-3h3v-2h-5z';

function toggleCallFullscreen(panel) {
  if (document.fullscreenElement) document.exitFullscreen();
  else panel.requestFullscreen().catch(() => {});
}

function syncFullscreenButton(panel) {
  const btn = panel.querySelector('[data-relay-fs] button');
  if (!btn) return;
  const on = document.fullscreenElement === panel;
  btn.setAttribute('aria-label', on ? 'Exit full screen' : 'Full screen');
  const path = btn.querySelector('svg path');
  if (path) path.setAttribute('d', on ? FULLSCREEN_EXIT : FULLSCREEN_ENTER);
  const title = btn.querySelector('svg title');
  if (title) title.textContent = on ? 'exit-full-screen' : 'full-screen';
}

// ---------------------------------------------------------------------------
// Screen sharing: hide your own shared-screen preview.
//
// Sharing the whole screen shows the call window inside the call window inside
// the call window, forever - a big live canvas that does nothing but cost
// rendering. While you are sharing, the big preview is hidden and a toolbar
// button (eye) brings it back. Hidden is the default.
// ---------------------------------------------------------------------------
const EYE_ON = 'M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z';
const EYE_OFF = 'M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.82l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.74-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z';
const hiddenPreviews = new WeakSet();

function sharePreviewHidden() {
  try { return window.localStorage.getItem('relay.showSharePreview') !== '1'; } catch { return true; }
}

function syncSharePreview() {
  const panel = document.querySelector('[data-testid="move_resize_component"]');
  if (!panel) return;
  const sharing = Boolean(panel.querySelector('button[aria-label*="Stop sharing" i]'));
  const slot = panel.querySelector('[data-relay-share]');

  // The preview is the large, screen-shaped picture; the small tiles stay.
  const preview = [...panel.querySelectorAll('canvas')]
    .filter((c) => c.width >= 300 && c.width / c.height > 1.3)
    .sort((a, b) => b.width * b.height - a.width * a.height)[0];

  if (!sharing) {
    if (slot) slot.remove();
    if (preview && hiddenPreviews.has(preview)) { preview.style.display = ''; hiddenPreviews.delete(preview); }
    return;
  }

  if (!slot) {
    const more = [...panel.querySelectorAll('button[aria-label]')]
      .find((b) => /^more options$/i.test(b.getAttribute('aria-label')));
    if (more) {
      let wrapper = more;
      while (wrapper.parentElement && wrapper.parentElement.children.length === 1) wrapper = wrapper.parentElement;
      if (wrapper.parentElement) {
        const clone = wrapper.cloneNode(true);
        clone.dataset.relayShare = '';
        const btn = clone.querySelector('button');
        btn.removeAttribute('aria-expanded');
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          try { window.localStorage.setItem('relay.showSharePreview', sharePreviewHidden() ? '1' : '0'); } catch {}
          syncSharePreview();
        });
        btn.addEventListener('pointerdown', (e) => e.stopPropagation());
        wrapper.parentElement.insertBefore(clone, wrapper);
      }
    }
  }

  const hidden = sharePreviewHidden();
  if (preview) {
    preview.style.display = hidden ? 'none' : '';
    if (hidden) hiddenPreviews.add(preview); else hiddenPreviews.delete(preview);
  }
  const btn = panel.querySelector('[data-relay-share] button');
  if (btn) {
    btn.setAttribute('aria-label', hidden ? 'Show my shared screen' : 'Hide my shared screen');
    btn.title = btn.getAttribute('aria-label');
    const path = btn.querySelector('svg path');
    if (path) path.setAttribute('d', hidden ? EYE_OFF : EYE_ON);
    const title = btn.querySelector('svg title');
    if (title) title.textContent = hidden ? 'show-shared-screen' : 'hide-shared-screen';
  }
}

let lastCallState = false;
/** Tell the main process whether a call window is open (keeps the screen awake). */
let lastShareState = false;
function reportCallState() {
  const call = document.querySelector('[data-testid="move_resize_component"]');
  const active = Boolean(call);
  if (active !== lastCallState) {
    lastCallState = active;
    ipcRenderer.send('call-state', active);
  }
  // Lets the main process take Relay's own windows out of a screen capture only
  // while a share is actually running.
  const sharing = Boolean(call && call.querySelector('button[aria-label*="Stop sharing" i]'));
  if (sharing !== lastShareState) {
    lastShareState = sharing;
    ipcRenderer.send('share-state', sharing);
  }
}

function installCallFullscreenButton() {
  const panel = document.querySelector('[data-testid="move_resize_component"]');
  if (!panel) return;
  if (!panel.dataset.relayFsReady) {
    panel.dataset.relayFsReady = '';
    panel.addEventListener('dblclick', (e) => {
      if (e.target.closest('button, [role="toolbar"]')) return;
      toggleCallFullscreen(panel);
    });
    document.addEventListener('fullscreenchange', () => syncFullscreenButton(panel));
  }
  if (panel.querySelector('[data-relay-fs]')) return;

  const more = [...panel.querySelectorAll('button[aria-label]')]
    .find((b) => /^more options$/i.test(b.getAttribute('aria-label')));
  if (!more) return;
  // The button sits in a couple of single-child wrappers; clone the outermost.
  let wrapper = more;
  while (wrapper.parentElement && wrapper.parentElement.children.length === 1) wrapper = wrapper.parentElement;
  const slot = wrapper.parentElement;
  if (!slot) return;

  const clone = wrapper.cloneNode(true);
  clone.dataset.relayFs = '';
  const btn = clone.querySelector('button');
  btn.removeAttribute('aria-expanded');
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleCallFullscreen(panel);
  });
  // The panel can be dragged by mouse; a press on our button must not start that.
  btn.addEventListener('pointerdown', (e) => e.stopPropagation());
  slot.insertBefore(clone, wrapper);
  syncFullscreenButton(panel);
}

// ===========================================================================
// Call recording.
//
// Runs in the page's own world (it has to see WhatsApp's audio nodes). What goes
// into the file:
//   video  the call picture, composed on a 1280x720 canvas: the largest picture
//          in the call window full size, your own preview in the corner. Each
//          source canvas is read through captureStream(), which works even though
//          WhatsApp renders them from a background worker.
//   audio  your microphone (Relay's processed track) mixed with whatever
//          WhatsApp sends to the speakers. WhatsApp's call audio is plain Web
//          Audio, so nodes that feed an output are remembered and, while
//          recording, also fed to a capture destination. Nothing changes for the
//          listener.
// The file is written to disk as it is recorded (a chunk every 2 s through the
// main process), so a crash loses seconds, and it is closed automatically when
// the call window goes away. A one-time consent notice is shown by the main
// process before the first recording.
// ===========================================================================
function hookCallRecording() {
  function pageWorld() {
    if (window.__relayRec) return;
    window.__relayRec = true;
    const post = (msg, transfer) => window.postMessage(Object.assign({ relay: 'rec' }, msg), '*', transfer || []);

    // ---- remote audio tap ----------------------------------------------
    const sources = [];                         // WeakRef<AudioNode> feeding an output
    const taps = new Set();                     // listeners (recording, captions): { dests: Map<AudioContext, destination>, onNew }
    const origConnect = AudioNode.prototype.connect;

    function tapNode(node, t) {
      const ctx = node.context;
      let d = t.dests.get(ctx);
      if (!d) {
        d = ctx.createMediaStreamDestination();
        d.__relayTap = true;
        t.dests.set(ctx, d);
        t.onNew(d);
      }
      try { origConnect.call(node, d); } catch (e) { /* node already gone */ }
    }

    // Live voice translation can turn the original call sound down while the translated voice speaks. For that, everything that
    // plays to the speakers goes through one gain node per audio context (gain 1 = no change). disconnect() is mirrored.
    const origDisconnect = AudioNode.prototype.disconnect;
    const duckNodes = new WeakMap();             // AudioContext -> gain node in front of its destination
    const duckedSources = new WeakSet();         // nodes whose connection to the destination went through that gain
    const duckState = { level: 1 };
    function duckFor(ctx) {
      let g = duckNodes.get(ctx);
      if (!g) {
        g = ctx.createGain();
        g.__relayOwn = true;
        g.gain.value = duckState.level;
        origConnect.call(g, ctx.destination);
        duckNodes.set(ctx, g);
      }
      return g;
    }
    Object.defineProperty(window, '__relayDuck', { value: {
      set(level, seconds) {
        duckState.level = Math.max(0, Math.min(1, level));
        // contexts are only reachable through the nodes seen so far
        for (const ref of sources) {
          const n = ref.deref();
          const g = n && duckNodes.get(n.context);
          if (g) g.gain.setTargetAtTime(duckState.level, g.context.currentTime, seconds || 0.08);
        }
      },
      get level() { return duckState.level; }
    }, enumerable: false });
    AudioNode.prototype.disconnect = function (dest) {
      try {
        if (duckedSources.has(this) && (arguments.length === 0 || dest instanceof AudioDestinationNode)) {
          if (arguments.length === 0) duckedSources.delete(this);
          return arguments.length === 0 ? origDisconnect.call(this) : origDisconnect.call(this, duckNodes.get(this.context));
        }
      } catch (e) { /* fall through to the real thing */ }
      return origDisconnect.apply(this, arguments);
    };

    AudioNode.prototype.connect = function (dest) {
      let result;
      if (dest instanceof AudioDestinationNode && !this.__relayOwn && dest.context === this.context) {
        try {
          origConnect.call(this, duckFor(this.context), ...[].slice.call(arguments, 1));
          duckedSources.add(this);
          result = dest;
        } catch (e) { result = origConnect.apply(this, arguments); }
      } else {
        result = origConnect.apply(this, arguments);
      }
      try {
        const isOutput = dest instanceof AudioDestinationNode ||
          (dest instanceof MediaStreamAudioDestinationNode && !dest.__relayTap);
        // Relay's own microphone processing also ends in a stream destination.
        if (isOutput && !window.__relayBuildingAudio && !this.__relayOwn) {
          sources.push(new WeakRef(this));
          if (sources.length > 300) {                      // sound effects connect often; drop the ones already collected
            for (let i = sources.length - 1; i >= 0; i--) if (!sources[i].deref()) sources.splice(i, 1);
          }
          for (const t of taps) tapNode(this, t);
        }
      } catch (e) { /* never break WhatsApp's audio */ }
      return result;
    };

    /** Starts a listener: onNew(destination) gets one stream per audio context that plays to the speakers. */
    function startTap(onNew) {
      const t = { dests: new Map(), onNew };
      taps.add(t);
      for (let i = sources.length - 1; i >= 0; i--) {
        const n = sources[i].deref();
        if (!n) sources.splice(i, 1); else tapNode(n, t);
      }
      return t;
    }

    function stopTap(t) {
      if (!t || !taps.delete(t)) return;
      for (const [ctx, d] of t.dests) {
        for (const ref of sources) {
          const n = ref.deref();
          if (n && n.context === ctx) { try { n.disconnect(d); } catch (e) { /* ignore */ } }
        }
      }
    }

    // Captions (src/page/captions.js) listen to the same call audio.
    Object.defineProperty(window, '__relayTap', { value: { start: startTap, stop: stopTap }, enumerable: false });

    // ---- picture ---------------------------------------------------------
    const W = 1280, H = 720;
    const out = document.createElement('canvas');
    out.width = W;
    out.height = H;
    const g = out.getContext('2d', { alpha: false });
    const feeds = new Map();                    // source canvas -> hidden <video>

    const panelEl = () => document.querySelector('[data-testid="move_resize_component"]');
    const callCanvases = (panel) => [...panel.querySelectorAll('canvas')]
      .filter((c) => c.width >= 100 && c.height >= 56)       // the level meters are 200x24
      .sort((a, b) => b.width * b.height - a.width * a.height);

    function feed(canvas) {
      let v = feeds.get(canvas);
      if (!v) {
        v = document.createElement('video');
        v.muted = true;
        v.playsInline = true;
        try {
          v.srcObject = canvas.captureStream(24);
          v.play().catch(() => {});
        } catch (e) { return null; }
        feeds.set(canvas, v);
      }
      return v;
    }

    function fit(v, x, y, w, h) {
      const vw = v.videoWidth, vh = v.videoHeight;
      if (!vw || !vh) return;
      const s = Math.min(w / vw, h / vh);
      g.drawImage(v, x + (w - vw * s) / 2, y + (h - vh * s) / 2, vw * s, vh * s);
    }

    function composeFrame() {
      g.fillStyle = '#0b141a';
      g.fillRect(0, 0, W, H);
      const panel = panelEl();
      if (!panel) return;
      const list = callCanvases(panel);
      for (const [c, v] of feeds) {
        if (!list.includes(c)) { v.srcObject = null; feeds.delete(c); }
      }
      const main = list[0];
      const pip = list.slice(1).find((c) => c.width / c.height > 1.3);
      if (main) { const v = feed(main); if (v) fit(v, 0, 0, W, H); }
      if (pip) {
        const v = feed(pip);
        if (v && v.videoWidth) {
          const pw = Math.round(W * 0.22);
          const ph = Math.round(pw * v.videoHeight / v.videoWidth);
          const px = W - pw - 24, py = H - ph - 24;
          g.fillStyle = '#000';
          g.fillRect(px - 2, py - 2, pw + 4, ph + 4);
          g.drawImage(v, px, py, pw, ph);
        }
      }
    }

    // ---- sound -----------------------------------------------------------
    function buildAudio() {
      const ctx = new AudioContext();
      const dest = ctx.createMediaStreamDestination();
      dest.__relayTap = true;
      const add = (stream) => {
        if (!stream.getAudioTracks().length) return;
        const s = ctx.createMediaStreamSource(stream);
        s.__relayOwn = true;
        s.connect(dest);
      };
      let tap = null;
      window.__relayBuildingAudio = true;
      try {
        const mic = window.__relayMicTrack;
        if (mic && mic.readyState === 'live') add(new MediaStream([mic]));
        tap = startTap((d) => add(d.stream));
      } finally { window.__relayBuildingAudio = false; }
      return { ctx, dest, tap };
    }

    // ---- main process handshake ------------------------------------------
    let pending = null;
    window.addEventListener('message', (e) => {
      if (e.source !== window || !e.data) return;
      if (e.data.relay === 'rec-reply' && pending) { const p = pending; pending = null; p(e.data); }
      if (e.data.relay === 'rec-cmd' && e.data.cmd === 'stop') stop();
    });
    const ask = (msg) => new Promise((resolve) => {
      pending = resolve;
      post(msg);
      setTimeout(() => { if (pending === resolve) { pending = null; resolve(null); } }, 180000);
    });

    // ---- recorder --------------------------------------------------------
    const state = { active: false, id: null, rec: null, audio: null, frameTimer: null, startedAt: 0, queue: Promise.resolve() };

    async function start(auto) {
      if (state.active) return;
      const panel = panelEl();
      if (!panel) return;
      const hasVideo = callCanvases(panel).length > 0;
      const candidates = hasVideo
        ? ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/webm;codecs=vp9,opus', 'video/webm']
        : ['audio/mp4;codecs=mp4a.40.2', 'audio/webm;codecs=opus', 'audio/webm'];
      const mime = candidates.find((m) => MediaRecorder.isTypeSupported(m));
      if (!mime) return;
      const ext = mime.indexOf('mp4') >= 0 ? (hasVideo ? 'mp4' : 'm4a') : 'webm';

      const reply = await ask({ type: 'open', ext, video: hasVideo, auto: Boolean(auto) });
      if (!reply || !reply.ok) return;

      state.id = reply.id;
      state.audio = buildAudio();
      let stream;
      if (hasVideo) {
        stream = out.captureStream(24);
        state.audio.dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
        state.frameTimer = setInterval(composeFrame, 1000 / 24);
        composeFrame();
      } else {
        stream = state.audio.dest.stream;
      }
      const id = state.id;
      let rec;
      try {
        rec = new MediaRecorder(stream, hasVideo
          ? { mimeType: mime, videoBitsPerSecond: 3000000, audioBitsPerSecond: 128000 }
          : { mimeType: mime, audioBitsPerSecond: 128000 });
      } catch (err) {                                       // give the file back instead of leaving it open and empty
        clearInterval(state.frameTimer);
        stopTap(state.audio.tap);
        try { state.audio.ctx.close(); } catch (e) { /* ignore */ }
        post({ type: 'close', id });
        return;
      }
      state.queue = Promise.resolve();
      rec.ondataavailable = (e) => {
        if (!e.data || !e.data.size) return;
        state.queue = state.queue
          .then(() => e.data.arrayBuffer())
          .then((buf) => post({ type: 'chunk', id, buf }, [buf]));
      };
      rec.onstop = () => { state.queue = state.queue.then(() => post({ type: 'close', id })); };
      rec.start(2000);
      state.rec = rec;
      state.startedAt = Date.now();
      state.active = true;
      updateButton();
    }

    function stop() {
      if (!state.active) return;
      state.active = false;
      clearInterval(state.frameTimer);
      try { state.rec.stop(); } catch (e) { /* already stopped */ }
      stopTap(state.audio.tap);
      try { state.audio.ctx.close(); } catch (e) { /* ignore */ }
      for (const v of feeds.values()) v.srcObject = null;
      feeds.clear();
      updateButton();
    }

    // ---- toolbar button --------------------------------------------------
    const DOT = 'M12 6a6 6 0 1 0 0 12 6 6 0 0 0 0-12z';
    const SQUARE = 'M7 7h10v10H7z';

    function ensureButton(panel) {
      if (panel.querySelector('[data-relay-rec]')) return;
      const more = [...panel.querySelectorAll('button[aria-label]')]
        .find((b) => /^more options$/i.test(b.getAttribute('aria-label')));
      if (!more) return;
      let wrapper = more;
      while (wrapper.parentElement && wrapper.parentElement.children.length === 1) wrapper = wrapper.parentElement;
      if (!wrapper.parentElement) return;
      const clone = wrapper.cloneNode(true);
      clone.dataset.relayRec = '';
      const btn = clone.querySelector('button');
      btn.removeAttribute('aria-expanded');
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (state.active) stop(); else start(false);
      });
      btn.addEventListener('pointerdown', (e) => e.stopPropagation());
      wrapper.parentElement.insertBefore(clone, wrapper);
      updateButton();
    }

    function updateButton() {
      const btn = document.querySelector('[data-relay-rec] button');
      if (!btn) return;
      const on = state.active;
      const secs = on ? Math.floor((Date.now() - state.startedAt) / 1000) : 0;
      const t = Math.floor(secs / 60) + ':' + String(secs % 60).padStart(2, '0');
      btn.setAttribute('aria-label', on ? 'Stop recording (' + t + ')' : 'Record call');
      btn.title = btn.getAttribute('aria-label');
      const svg = btn.querySelector('svg');
      const path = btn.querySelector('svg path');
      if (path) path.setAttribute('d', on ? SQUARE : DOT);
      if (svg) {
        svg.style.color = on ? '#ff5a5f' : '';
        const title = svg.querySelector('title');
        if (title) title.textContent = on ? 'stop-recording' : 'record-call';
      }
    }

    // ---- housekeeping ----------------------------------------------------
    let missing = 0, lastPanel = null, autoDone = false;
    setInterval(() => {
      const panel = panelEl();
      if (panel) ensureButton(panel);
      if (state.active) updateButton();

      // The call window is gone: finish and save, whether or not anyone pressed stop.
      if (state.active && !panel) { if (++missing >= 3) stop(); } else missing = 0;

      if (panel !== lastPanel) { lastPanel = panel; autoDone = false; }
      const prefs = window.__waMedia || {};
      if (panel && prefs.autoRecord && !state.active && !autoDone &&
          panel.querySelector('button[aria-label*="Mute microphone" i], button[aria-label*="Unmute microphone" i]') &&
          [...panel.querySelectorAll('[aria-label]')].some((e) => /end-to-end/i.test(e.getAttribute('aria-label')))) {
        autoDone = true;                       // once per call, even if it fails or is stopped
        start(true);
      }
    }, 500);

    window.__relayRec = { start, stop, get active() { return state.active; } };
  }

  try {
    webFrame.executeJavaScript('(' + pageWorld.toString() + ')();');
  } catch (err) {
    console.warn('[Recording] injection failed:', err);
  }

  // The page world cannot reach Electron, so it posts messages; this side
  // forwards them to the main process (and the replies back).
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.relay !== 'rec') return;
    const m = e.data;
    if (m.type === 'open') {
      ipcRenderer.invoke('recording:open', { ext: m.ext, video: m.video, auto: m.auto })
        .then((r) => window.postMessage(Object.assign({ relay: 'rec-reply' }, r), '*'))
        .catch(() => window.postMessage({ relay: 'rec-reply', ok: false }, '*'));
    } else if (m.type === 'chunk') {
      ipcRenderer.send('recording:chunk', m.id, m.buf);
    } else if (m.type === 'close') {
      ipcRenderer.send('recording:close', m.id);
    }
  });
  // Quitting with a recording running: stop it so the file is complete.
  ipcRenderer.on('recording:flush', () => window.postMessage({ relay: 'rec-cmd', cmd: 'stop' }, '*'));
}

try {
  hookCallRecording();
} catch (e) {
  console.warn('hookCallRecording error:', e);
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
//  Camera: frames go through a GPU pipeline (denoise, face-weighted shadow lift,
//    white balance, sharpen). Nothing is written to the camera driver.
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
    // Filled in from the tray / Relay panel by the main process; all default to on.
    // The setter lets a running call react the moment noise suppression is toggled.
    let mediaPrefs = window.__waMedia || { video: true, audio: true, noise: true };
    const prefs = () => mediaPrefs;
    const noisePairs = new Set();               // { dry, wet } gains of each running mic chain
    const wantsNoise = () => mediaPrefs.noise !== false;
    Object.defineProperty(window, '__waMedia', {
      configurable: true,
      get: () => mediaPrefs,
      set(v) {
        mediaPrefs = v || mediaPrefs;
        for (const { dry, wet } of noisePairs) {
          const t = dry.context.currentTime;
          wet.gain.setTargetAtTime(wantsNoise() ? 1 : 0, t, 0.04);
          dry.gain.setTargetAtTime(wantsNoise() ? 0 : 1, t, 0.04);
        }
      }
    });

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

    // RNNoise (the neural suppressor behind Mozilla/Discord-style "krisp" filters),
    // run in an AudioWorklet. It expects 48 kHz. The worklet and its WebAssembly come
    // from the main process (src/vendor/rnnoise); blob: is allowed by WhatsApp's CSP.
    const ensureCtx = () => {
      if (!audioCtx || audioCtx.state === 'closed') {
        audioCtx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
      }
      return audioCtx;
    };

    async function prepareNoise() {
      const ctx = ensureCtx();
      if (!wantsNoise() || ctx.__rnn !== undefined) return;
      ctx.__rnn = null;                           // "tried": do not retry on every chain
      try {
        const R = window.__relay;
        if (!R) return;
        // A call must never wait on this: after 4 s it starts without noise suppression.
        const load = (async () => {
          const a = await R.call('rnnoise');
          const url = URL.createObjectURL(new Blob([a.worklet], { type: 'text/javascript' }));
          try { await ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
          return a.wasm.buffer.slice(a.wasm.byteOffset, a.wasm.byteOffset + a.wasm.byteLength);
        })();
        ctx.__rnn = await Promise.race([load, new Promise((_, no) => setTimeout(() => no(new Error('timed out')), 4000))]);
      } catch (e) {
        console.warn('[Relay] noise suppression unavailable:', e);
      }
    }

    function enhanceAudioTrack(raw) {
      const ctx = ensureCtx();
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});

      const src = ctx.createMediaStreamSource(new MediaStream([raw]));

      // Dry and wet paths meet at `head`, so the switch is a quick crossfade.
      const head = ctx.createGain();
      const dry = ctx.createGain();
      const wet = ctx.createGain();
      let rnn = null;
      if (ctx.__rnn) {
        rnn = new AudioWorkletNode(ctx, '@sapphi-red/web-noise-suppressor/rnnoise', {
          processorOptions: { maxChannels: 1, wasmBinary: ctx.__rnn }
        });
      }
      dry.gain.value = rnn && wantsNoise() ? 0 : 1;
      wet.gain.value = rnn && wantsNoise() ? 1 : 0;

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

      const pair = { dry, wet };
      const dest = ctx.createMediaStreamDestination();
      // Live voice translation (src/page/voice.js): the translated voice is mixed in here, and your own voice can be switched off.
      const gate = ctx.createGain();
      const synthIn = ctx.createGain();
      const voiceOut = {
        nextAt: 0, sources: new Set(),
        passthrough(on) { gate.gain.setTargetAtTime(on ? 1 : 0, ctx.currentTime, 0.03); },
        play(pcm, rate) {
          const buf = ctx.createBuffer(1, pcm.length, rate);
          buf.copyToChannel(pcm, 0);
          const s = ctx.createBufferSource();
          s.buffer = buf;
          s.__relayOwn = true;
          s.connect(synthIn);
          const at = Math.max(ctx.currentTime + 0.02, voiceOut.nextAt);
          s.start(at);
          voiceOut.nextAt = at + buf.duration;
          voiceOut.sources.add(s);
          s.onended = () => voiceOut.sources.delete(s);
          return voiceOut.nextAt - ctx.currentTime;
        },
        backlog() { return Math.max(0, voiceOut.nextAt - ctx.currentTime); },
        clear() { for (const s of voiceOut.sources) { try { s.stop(); } catch (e) { /* ended */ } } voiceOut.sources.clear(); voiceOut.nextAt = 0; }
      };
      Object.defineProperty(window, '__relayVoiceOut', { value: voiceOut, configurable: true, enumerable: false });
      // Tell the call recorder this plumbing is Relay's own, not call audio.
      window.__relayBuildingAudio = true;
      try {
        src.connect(dry);
        dry.connect(head);
        if (rnn) { src.connect(rnn); rnn.connect(wet); wet.connect(head); noisePairs.add(pair); }
        head.connect(highpass);
        highpass.connect(presence);
        presence.connect(compressor);
        compressor.connect(makeup);
        makeup.connect(limiter);
        limiter.connect(gate);
        gate.connect(dest);
        synthIn.connect(dest);
      } finally {
        window.__relayBuildingAudio = false;
      }

      chains++;
      const out = dest.stream.getAudioTracks()[0];
      return mirror(out, raw, () => {
        noisePairs.delete(pair);
        if (rnn) { try { rnn.port.postMessage('destroy'); } catch {} rnn.disconnect(); }
        src.disconnect();
        limiter.disconnect();
        if (window.__relayVoiceOut === voiceOut) { voiceOut.clear(); try { delete window.__relayVoiceOut; } catch (e) { /* ignore */ } }
        // Release the audio device when the last call / recording is over.
        if (--chains === 0 && audioCtx) {
          audioCtx.close().catch(() => {});
          audioCtx = null;
        }
      });
    }

    // ---- Camera ----------------------------------------------------------
    //
    // A webcam looking up at ceiling lights meters for the lights, so the face
    // comes out dark, flat and noisy. Every frame goes through a small GPU
    // pipeline instead of one brightness multiplier:
    //   1. denoise    edge-preserving 3x3 blur + motion-aware blend with the
    //                 previous frame (noise is random, a face is not)
    //   2. white balance  small correction from neutral mid-tones
    //   3. shadow lift   a gamma lift whose strength is measured on the CENTRE of
    //                 the picture, where the face is - bright walls and lamps
    //                 no longer fool it - and which never pushes whites past 1
    //   4. contrast, saturation, then an unsharp mask on the denoised image
    // Falls back to a plain canvas filter if WebGL2 is unavailable.

    const TARGET_CENTER_LUMA = 0.42;   // where a well exposed face sits (encoded). Lower than a flat
    // 'bright' look on purpose: lifting past this washes colour out.
    const MAX_LIFT = 1.5;

    const VERT = '#version 300 es\n' +
      'out vec2 vUv;\n' +
      'void main(){ vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);\n' +
      '  vUv = p; gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }';

    const FRAG_DENOISE = '#version 300 es\n' +
      'precision highp float;\n' +
      'uniform sampler2D uVideo; uniform sampler2D uPrev;\n' +
      'uniform vec2 uTexel; uniform float uFirst;\n' +
      'in vec2 vUv; out vec4 o;\n' +
      'float lum(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }\n' +
      'void main(){\n' +
      '  vec3 c = texture(uVideo, vUv).rgb; float lc = lum(c);\n' +
      '  float sigma = mix(0.09, 0.035, smoothstep(0.0, 0.5, lc));\n' +   // noisier in shadows
      '  vec3 acc = c; float wsum = 1.0;\n' +
      '  for (int dy = -1; dy <= 1; dy++) for (int dx = -1; dx <= 1; dx++) {\n' +
      '    if (dx == 0 && dy == 0) continue;\n' +
      '    vec3 n = texture(uVideo, vUv + vec2(float(dx), float(dy)) * uTexel).rgb;\n' +
      '    float d = lum(n) - lc;\n' +
      '    float w = exp(-(d * d) / (2.0 * sigma * sigma)) * ((dx == 0 || dy == 0) ? 1.0 : 0.7);\n' +
      '    acc += n * w; wsum += w; }\n' +
      '  vec3 s = mix(c, acc / wsum, 0.75);\n' +
      '  vec3 p = texture(uPrev, vUv).rgb;\n' +
      '  float wt = (1.0 - smoothstep(0.015, 0.09, abs(lum(s) - lum(p)))) * 0.55 * (1.0 - uFirst);\n' +
      '  o = vec4(mix(s, p, wt), 1.0);\n' +
      '}';

    const FRAG_TONE = '#version 300 es\n' +
      'precision highp float;\n' +
      'uniform sampler2D uT; uniform vec2 uTexel;\n' +
      'uniform float uLift; uniform float uContrast; uniform float uSat; uniform float uVib; uniform float uSharp; uniform vec3 uGain;\n' +
      'in vec2 vUv; out vec4 o;\n' +
      'void main(){\n' +
      '  vec3 c = texture(uT, vUv).rgb;\n' +
      '  vec3 b = c * 4.0\n' +
      '    + (texture(uT, vUv + vec2(uTexel.x, 0.0)).rgb + texture(uT, vUv - vec2(uTexel.x, 0.0)).rgb\n' +
      '     + texture(uT, vUv + vec2(0.0, uTexel.y)).rgb + texture(uT, vUv - vec2(0.0, uTexel.y)).rgb) * 2.0\n' +
      '    + texture(uT, vUv + uTexel).rgb + texture(uT, vUv - uTexel).rgb\n' +
      '    + texture(uT, vUv + vec2(uTexel.x, -uTexel.y)).rgb + texture(uT, vUv + vec2(-uTexel.x, uTexel.y)).rgb;\n' +
      '  b /= 16.0;\n' +
      '  vec3 detail = clamp(c - b, -0.06, 0.06);\n' +                    // clamped: no halos
      '  vec3 g = max(c * uGain, 0.0);\n' +
      '  float gl = dot(g, vec3(0.2126, 0.7152, 0.0722));\n' +
      // Lift the shadows and mid-tones where the face lives; leave deep blacks
      // black and bright walls / lamps exactly where the camera put them.
      '  float amount = smoothstep(0.02, 0.2, gl) * (1.0 - smoothstep(0.5, 0.92, gl));\n' +
      '  vec3 x = mix(g, pow(g, vec3(1.0 / uLift)), amount);\n' +
      '  x = mix(x, x * x * (3.0 - 2.0 * x), uContrast);\n' +
      '  float l = dot(x, vec3(0.2126, 0.7152, 0.0722));\n' +
      // Vibrance: muted colours gain more than ones that are already strong, so skin stays
      // natural while foliage, sky and clothes get their depth back. A lift thins colour
      // out, so the more it lifted, the more is given back.
      '  float mx = max(x.r, max(x.g, x.b)); float s0 = (mx - min(x.r, min(x.g, x.b))) / max(mx, 0.001);\n' +
      '  x = mix(vec3(l), x, (uSat + 0.22 * (uLift - 1.0)) * (1.0 + uVib * (1.0 - s0)));\n' +
      '  x += detail * uSharp * (0.8 + 0.5 * uLift);\n' +
      '  o = vec4(clamp(x, 0.0, 1.0), 1.0);\n' +
      '}';

    /**
     * Measures the picture ~3-5x a second and eases the correction so it never
     * pumps. What matters is the exposure of the FACE, not of the frame: a
     * webcam under ceiling lights has a dark face against bright walls, so the
     * frame average says "fine". Skin-coloured pixels near the centre are
     * metered; if there are none (camera pointed elsewhere) the darker part of
     * the centre is used instead.
     */
    function createMeter() {
      const probe = document.createElement('canvas');
      probe.width = 64;
      probe.height = 36;
      const pctx = probe.getContext('2d', { willReadFrequently: true });
      const m = { lift: 1, gain: [1, 1, 1], frame: 0, ready: false };
      m.update = function (video) {
        if (m.frame++ % 6) return;
        pctx.drawImage(video, 0, 0, 64, 36);
        const px = pctx.getImageData(0, 0, 64, 36).data;
        let skinW = 0, skinL = 0, skinN = 0, n = 0, ar = 0, ag = 0, ab = 0;
        const centre = [];
        for (let y = 0; y < 36; y++) {
          for (let x = 0; x < 64; x++) {
            const i = (y * 64 + x) * 4;
            const r = px[i], g = px[i + 1], b = px[i + 2];
            const l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
            const cx = (x + 0.5) / 64 - 0.5, cy = (y + 0.5) / 36 - 0.58;
            const w = Math.exp(-(cx * cx / (2 * 0.22 * 0.22) + cy * cy / (2 * 0.3 * 0.3)));
            if (w > 0.3) centre.push(l);
            // Skin in YCbCr, which is fairly stable across light levels.
            const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
            const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
            if (l > 0.06 && l < 0.8 && cb > 77 && cb < 127 && cr > 133 && cr < 173 && r > g && r > b) {
              skinW += w; skinL += w * l; skinN++;
            }
            // Neutral-ish mid-tones are what tell us about the colour cast.
            if (l > 0.25 && l < 0.85 && (Math.max(r, g, b) - Math.min(r, g, b)) < 36) {
              ar += r; ag += g; ab += b; n++;
            }
          }
        }
        let subject;
        if (skinN >= 40 && skinW > 0) {
          subject = skinL / skinW;
        } else {
          centre.sort((p, q) => p - q);
          subject = centre.length ? centre[Math.floor(centre.length * 0.35)] : TARGET_CENTER_LUMA;
        }
        subject = Math.max(subject, 0.04);
        const wanted = Math.min(MAX_LIFT, Math.max(1, Math.log(subject) / Math.log(TARGET_CENTER_LUMA)));
        // The first reading applies at once so the picture does not ease in slowly.
        m.lift = m.ready ? m.lift + (wanted - m.lift) * 0.25 : wanted;
        if (n > 64 * 36 * 0.04 && ar > 0 && ab > 0) {
          // Half-strength and narrow: enough to undo a bad cast, not to cool a golden-hour face.
          const clampG = (v) => 1 + (Math.min(1.08, Math.max(0.93, v)) - 1) * 0.5;
          const target = [clampG(ag / ar), 1, clampG(ag / ab)];
          for (let k = 0; k < 3; k++) m.gain[k] = m.ready ? m.gain[k] + (target[k] - m.gain[k]) * 0.15 : target[k];
        }
        m.ready = true;
      };
      return m;
    }

    function createGLRenderer() {
      const canvas = document.createElement('canvas');
      canvas.width = 1280;
      canvas.height = 720;
      const gl = canvas.getContext('webgl2', {
        alpha: false, antialias: false, depth: false, stencil: false, desynchronized: true
      });
      if (!gl) throw new Error('no webgl2');

      const half = gl.getExtension('EXT_color_buffer_half_float') || gl.getExtension('EXT_color_buffer_float');
      const compile = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
        return s;
      };
      const program = (frag) => {
        const p = gl.createProgram();
        gl.attachShader(p, compile(gl.VERTEX_SHADER, VERT));
        gl.attachShader(p, compile(gl.FRAGMENT_SHADER, frag));
        gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
        const u = {};
        const count = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
        for (let i = 0; i < count; i++) {
          const name = gl.getActiveUniform(p, i).name;
          u[name] = gl.getUniformLocation(p, name);
        }
        return { p, u };
      };
      const denoise = program(FRAG_DENOISE);
      const tone = program(FRAG_TONE);
      const vao = gl.createVertexArray();

      const texture = (w, h, float) => {
        const t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        if (float) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
        else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        return t;
      };

      let w = 0, h = 0, videoTex = null, hist = [], fbos = [], cur = 0, first = 1;
      const allocate = (nw, nh) => {
        w = nw; h = nh;
        canvas.width = w; canvas.height = h;
        videoTex = texture(w, h, false);
        hist = [texture(w, h, Boolean(half)), texture(w, h, Boolean(half))];
        fbos = hist.map((t) => {
          const f = gl.createFramebuffer();
          gl.bindFramebuffer(gl.FRAMEBUFFER, f);
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
          return f;
        });
        first = 1;
      };

      let lost = false;
      canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); lost = true; });
      canvas.addEventListener('webglcontextrestored', () => { lost = false; w = 0; });

      return {
        canvas,
        kind: 'webgl',
        draw(video, p) {
          if (lost || !video.videoWidth) return false;
          if (video.videoWidth !== w || video.videoHeight !== h) allocate(video.videoWidth, video.videoHeight);
          gl.bindVertexArray(vao);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, videoTex);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);

          // Pass 1: denoise into hist[cur], reading last frame from hist[1 - cur].
          gl.bindFramebuffer(gl.FRAMEBUFFER, fbos[cur]);
          gl.viewport(0, 0, w, h);
          gl.useProgram(denoise.p);
          gl.uniform1i(denoise.u.uVideo, 0);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, hist[1 - cur]);
          gl.uniform1i(denoise.u.uPrev, 1);
          gl.uniform2f(denoise.u.uTexel, 1 / w, 1 / h);
          gl.uniform1f(denoise.u.uFirst, first);
          gl.drawArrays(gl.TRIANGLES, 0, 3);

          // Pass 2: tone + sharpen to the canvas.
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.viewport(0, 0, w, h);
          gl.useProgram(tone.p);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, hist[cur]);
          gl.uniform1i(tone.u.uT, 0);
          gl.uniform2f(tone.u.uTexel, 1 / w, 1 / h);
          gl.uniform1f(tone.u.uLift, p.lift);
          gl.uniform1f(tone.u.uContrast, 0.22);
          gl.uniform1f(tone.u.uSat, 1.05);
          gl.uniform1f(tone.u.uVib, 0.3);
          gl.uniform1f(tone.u.uSharp, 0.9);
          gl.uniform3f(tone.u.uGain, p.gain[0], p.gain[1], p.gain[2]);
          gl.drawArrays(gl.TRIANGLES, 0, 3);

          cur = 1 - cur;
          first = 0;
          return true;
        }
      };
    }

    function create2DRenderer() {
      const canvas = document.createElement('canvas');
      canvas.width = 1280;
      canvas.height = 720;
      const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
      if (!ctx) throw new Error('no 2d context');
      return {
        canvas,
        kind: '2d',
        draw(video, p) {
          if (!video.videoWidth) return false;
          if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
          }
          const b = Math.min(1.7, 1 + (p.lift - 1) * 0.9);
          ctx.filter = 'brightness(' + b.toFixed(3) + ') contrast(1.14) saturate(1.16)';
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          return true;
        }
      };
    }

    /**
     * Earlier Relay builds wrote brightness 25 / contrast 18 into the camera
     * driver, where they stayed for every app, and left the picture flat and
     * washed out. Spot exactly that signature and put the controls back to
     * neutral. Cameras that are set to anything else are left alone.
     */
    async function resetStaleCameraSettings(raw) {
      try {
        const s = raw.getSettings();
        if (s.brightness !== 25 || s.contrast !== 18) return;
        const c = raw.getCapabilities();
        const at = (cap, f) => (cap ? Math.round(cap.min + (cap.max - cap.min) * f) : undefined);
        const adv = {};
        const set = (k, v) => { if (v !== undefined) adv[k] = v; };
        set('brightness', at(c.brightness, 0.5));
        set('contrast', at(c.contrast, 0.34));
        set('saturation', at(c.saturation, 0.64));
        set('sharpness', at(c.sharpness, 0.5));
        await raw.applyConstraints({ advanced: [adv] });
      } catch (e) { /* not every camera exposes these */ }
    }

    function enhanceVideoTrack(raw) {
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.srcObject = new MediaStream([raw]);

      let renderer;
      try {
        renderer = createGLRenderer();
      } catch (e) {
        console.warn('[Relay] GPU camera pipeline unavailable, using canvas filter:', e);
        renderer = create2DRenderer();
      }
      // captureStream(0) + requestFrame(): one output frame per camera frame,
      // not a fixed 30 fps clock that duplicates frames and wastes encoder time.
      const out = renderer.canvas.captureStream(0).getVideoTracks()[0];
      if (!out) throw new Error('no capture track');
      out.__relayLocal = true;      // lets Relay tell its own preview from the remote picture

      const meter = createMeter();
      let active = true;

      const schedule = () => {
        if (!active) return;
        if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(render);
        else requestAnimationFrame(render);
      };

      function render() {
        if (!active) return;
        if (video.videoWidth) {
          meter.update(video);
          if (renderer.draw(video, meter) && out.requestFrame) out.requestFrame();
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
      if (p.audio && stream.getAudioTracks().length) await prepareNoise();
      if (p.audio) for (const t of stream.getAudioTracks()) swap(stream, t, enhanceAudioTrack);
      // Remember the live microphone so a call recording can mix it in.
      const micTrack = stream.getAudioTracks()[0];
      if (micTrack) window.__relayMicTrack = micTrack;
      if (p.video) {
        for (const t of stream.getVideoTracks()) {
          await resetStaleCameraSettings(t);
          swap(stream, t, enhanceVideoTrack);
        }
      }
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

// ===========================================================================
// Calls.
//
// WhatsApp Web only offers calling to accounts with the server-side flag
// enable_web_calling; for everyone else the call button does nothing useful.
// The official Windows app always has calling, because it identifies itself as
// the Windows client. Relay is that client, so switch the flag on locally.
// This only changes what the page *offers*; whether a call connects is up to
// WhatsApp's servers. Toggle: tray > Enable calling.
//
// Page world, polled from the very start: WhatsApp's module loader appears a
// moment into boot and the flag must be patched before the call UI is built.
// ===========================================================================
function enableWebCalling(lazyEngine) {
  function pageWorld(opts) {
    if (window.__relayCalling) return;
    window.__relayCalling = true;
    let tries = 0;
    // WhatsApp logs an error each time a module is required before its
    // dependencies exist, so wait until the app shell has been drawn.
    const timer = setInterval(() => {
      if (!document.getElementById('app') || !document.getElementById('app').firstElementChild) return;
      if (++tries > 240) return clearInterval(timer);           // give up after ~60s
      try {
        const AB = window.require && window.require('WAWebABProps');
        if (!AB || typeof AB.getABPropConfigValue !== 'function') return;
        if (!AB.__relayPatched) {
          const original = AB.getABPropConfigValue;
          AB.getABPropConfigValue = function (key) {
            if (key === 'enable_web_calling') return true;
            // Boot the call engine on the first call, not at launch (idle memory).
            if (opts.lazyEngine && key === 'web_voip_deferred_boot_init') return true;
            // 0 = the control group: no "get the desktop app" empty-state banner.
            if (key === 'wa_web_growth_empty_state_upsell_variant_m1') return 0;
            return original.apply(this, arguments);
          };
          AB.__relayPatched = true;
        }
        // "Download WhatsApp for Windows to start making / returning calls" and the
        // other desktop-app nudges are all gated by one platform check that is
        // true for any Windows browser that is not the official app. Relay is the
        // desktop app, so the check says no and the nudges (and the cards with the
        // laptop-and-phone animation) never render.
        const U = window.require('WAWebDesktopUpsellUtils');
        if (U && !U.__relayPatched) {
          U.isWebUserOnSupportedWindowsOSForUWPAsync = () => Promise.resolve(false);
          U.isWebUserOnSupportedMacOSForCatalystAsync = () => Promise.resolve(false);
          U.__relayPatched = true;
        }
        clearInterval(timer);
      } catch (e) { /* module loader not ready yet */ }
    }, 250);
  }
  try {
    webFrame.executeJavaScript('(' + pageWorld.toString() + ')(' + JSON.stringify({ lazyEngine }) + ');');
  } catch (err) {
    console.warn('[Calls] flag patch failed:', err);
  }
}

let relayIconUri = '';
try {
  const features = ipcRenderer.sendSync('features:get');
  relayIconUri = features.icon || '';
  if (features.calling) enableWebCalling(Boolean(features.lazyEngine));
} catch (e) {
  console.warn('features:get failed:', e);
}

// The tray toggles arrive asynchronously; the page-world pipeline reads them
// when a call or recording actually asks for the devices, long after this
// resolves.
ipcRenderer.invoke('media:prefs')
  .then((p) => webFrame.executeJavaScript('window.__waMedia = ' + JSON.stringify({
    video: Boolean(p && p.video),
    audio: Boolean(p && p.audio),
    autoRecord: Boolean(p && p.autoRecord),
    noise: !p || p.noise !== false
  })))
  .catch(() => {});

// ===========================================================================

// ===========================================================================
// Relay panel bridge. The panel, translation and quick replies run in the page
// (src/page/*.js, delivered by the main process); this is their only way out.
// Channels are an allow-list, and replies go back by postMessage.
// ===========================================================================
const RELAY_CHANNELS = new Set([
  'state', 'set', 'translate-provider', 'translate-consent', 'key-prompt', 'key-clear',
  'translate', 'snippets', 'action', 'rnnoise',
  'caption-set', 'caption-start', 'caption-stop', 'caption-audio', 'proxy-set', 'wa-lang',
  'context-hint', 'addon-download', 'transcribe-pick', 'transcribe-clip', 'transcribe-save', 'voice-set', 'voice-forget', 'voice-start', 'voice-stop', 'voice-clip'
]);

function installRelayPanel() {
  window.addEventListener('message', async (e) => {
    const d = e.data;
    if (e.source !== window || !d || d.__relay !== 'req' || !RELAY_CHANNELS.has(d.ch)) return;
    let result, error;
    try {
      result = await ipcRenderer.invoke('relay:' + d.ch, ...(Array.isArray(d.args) ? d.args : []));
    } catch (err) {
      error = String((err && err.message) || err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
    }
    window.postMessage({ __relay: 'res', id: d.id, result, error }, location.origin);
  });
  ipcRenderer.on('relay:state', (_e, st) => {
    window.postMessage({ __relay: 'evt', ch: 'state', data: st }, location.origin);
  });
  // Other pushes from the main process (caption status, model download progress).
  ipcRenderer.on('relay:event', (_e, ch, data) => {
    if (typeof ch === 'string') window.postMessage({ __relay: 'evt', ch, data }, location.origin);
  });
  try {
    const src = ipcRenderer.sendSync('page:src');
    if (src) webFrame.executeJavaScript(src);
  } catch (err) {
    console.warn('[Relay] panel failed to load:', err);
  }
}

// ===========================================================================
// Files copied in Explorer -> Ctrl+V in a chat.
//
// Chromium hands the page nothing for files copied in Windows Explorer, so WhatsApp sees an empty
// paste. When a real paste arrives with no text, no picture and no files, the main process reads the
// copied files from Windows (src/main.js, 'clipboard:get-files') and they are re-delivered as an
// ordinary paste of File objects, which WhatsApp turns into its preview ("send 2 files").
// Plain text and screenshots never come here: WhatsApp handles those itself.
// ===========================================================================
function hookClipboardFiles() {
  let busy = false;
  window.addEventListener('paste', async (e) => {
    if (!e.isTrusted || busy) return;                                       // a real Ctrl+V or menu paste only - never one a script made up
    const cd = e.clipboardData;
    if (cd && ((cd.files && cd.files.length) || [...(cd.types || [])].some((t) => /^(text\/|image\/)/.test(t)))) return;
    busy = true;
    try {
      const { files, skipped } = (await ipcRenderer.invoke('clipboard:get-files')) || {};
      if (skipped) window.postMessage({ __relay: 'evt', ch: 'toast', data: skipped + (skipped === 1 ? ' file is' : ' files are') + ' too large to paste (over 100 MB). Use the attach button.' }, location.origin);
      if (!files || !files.length) return;
      const dt = new DataTransfer();
      for (const f of files) dt.items.add(new File([f.buffer], f.name, { type: f.type, lastModified: f.lastModified }));
      const active = document.activeElement;
      const target = (active && active.isContentEditable && active) ||
        document.querySelector('footer [contenteditable="true"]') || document.querySelector('#main [contenteditable="true"]') || active || document.body;
      target.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, composed: true, clipboardData: dt }));
    } catch (err) {
      console.warn('[Relay] pasting copied files failed:', err && err.message);
    } finally {
      busy = false;
    }
  }, true);
}

window.addEventListener('DOMContentLoaded', () => {
  // Pop-out windows (about:blank, filled in by WhatsApp) need none of this.
  if (location.origin !== 'https://web.whatsapp.com') return;
  hookClipboardFiles();
  watchBadge();
  hookNotifications();
  watchForBrowserOnly();
  setupLayout();
  installRelayPanel();
});
