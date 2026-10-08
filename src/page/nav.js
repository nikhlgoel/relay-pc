/* Relay panel - "back" from the mouse's side buttons, Alt+Left and the Windows back command (page side).
   WhatsApp Web is one page, so a browser's history cannot say what "back" means. Relay answers the way a person would:
     1. a viewer, dialog or file preview is open        -> close it (its own Back / Close button)
     2. a side panel is showing a sub-page              -> its back arrow
     3. a side panel (Settings, Status, Channels...)    -> return to the chat list
     4. a chat is open                                  -> close it (what Escape does)
   The forward button does nothing, as WhatsApp has nothing to go "forward" to. */
(() => {
  'use strict';
  const R = window.__relay;
  if (!R || R.nav) return;

  const visible = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  /** A full mouse press (down, up, click): WhatsApp's own controls listen for more than a bare click(). */
  const press = (el) => {
    const t = el.closest('button, [role="button"]') || el;
    const r = t.getBoundingClientRect();
    const init = { bubbles: true, cancelable: true, composed: true, view: window, button: 0, buttons: 1, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      const E = type.startsWith('pointer') ? PointerEvent : MouseEvent;
      t.dispatchEvent(new E(type, { ...init, buttons: type.endsWith('up') || type === 'click' ? 0 : 1 }));
    }
  };
  const label = (e) => (e.getAttribute('aria-label') || '').trim();

  /** Performs one step of "back" and says which one it was ('' if there was nothing to go back from). */
  function goBack() {
    // 0. the file / photo preview ("Send 2 selected") and the media viewer are full-pane layers with a Close button of their own
    const preview = [...document.querySelectorAll('[aria-label^="Send" i]')].some((e) => visible(e) && /selected|^send$/i.test(label(e))) ||
      [...document.querySelectorAll('[data-animate-media-viewer], [data-testid*="media-viewer"]')].some(visible);
    if (preview) {
      const close = [...document.querySelectorAll('[aria-label="Close" i], [aria-label="Back" i]')].filter((e) => visible(e) && !e.closest('[data-testid="drawer-left"], #pane-side'))[0];
      if (close) { press(close); return 'preview'; }
    }
    // 1. dialogs and pop-ups
    const dialogs = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"], [data-animate-modal-popup], [data-animate-media-viewer]')].filter(visible);
    if (dialogs.length) {
      const top = dialogs[dialogs.length - 1];
      const b = [...top.querySelectorAll('[aria-label]')].filter(visible).find((e) => /^(back|close|cancel)$/i.test(label(e)));
      if (b) { press(b); return 'dialog'; }
      R.call('action', 'press-escape').catch(() => {});
      return 'dialog';
    }
    // 2. a back arrow in a side panel (a sub-page of Settings, a Status viewer, contact info ...)
    const backs = [...document.querySelectorAll('[aria-label="Back" i], [data-icon="back"], [data-icon="back-refreshed"], [data-icon="arrow-back"], [data-icon="ic-arrow-back"]')].filter(visible);
    if (backs.length) { press(backs[backs.length - 1]); return 'back-arrow'; }
    // a side panel that only has a close button (chat info, search in chat)
    const closers = [...document.querySelectorAll('[data-testid^="drawer-"] [aria-label="Close" i], [data-testid="drawer-right"] [aria-label="Close" i]')].filter(visible);
    if (closers.length) { press(closers[closers.length - 1]); return 'drawer-close'; }
    // 3. Settings / Status / Channels / Communities / Calls: back to the chat list
    const drawer = document.querySelector('[data-testid="drawer-left"]');
    const chats = [...document.querySelectorAll('button[aria-label]')].find((b) => /^chats$/i.test(label(b)) && visible(b));
    const title = drawer && drawer.querySelector('h1, h2');
    if (drawer && visible(drawer) && chats && title && !/^chats$/i.test((title.innerText || '').trim())) { press(chats); return 'chat-list'; }
    // 4. close the open chat
    if (document.querySelector('#main footer')) { R.call('action', 'press-escape').catch(() => {}); return 'chat'; }
    return '';
  }

  // Mouse side buttons and the Windows "browser back" command can both arrive for one press: act once.
  let lastAt = 0;
  const once = (fn) => { const now = Date.now(); if (now - lastAt < 250) return; lastAt = now; fn(); };

  R.on('nav', (dir) => { if (dir === 'back') once(goBack); });

  window.addEventListener('mouseup', (e) => {
    if (e.button === 3) { e.preventDefault(); e.stopPropagation(); once(goBack); }        // the "back" side button
    else if (e.button === 4) { e.preventDefault(); e.stopPropagation(); }                   // "forward": nothing to do
  }, true);
  window.addEventListener('auxclick', (e) => { if (e.button === 3 || e.button === 4) e.preventDefault(); }, true);

  addEventListener('keydown', (e) => {
    if (e.altKey && e.key === 'ArrowLeft' && !e.ctrlKey && !e.shiftKey) {
      const t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA)$/.test(t.tagName))) return;       // Alt+Left inside a text box belongs to the text box
      e.preventDefault();
      once(goBack);
    }
  }, true);

  R.nav = { goBack };
})();
