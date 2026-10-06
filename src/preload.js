'use strict';

const { ipcRenderer, webFrame } = require('electron');

// ===========================================================================
// Unread badge.
// WhatsApp Web puts the count in the document title as "(3) WhatsApp" and, on
// newer builds, also calls navigator.setAppBadge. Watch both.
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

  if (navigator.setAppBadge) {
    const setBadge = navigator.setAppBadge.bind(navigator);
    const clearBadge = navigator.clearAppBadge.bind(navigator);
    navigator.setAppBadge = (n) => { report(Number(n) || 0); return setBadge(n); };
    navigator.clearAppBadge = () => { report(0); return clearBadge(); };
  }
}

// ===========================================================================
// Clicking a native notification or service-worker message should bring the
// window forward to the front of the screen.
// ===========================================================================
function hookNotifications() {
  // Listen for the activation event dispatched from the page context
  
    window.addEventListener('wa-new-notification', () => {
      ipcRenderer.send('flash-window');
    });

    window.addEventListener('wa-activate-window', () => {
    ipcRenderer.send('activate-window');
  });

  // Inject a script into the page's main JavaScript context so that
  // window.Notification, window.focus, and navigator.serviceWorker message
  // handlers are hooked directly in WhatsApp Web's own world (bypassing
  // contextIsolation boundaries).
  const script = document.createElement('script');
  script.textContent = `
    (() => {
      function notifyActivation() {
        window.dispatchEvent(new CustomEvent('wa-activate-window'));
      }

      // 1. Hook window.focus: when WhatsApp or notification handler focuses the window
      const origFocus = window.focus;
      window.focus = function() {
        notifyActivation();
        return origFocus.apply(this, arguments);
      };

      // 2. Hook Notification constructor in page context
      const NativeNotification = window.Notification;
      if (NativeNotification) {
        function AppNotification(title, options) {
          const n = new NativeNotification(title, options);
          window.dispatchEvent(new CustomEvent("wa-new-notification"));
          n.addEventListener('click', notifyActivation);
          return n;
        }
        AppNotification.prototype = NativeNotification.prototype;
        AppNotification.permission = NativeNotification.permission;
        if (NativeNotification.requestPermission) {
          AppNotification.requestPermission = NativeNotification.requestPermission.bind(NativeNotification);
        }
        Object.setPrototypeOf(AppNotification, NativeNotification);
        window.Notification = AppNotification;
      }

      // 3. Hook ServiceWorker messages (WhatsApp Web ServiceWorker notification clicks)
      if (navigator.serviceWorker) {
        navigator.serviceWorker.addEventListener('message', () => {
          notifyActivation();
        });
      }
    })();
  `;
  (document.head || document.documentElement).appendChild(script);
  script.remove();
}

// ===========================================================================
// "Get WhatsApp for Windows" upsell.
//
// We *are* the Windows app, so the banner is noise. Matching on class names is
// hopeless — they're generated — so we match the promo text and the download
// link, then hide the smallest enclosing banner. Anything inside a chat row or
// the conversation pane is left alone, so a message that happens to contain the
// same words is never touched.
// ===========================================================================
const PROMO_TEXT = /^\s*(get|download) whatsapp for (windows|mac|desktop)\b/i;
const PROMO_LINK =
  'a[href*="whatsapp.com/download"], a[href*="/download/"], a[download]';
const CHAT_CONTENT = '[role="row"], [role="listitem"], [role="article"], #main';
const MAX_BANNER_HEIGHT = 200;

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

function hidePromo(el) {
  if (!el || el.closest(CHAT_CONTENT)) return;
  const root = bannerRoot(el);
  if (root === document.body || root.id === 'pane-side' || root.id === 'app') return;
  root.dataset.waHidden = '';
  root.style.setProperty('display', 'none', 'important');
}

/** Hide any upsell inside `root` (which may itself be the banner). */
function stripPromos(root) {
  root = root || document;

  if (root.matches && root.matches(PROMO_LINK)) hidePromo(root);
  if (!root.querySelectorAll) return;

  for (const link of root.querySelectorAll(PROMO_LINK)) hidePromo(link);

  // Text pass, for the variants rendered as a button rather than a link.
  for (const el of root.querySelectorAll('span, div[role="button"], button')) {
    if (el.childElementCount === 0 && PROMO_TEXT.test(el.textContent)) hidePromo(el);
  }
}

/**
 * Switching chats remounts the sidebar, which re-inserts the banner. A timer
 * alone lets it flash until the next sweep, so hide it the moment it is added:
 * MutationObserver callbacks run before the browser paints, so nothing shows.
 *
 * Message nodes are by far the most common mutation, and the banner never lives
 * inside one, so skipping them keeps this cheap on a busy conversation.
 */
function watchForPromos() {
  new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.closest && node.closest(CHAT_CONTENT)) continue;
        stripPromos(node);
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
}

// ===========================================================================
// WhatsApp's 1px hairline dividers.
//
// Tall panels carry a `border-left: 1px rgba(255,255,255,.1)` that reads as a
// faint vertical line between the rail, the chat list and the conversation.
// We only neutralise the colour, never the width, so nothing reflows.
// ===========================================================================
function stripHairlines() {
  for (const el of document.querySelectorAll('div, header, section, span, aside, [data-wa-pane]')) {
    const s = getComputedStyle(el);

    // 1. Check all border sides (left and right) with ANY scale factor (e.g. 1px, 1.09545px, 1.25px)
    for (const side of ['Left', 'Right']) {
      const bw = s['border' + side + 'Width'];
      const w = parseFloat(bw);
      if (w >= 0.5 && w <= 3.5) {
        el.style.setProperty('border-' + side.toLowerCase() + '-color',
                             'transparent', 'important');
      }
    }

    // 2. Some WhatsApp builds use box-shadow instead of border for the divider
    const shadow = s.boxShadow;
    if (shadow && shadow !== 'none' && /(?:1|2|0\.[5-9]|1\.[0-9]+)px/.test(shadow)) {
      el.style.setProperty('box-shadow', 'none', 'important');
    }

    // 3. Some builds use outline
    const ow = parseFloat(s.outlineWidth);
    if (ow >= 0.5 && ow <= 3.5) {
      el.style.setProperty('outline-color', 'transparent', 'important');
      el.style.setProperty('outline-width', '0px', 'important');
    }
  }
}

// ===========================================================================
// Resizable sidebar / chat split.
//
// WhatsApp Web hard-codes the chat list to a fixed proportion of the window
// with no drag handle. Rather than guess at their generated class names — which
// change constantly — we locate the sidebar column structurally at runtime and
// override its width through a CSS custom property.
// ===========================================================================
const MIN_WIDTH = 260;
const MAX_FRACTION = 0.6;
const DEFAULT_FRACTION = 0.3;

let splitter = null;
let panes = null;   // { column, row }
let width = 0;
let translucent = false;

const CSS = `
  [data-wa-hidden] { display: none !important; }

  /* Kill all divider borders, outlines and box shadows on panes and siblings */
  [data-wa-pane],
  [data-wa-pane="side"],
  [data-wa-pane="main"],
  [data-wa-pane="preview"],
  [data-wa-pane="rail"],
  [data-wa-pane="side"] + div,
  [data-wa-pane="side"] ~ div,
  #main,
  #pane-side,
  #side {
    border-left: none !important;
    border-right: none !important;
    border-left-width: 0 !important;
    border-right-width: 0 !important;
    border-left-color: transparent !important;
    border-right-color: transparent !important;
    box-shadow: none !important;
    outline: none !important;
  }

  /* Navigation rail: authentic Windows Acrylic glass with top accent glow */
  [data-wa-pane="rail"],
  header[data-testid="chatlist-header"]:first-child {
    position: relative !important;
    z-index: 2 !important;
    isolation: isolate !important;
    contain: paint !important;
    box-sizing: border-box !important;
    min-width: 60px !important;
    background: linear-gradient(
      180deg,
      rgba(var(--wa-accent-rgb, 191, 86, 17), 0.72) 0px,
      rgba(var(--wa-accent-rgb, 191, 86, 17), 0.45) 35px,
      rgba(var(--wa-accent-rgb, 191, 86, 17), 0.20) 75px,
      rgba(var(--wa-accent-rgb, 191, 86, 17), 0.06) 120px,
      rgba(24, 26, 28, 0.85) 170px,
      rgba(18, 20, 22, 0.94) 100%
    ) !important;
    backdrop-filter: blur(24px) saturate(180%) !important;
    -webkit-backdrop-filter: blur(24px) saturate(180%) !important;
    border-right: 1px solid rgba(255, 255, 255, 0.06) !important;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.18) !important;
  }

  /* Transparent backgrounds on rail inner elements so the top glow shines through */
  [data-wa-pane="rail"] > div,
  [data-wa-pane="rail"] nav,
  [data-wa-pane="rail"] header,
  header[data-testid="chatlist-header"]:first-child > div {
    background-color: transparent !important;
    background: transparent !important;
  }

  /* Rail icons: clean alignment and WinUI 3 hover/active glass pills */
  [data-wa-pane="rail"] [role="button"],
  header[data-testid="chatlist-header"]:first-child [role="button"] {
    border-radius: 8px !important;
    transition: background-color 0.15s ease, transform 0.1s ease !important;
  }
  [data-wa-pane="rail"] [role="button"]:hover,
  header[data-testid="chatlist-header"]:first-child [role="button"]:hover {
    background-color: rgba(255, 255, 255, 0.08) !important;
  }
  [data-wa-pane="rail"] [role="button"][aria-selected="true"],
  header[data-testid="chatlist-header"]:first-child [role="button"][aria-selected="true"] {
    background-color: rgba(var(--wa-accent-rgb, 191, 86, 17), 0.32) !important;
    box-shadow: inset 0 0 0 1px rgba(var(--wa-accent-rgb, 191, 86, 17), 0.50) !important;
  }

  /* Full-width top accent glow across entire window matching DWMBlurGlass */
  #app::before {
    content: '' !important;
    position: fixed !important;
    top: 0 !important;
    left: 0 !important;
    right: 0 !important;
    height: 38px !important;
    background: linear-gradient(
      180deg,
      rgba(var(--wa-accent-rgb, 191, 86, 17), 0.40) 0px,
      rgba(var(--wa-accent-rgb, 191, 86, 17), 0.15) 16px,
      transparent 100%
    ) !important;
    pointer-events: none !important;
    z-index: 9999 !important;
  }

  /* Top header orange glow gradient matching Task Manager & DWMBlurGlass */
  [data-wa-pane="side"] > header,
  [data-wa-pane="side"] header[data-testid="chatlist-header"],
  [data-wa-pane="side"] > div:first-child > header,
  [data-wa-pane="side"] > div:first-child > div:first-child > header,
  #main > header,
  [data-wa-pane="main"] > header {
    background: linear-gradient(
      180deg,
      rgba(var(--wa-accent-rgb, 191, 86, 17), 0.45) 0px,
      rgba(var(--wa-accent-rgb, 191, 86, 17), 0.20) 30px,
      rgba(var(--wa-accent-rgb, 191, 86, 17), 0.05) 60px,
      rgba(17, 27, 33, 0.96) 90px,
      var(--wa-surface, #111b21) 100%
    ) !important;
  }
  [data-wa-pane="side"] header > div,
  #main > header > div {
    background-color: transparent !important;
    background: transparent !important;
  }

  /* Drag region for frameless window */
  header, [data-wa-pane="rail"], [data-wa-pane="side"] header {
    -webkit-app-region: drag !important;
  }
  
  /* Prevent overlap with titleBarOverlay window controls (minimize, maximize, close) on the right */
  #main > header {
    padding-right: 140px !important;
  }


  /* Minimal Scrollbars */
  ::-webkit-scrollbar { width: 4px !important; height: 4px !important; }
  ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1) !important; border-radius: 4px !important; }
  ::-webkit-scrollbar-track { background: transparent !important; }

  /* Sidebar fading for inactive chats */
  [data-wa-pane="side"]:has([aria-selected="true"]) [role="row"]:not(:has([aria-selected="true"])) {
    opacity: 0.5;
    transition: opacity 0.3s ease;
    filter: grayscale(0.5);
  }
  [data-wa-pane="side"] [role="row"]:hover {
    opacity: 1 !important;
    filter: none !important;
  }

  /* Active chat glow */
  [data-wa-pane="side"] [role="row"]:has([aria-selected="true"]) {
    box-shadow: 0 0 15px rgba(255, 255, 255, 0.05) inset;
    border-left: 3px solid rgba(255, 255, 255, 0.3);
    background: rgba(255,255,255,0.02);
    transition: all 0.3s ease;
  }


  /* AURA / TELEGRAM UI THEME */
  :root {
    /* Main Dark Theme Colors - Telegram Desktop Night Mode */
    --background-default: #0e1621 !important;
    --background-default-hover: #202b36 !important;
    --background-default-active: #2b5278 !important;
    --panel-header-background: #17212b !important;
    --panel-background: #17212b !important;
    --panel-background-hover: #202b36 !important;
    --panel-background-active: #2b5278 !important;
    
    --message-in: #182533 !important;
    --message-out: #2b5278 !important;
    --outgoing-background: #2b5278 !important;
    --incoming-background: #182533 !important;
    
    --compose-input-background: #17212b !important;
    --compose-primary: #ffffff !important;
    --compose-panel-background: #0e1621 !important;
    
    --teal: #5288c1 !important;
    --teal-light: #5288c1 !important;
    --primary: #5288c1 !important;
    --primary-strong: #5288c1 !important;
    
    --system-message-background: rgba(23, 33, 43, 0.6) !important;
    --system-message-text: #8e9bb0 !important;
  }

  /* Chat Bubbles - Telegram style (12px rounded) */
  [data-testid="msg-container"] {
    border-radius: 12px !important;
    box-shadow: 0 1px 2px rgba(0,0,0,0.15) !important;
  }
  
  /* Remove chat background doodle and replace with gradient */
  [data-asset-chat-background-dark] { display: none !important; }
  ._33LGR, [data-wa-pane="main"] > div:nth-child(2) {
    background: linear-gradient(135deg, #0e1621 0%, #17212b 100%) !important;
  }

  /* Input Field - Pill shape */
  [data-testid="conversation-compose-box-input"] {
    border-radius: 24px !important;
    padding-left: 20px !important;
    padding-right: 20px !important;
    background-color: #17212b !important;
    border: 1px solid rgba(255,255,255,0.05) !important;
    box-shadow: 0 1px 3px rgba(0,0,0,0.1) !important;
  }

  /* Chat List / Folders Filter */
  [data-testid="filter-list"] {
    padding-top: 10px !important;
    padding-bottom: 10px !important;
    background: #17212b !important;
    border-bottom: 1px solid rgba(0,0,0,0.2) !important;
  }
  [data-testid="filter-list"] button {
    border-radius: 8px !important;
    background: rgba(255,255,255,0.05) !important;
    font-weight: 500 !important;
    transition: all 0.2s ease !important;
  }
  [data-testid="filter-list"] button[aria-pressed="true"] {
    background: #2b5278 !important;
    color: #fff !important;
  }

  /* Adjust our previously added active chat glow for Telegram Blue */
  [data-wa-pane="side"] [role="row"]:has([aria-selected="true"]) {
    box-shadow: 0 0 15px rgba(82, 136, 193, 0.15) inset !important;
    border-left: 3px solid #5288c1 !important;
    background: #2b5278 !important;
    transition: all 0.2s ease;
  }
  
  /* Floating Action Button (New Chat) adjustment */
  [data-testid="chat-list"] button[title="New chat"] {
    background-color: #5288c1 !important;
  }

  /* Privacy Blur class */
  body.privacy-blur-active .message-in,
  body.privacy-blur-active .message-out,
  body.privacy-blur-active [data-testid="chat-list"] img,
  body.privacy-blur-active [data-testid="chat-list"] [dir="ltr"] {
    filter: blur(5px);
    transition: filter 0.3s ease;
  }
  body.privacy-blur-active .message-in:hover,
  body.privacy-blur-active .message-out:hover,
  body.privacy-blur-active [data-testid="chat-list"] [role="row"]:hover img,
  body.privacy-blur-active [data-testid="chat-list"] [role="row"]:hover [dir="ltr"] {
    filter: blur(0px);
  }

  /* Exclude buttons from drag region so they remain clickable */
  button, [role="button"], input, a, [data-testid="chat-list-search"] {
    -webkit-app-region: no-drag !important;
  }

  /* Sidebar column */
  [data-wa-pane="side"] {
    width: var(--wa-side-width) !important;
    min-width: var(--wa-side-width) !important;
    max-width: var(--wa-side-width) !important;
    flex: 0 0 var(--wa-side-width) !important;
    background-color: transparent !important;
    border-right: none !important;
    border-right-color: transparent !important;
    box-shadow: none !important;
  }

  /* Main conversation column */
  [data-wa-pane="main"] {
    flex: 1 1 auto !important;
    width: auto !important;
    min-width: 0 !important;
    background-color: transparent !important;
    border-left: none !important;
    border-left-color: transparent !important;
    box-shadow: none !important;
  }

  #main {
    border-left: none !important;
    border-left-color: transparent !important;
    box-shadow: none !important;
  }

  /* When an attachment preview (document, image, video, media) is open,
     hide the conversation pane so the preview cleanly fills the area
     directly after the contacts sidebar instead of squishing #main. */
  [data-wa-preview-active] #main,
  [data-wa-preview-active] [data-wa-pane="main"] {
    display: none !important;
  }
  [data-wa-pane="preview"] {
    flex: 1 1 auto !important;
    width: auto !important;
    min-width: 0 !important;
  }

  /* The chat list reserves a scrollbar gutter and paints a faint white thumb
     in it. Hide the thumb unless the list is hovered — this is the thin light
     line that otherwise sits between the panes. Only the non-hover state is
     overridden, so WhatsApp's own colour (and the light theme's) still applies
     on hover. */
  #pane-side:not(:hover) {
    scrollbar-color: transparent transparent !important;
  }
  #pane-side:not(:hover)::-webkit-scrollbar-thumb {
    background: transparent !important;
    background-color: transparent !important;
  }

  /* Sits just outside the sidebar, never over its scrollbar, so the list can
     still be scrolled by dragging. Sits below modals, lightboxes, and dialogs. */
  #wa-splitter {
    position: fixed;
    top: 0;
    bottom: 0;
    width: 6px;
    z-index: 5;
    cursor: col-resize;
    background: transparent;
  }
  #wa-splitter::after {
    content: "";
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    width: 3px;
    background: #21c063;
    opacity: 0;
    transition: opacity .12s ease-out;
  }
  #wa-splitter:hover::after,
  #wa-splitter[data-dragging]::after { opacity: 1; }
  html[data-wa-dragging] * {
    cursor: col-resize !important;
    user-select: none !important;
  }

  /* Completely hide splitter when any media viewer, image lightbox, dialog, or modal is open */
  body:has([data-animate-media-viewer]) #wa-splitter,
  body:has([data-testid*="media-viewer"]) #wa-splitter,
  body:has([data-testid*="image-viewer"]) #wa-splitter,
  body:has([data-testid*="visual-media-viewer"]) #wa-splitter,
  body:has([data-testid*="media-preview"]) #wa-splitter,
  body:has([data-wa-preview-active]) #wa-splitter,
  body:has([role="dialog"]) #wa-splitter,
  body:has([aria-modal="true"]) #wa-splitter,
  body:has([aria-label*="Media viewer" i]) #wa-splitter,
  body:has([aria-label*="Photo" i][role="dialog"]) #wa-splitter,
  body:has(div[tabindex="-1"][style*="z-index"]) #wa-splitter {
    display: none !important;
    pointer-events: none !important;
    visibility: hidden !important;
    opacity: 0 !important;
  }
`;

/**
 * Find the sidebar column and the flex row that holds it.
 *
 * #pane-side is the chat list, but the element that actually carries the width
 * is some ancestor of it. Walk up until the parent spans (nearly) the whole app
 * — that parent is the row, and the child we stopped on is the column.
 */
function locatePanes() {
  const side = document.getElementById('pane-side');
  const root = document.getElementById('app');
  if (!side || !root) return null;

  const full = root.getBoundingClientRect().width;
  if (!full) return null;

  let column = side;
  while (column.parentElement && column.parentElement !== root) {
    if (column.parentElement.getBoundingClientRect().width > full * 0.9) break;
    column = column.parentElement;
  }
  const row = column.parentElement;
  if (!row || row === column) return null;

  return { column, row };
}

function markPanes() {
  const found = locatePanes();
  if (!found) return false;

  found.column.dataset.waPane = 'side';

  const mainEl = document.getElementById('main');
  let hasSendPreview = false;

  for (const sibling of found.row.children) {
    if (sibling === found.column) continue;

    // The row also holds drawers, the media viewer and a toast container.
    const position = getComputedStyle(sibling).position;
    if (position === 'absolute' || position === 'fixed') continue;

    const w = sibling.getBoundingClientRect().width;
    if (sibling === mainEl || (mainEl && sibling.contains(mainEl))) {
      sibling.dataset.waPane = 'main';
    } else if (w > 120) {
      // Check if this sibling is an attachment preview / send drawer / media viewer
      const isPreview = sibling.querySelector('[data-icon="send"], button[aria-label*="send" i], [data-icon="x"], button[aria-label*="close" i]') ||
                        sibling.querySelector('[data-animate-media-viewer="true"], [data-animate-drawer-right="true"]');
      if (isPreview) {
        sibling.dataset.waPane = 'preview';
        hasSendPreview = true;
      } else {
        sibling.dataset.waPane = 'main';
      }
    } else if (w > 0) {
      sibling.dataset.waPane = 'rail';   // the narrow icon/profile strip
    }
  }

  if (hasSendPreview && mainEl) {
    found.row.dataset.waPreviewActive = '';
  } else {
    delete found.row.dataset.waPreviewActive;
  }

  markTranslucency(found);

  panes = found;
  return true;
}

/**
 * Let the window's acrylic backdrop show through the icon rail.
 *
 * Everything behind the rail has to be transparent for the blur to be visible,
 * which means clearing the app's root backgrounds — so we hand the chat list an
 * explicit opaque background of its own, sampled from whatever the current
 * theme was already painting. That keeps the effect confined to the rail.
 */
function markTranslucency(found) {
  if (!translucent) return;

  const surface = getComputedStyle(found.row).backgroundColor;
  if (surface && !/rgba\(0, 0, 0, 0\)/.test(surface)) {
    document.documentElement.style.setProperty('--wa-surface', surface);
  }

  const rail = found.row.querySelector('[data-wa-pane="rail"]') || found.row.querySelector('header');
  if (rail) {
    rail.dataset.waPane = 'rail';
  }
  document.documentElement.dataset.waTranslucent = '';
}

function clamp(px) {
  const max = Math.max(MIN_WIDTH, window.innerWidth * MAX_FRACTION);
  return Math.round(Math.min(max, Math.max(MIN_WIDTH, px)));
}

function applyWidth(px) {
  width = clamp(px);
  document.documentElement.style.setProperty('--wa-side-width', width + 'px');
  positionSplitter();
}

function positionSplitter() {
  if (!splitter || !panes) return;
  const isModalOpen = Boolean(document.querySelector(
    '[data-animate-media-viewer], [data-testid*="media-viewer"], [data-testid*="image-viewer"], [data-testid*="visual-media-viewer"], [data-testid*="media-preview"], [data-wa-preview-active], [role="dialog"], [aria-modal="true"], [aria-label*="Media viewer" i], [aria-label*="Photo" i][role="dialog"], div[tabindex="-1"][style*="z-index"]'
  ));
  if (isModalOpen) {
    splitter.style.display = 'none';
    splitter.style.visibility = 'hidden';
    return;
  }

  // Detect any full-screen lightbox or modal overlay attached to body or #app
  const appRoot = document.getElementById('app');
  const candidates = [...Array.from(document.body.children), ...(appRoot ? Array.from(appRoot.children) : [])];
  
  const hasFullscreenOverlay = candidates.some(el => {
    if (el === splitter || el.id === 'app' || el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || el.id === 'main' || el.id === 'pane-side') return false;
    const s = window.getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    
    // Check if it's an overlay covering the screen (e.g. image viewer)
    const zIndex = parseInt(s.zIndex);
    if (!isNaN(zIndex) && zIndex < 5) return false; // Ignore low z-index elements

    const width = parseFloat(s.width) || el.getBoundingClientRect().width;
    const height = parseFloat(s.height) || el.getBoundingClientRect().height;
    
    return (s.position === 'fixed' || s.position === 'absolute') &&
           width >= window.innerWidth * 0.7 &&
           height >= window.innerHeight * 0.7;
  });
  if (hasFullscreenOverlay) {
    splitter.style.display = 'none';
    splitter.style.visibility = 'hidden';
    return;
  }

  const rect = panes.column.getBoundingClientRect();
  if (!rect.width) {
    splitter.style.display = 'none';
    splitter.style.visibility = 'hidden';
    return;
  }
  splitter.style.display = '';
  splitter.style.visibility = '';
  splitter.style.left = Math.round(rect.right - 3) + 'px';
  splitter.style.top = Math.round(rect.top) + 'px';
  splitter.style.height = Math.round(rect.height) + 'px';
}

function createSplitter() {
  splitter = document.createElement('div');
  splitter.id = 'wa-splitter';
  splitter.title = 'Drag to resize · double-click to reset';
  document.body.appendChild(splitter);

  splitter.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !panes) return;
    e.preventDefault();
    const left = panes.column.getBoundingClientRect().left;
    splitter.setPointerCapture(e.pointerId);
    splitter.dataset.dragging = '';
    document.documentElement.dataset.waDragging = '';

    const onMove = (ev) => applyWidth(ev.clientX - left);
    const onUp = () => {
      splitter.removeEventListener('pointermove', onMove);
      splitter.removeEventListener('pointerup', onUp);
      delete splitter.dataset.dragging;
      delete document.documentElement.dataset.waDragging;
      ipcRenderer.send('pane-width:set', width);
    };
    splitter.addEventListener('pointermove', onMove);
    splitter.addEventListener('pointerup', onUp);
  });

  splitter.addEventListener('dblclick', () => {
    applyWidth(window.innerWidth * DEFAULT_FRACTION);
    ipcRenderer.send('pane-width:set', width);
  });
}

async function setupPanes() {
  const style = document.createElement('style');
  style.id = 'wa-style';
  style.textContent = CSS;
  document.head.appendChild(style);

  createSplitter();

ipcRenderer.on('privacyBlur', (e, state) => {
  if (state) document.body.classList.add('privacy-blur-active');
  else document.body.classList.remove('privacy-blur-active');
});

ipcRenderer.invoke('privacyBlur:get').then(state => {
  if (state) document.body.classList.add('privacy-blur-active');
});


  translucent = await ipcRenderer.invoke('translucent:get');
  try {
    const accent = await ipcRenderer.invoke('system:accent-color');
    if (accent) {
      document.documentElement.style.setProperty('--wa-accent-color', accent.hex);
      document.documentElement.style.setProperty('--wa-accent-rgb', accent.rgb);
    }
  } catch {}

  ipcRenderer.on('accent-color-updated', (_e, accent) => {
    if (accent) {
      document.documentElement.style.setProperty('--wa-accent-color', accent.hex);
      document.documentElement.style.setProperty('--wa-accent-rgb', accent.rgb);
    }
  });

  const saved = await ipcRenderer.invoke('pane-width:get');
  const initial = saved || window.innerWidth * DEFAULT_FRACTION;

  function refreshLayout() {
    stripHairlines();
    if (markPanes()) {
      applyWidth(width || initial);
      positionSplitter();
    }
  }

  // The chat list mounts well after first paint; keep looking until it shows up.
  const ready = setInterval(() => {
    if (markPanes()) {
      clearInterval(ready);
      applyWidth(initial);
      stripHairlines();
      new ResizeObserver(positionSplitter).observe(panes.column);
      new MutationObserver(() => {
        if (markPanes()) positionSplitter();
        stripHairlines();
      }).observe(panes.row, { childList: true });
      new MutationObserver(() => {
        positionSplitter();
      }).observe(document.body, { childList: true });
      // React remounts the layout on navigation, so re-mark periodically and
      // re-hide the upsell. One cheap timer covers both.
      setInterval(() => {
        if (markPanes()) positionSplitter();
        stripPromos();
        stripHairlines();
      }, 1500);
    }
  }, 400);

  window.addEventListener('resize', refreshLayout);
  document.addEventListener('fullscreenchange', () => {
    setTimeout(refreshLayout, 50);
    setTimeout(refreshLayout, 200);
  });
  ipcRenderer.on('window-resized', () => {
    refreshLayout();
    setTimeout(refreshLayout, 150);
  });
}

// ===========================================================================
// Native File Copy-Paste (Windows Explorer -> WhatsApp)
// Allows copying any file(s) in Windows File Explorer (Ctrl+C) and pasting
// them directly into WhatsApp (Ctrl+V) just like the official desktop app.
// ===========================================================================
let isPastingFiles = false;

function hookClipboardFiles() {
  async function handlePasteEvent(e) {
    if (e.__waSyntheticPaste) return;

    // If browser clipboard already contains files (e.g. copied image/screenshot), let WhatsApp handle it
    if (e.clipboardData && e.clipboardData.files && e.clipboardData.files.length > 0) {
      return;
    }

    if (isPastingFiles) return;

    try {
      isPastingFiles = true;
      const files = await ipcRenderer.invoke('clipboard:get-files');
      if (!files || files.length === 0) return;

      const dt = new DataTransfer();
      for (const item of files) {
        const uint8 = new Uint8Array(item.buffer);
        const file = new File([uint8], item.name, {
          type: item.mimeType || 'application/octet-stream',
          lastModified: item.lastModified || Date.now()
        });
        dt.items.add(file);
      }

      // Deliver to chat input or activeElement or main
      const target = document.querySelector('footer div[contenteditable="true"]') ||
                     document.activeElement ||
                     document.getElementById('main') ||
                     document.body;

      const pasteEv = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        composed: true,
        clipboardData: dt
      });
      pasteEv.__waSyntheticPaste = true;
      target.dispatchEvent(pasteEv);
    } catch (err) {
      console.error('Failed to paste clipboard files:', err);
    } finally {
      isPastingFiles = false;
    }
  }

  window.addEventListener('paste', handlePasteEvent, true);
}

// ===========================================================================
// Voice & Video Call Quality Enhancement Pipeline
// - Boosts dark laptop webcam sensor brightness and contrast
// - Applies real-time GPU-accelerated video enhancement (brightness, contrast, clarity)
// - Enforces studio-grade audio constraints (echo cancellation, noise suppression, auto-gain)
// ===========================================================================
function hookMediaDevices() {
  function mainWorldPipeline() {
    if (window.__waEnhancedMediaHook) return;
    window.__waEnhancedMediaHook = true;

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
    const origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

    function createFilteredVideoTrack(rawTrack) {
      try {
        const settings = rawTrack.getSettings ? rawTrack.getSettings() : {};
        const width = settings.width || 1280;
        const height = settings.height || 720;

        const video = document.createElement('video');
        video.autoplay = true;
        video.muted = true;
        video.playsInline = true;
        video.srcObject = new MediaStream([rawTrack]);

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
        if (!ctx) return null;

        // Flattering brightness, clarity and healthy tone filter for laptop webcam
        ctx.filter = 'brightness(1.22) contrast(1.10) saturate(1.06)';

        let active = true;
        function render() {
          if (!active) return;
          if (video.readyState >= 2) {
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          }
          if ('requestVideoFrameCallback' in video) {
            video.requestVideoFrameCallback(render);
          } else {
            requestAnimationFrame(render);
          }
        }

        video.play().then(() => { render(); }).catch(() => { render(); });

        const filteredStream = canvas.captureStream(30);
        const filteredTrack = filteredStream.getVideoTracks()[0];
        if (!filteredTrack) return null;

        // Proxy track properties so WhatsApp Web detects all capabilities
        try {
          Object.defineProperty(filteredTrack, 'label', {
            get: () => rawTrack.label || 'Webcam (Enhanced)',
            configurable: true
          });
          Object.defineProperty(filteredTrack, 'enabled', {
            get: () => rawTrack.enabled,
            set: (val) => { rawTrack.enabled = val; },
            configurable: true
          });
          Object.defineProperty(filteredTrack, 'id', {
            get: () => rawTrack.id,
            configurable: true
          });
        } catch {}

        if (rawTrack.getCapabilities) {
          filteredTrack.getCapabilities = () => rawTrack.getCapabilities();
        }
        if (rawTrack.getConstraints) {
          filteredTrack.getConstraints = () => rawTrack.getConstraints();
        }
        if (rawTrack.getSettings) {
          filteredTrack.getSettings = () => rawTrack.getSettings();
        }
        if (rawTrack.clone) {
          filteredTrack.clone = () => createFilteredVideoTrack(rawTrack.clone());
        }
        filteredTrack.applyConstraints = (c) => rawTrack.applyConstraints(c);

        rawTrack.addEventListener('mute', () => filteredTrack.dispatchEvent(new Event('mute')));
        rawTrack.addEventListener('unmute', () => filteredTrack.dispatchEvent(new Event('unmute')));

        // Proxy stop / cleanup
        const origStop = filteredTrack.stop.bind(filteredTrack);
        filteredTrack.stop = function() {
          active = false;
          try { rawTrack.stop(); } catch {}
          try { origStop(); } catch {}
          try {
            video.srcObject = null;
            video.remove();
            canvas.remove();
          } catch {}
        };

        rawTrack.addEventListener('ended', () => {
          try { filteredTrack.stop(); } catch {}
        });

        return filteredTrack;
      } catch (err) {
        console.warn('[Call Enhancement] Failed to create filtered video track:', err);
        return null;
      }
    }

    navigator.mediaDevices.getUserMedia = async function(constraints) {
      const userConstraints = constraints || {};
      const modifiedConstraints = { ...userConstraints };

      // 1. Studio-quality voice calling audio constraints
      if (userConstraints.audio) {
        if (typeof userConstraints.audio === 'boolean') {
          modifiedConstraints.audio = {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          };
        } else if (typeof userConstraints.audio === 'object') {
          modifiedConstraints.audio = {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            ...userConstraints.audio
          };
        }
      }

      // 2. High-definition video calling constraints
      if (userConstraints.video) {
        let videoConstraints = typeof userConstraints.video === 'object' ? { ...userConstraints.video } : {};
        if (!videoConstraints.width && !videoConstraints.height) {
          videoConstraints.width = { ideal: 1280 };
          videoConstraints.height = { ideal: 720 };
        }
        modifiedConstraints.video = videoConstraints;
      }

      const stream = await origGetUserMedia(modifiedConstraints);

      // 3. Process video tracks for brightness and clarity
      const videoTracks = stream.getVideoTracks();
      if (videoTracks.length > 0) {
        const rawTrack = videoTracks[0];

        // Layer 1: Hardware-level sensor brightness & contrast boost
        try {
          const capabilities = rawTrack.getCapabilities ? rawTrack.getCapabilities() : null;
          if (capabilities) {
            const advanced = [];
            if (capabilities.brightness) {
              const targetBrightness = Math.min(capabilities.brightness.max, Math.max(25, capabilities.brightness.min));
              advanced.push({ brightness: targetBrightness });
            }
            if (capabilities.contrast) {
              const targetContrast = Math.min(capabilities.contrast.max, 18);
              advanced.push({ contrast: targetContrast });
            }
            if (capabilities.exposureMode && capabilities.exposureMode.includes('continuous')) {
              advanced.push({ exposureMode: 'continuous' });
            }
            if (advanced.length > 0) {
              await rawTrack.applyConstraints({ advanced });
            }
          }
        } catch (e) {
          console.warn('[Camera] Hardware constraint adjustment skipped:', e);
        }

        // Layer 2: Real-time GPU filter pipeline for consistent, well-lit video
        try {
          const filteredTrack = createFilteredVideoTrack(rawTrack);
          if (filteredTrack) {
            stream.removeTrack(rawTrack);
            stream.addTrack(filteredTrack);
          }
        } catch (e) {
          console.warn('[Camera] Filter pipeline skipped:', e);
        }
      }

      return stream;
    };
  }

  try {
    webFrame.executeJavaScript(`(${mainWorldPipeline.toString()})();`);
  } catch (err) {
    console.warn('[Call Enhancement] Injection failed:', err);
  }
}

// Hook media devices immediately at startup
try {
  hookMediaDevices();
} catch (e) {
  console.warn('hookMediaDevices error:', e);
}

// ===========================================================================
window.addEventListener('DOMContentLoaded', () => {
  watchBadge();
  hookNotifications();
  hookMediaDevices();
  setupPanes();
  watchForPromos();
  hookClipboardFiles();

  // The upsell appears before the chat list finishes mounting, so sweep a few
  // times early; the interval in setupPanes takes over from there.
  stripPromos();
  let sweeps = 0;
  const early = setInterval(() => {
    stripPromos();
    stripHairlines();
    if (++sweeps >= 10) clearInterval(early);
  }, 700);
});
