/* Relay panel - keyboard shortcuts during a call (page side).
   M mute, V camera, S share screen, F full screen, R record. They press the
   call window's own buttons, so they follow whatever WhatsApp and Relay show,
   and do nothing while you are typing or when no call is open. */
(() => {
  'use strict';
  const R = window.__relay;
  if (!R || R.calls) return;

  const KEYS = {
    m: /^(un)?mute microphone$/i,
    v: /^turn camera (on|off)$/i,
    s: /^(share screen|stop sharing screen)$/i,
    f: /^(exit )?full screen$/i,
    r: /^(record call|stop recording)/i
  };

  addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.repeat || e.isComposing) return;
    // The letter on the key; on a non-Latin layout (Russian, Greek, Hindi...) fall back to the physical key.
    const letter = /^[a-z]$/i.test(e.key) ? e.key : String(e.code || '').replace(/^Key/, '');
    const want = KEYS[letter.toLowerCase()];
    if (!want) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    const call = document.querySelector('[data-testid="move_resize_component"]');
    if (!call || !call.querySelector('button[aria-label*="End call" i]')) return;
    const btn = [...call.querySelectorAll('button[aria-label]')]
      .find((b) => want.test(b.getAttribute('aria-label').trim()));
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    btn.click();
  }, true);

  R.calls = {};
})();
