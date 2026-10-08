/* Relay panel - smooth wheel scrolling for the chat list and side panels (page side).
   A mouse wheel jumps ~100px per notch, which feels rigid on a long list. Notches
   are turned into an eased glide (frame-rate independent, so it feels the same
   at 60 or 144 Hz). Touchpads already send smooth small deltas and are left alone,
   as is the message pane, where WhatsApp adjusts the position itself while older
   messages load. */
(() => {
  'use strict';
  const R = window.__relay;
  if (!R || R.scroll) return;

  const ZONES = '[data-wa-pane="side"], [data-testid^="drawer-"], [data-testid="chat-list"]';
  const EASE = 0.17;                 // share of the remaining distance covered per 16.7 ms
  const MIN_NOTCH = 50;              // smaller wheel deltas come from precision touchpads

  let el = null, target = 0, expected = 0, raf = 0, last = 0;

  function scrollerOf(node) {
    for (let n = node; n && n !== document.body; n = n.parentElement) {
      if (n.scrollHeight <= n.clientHeight + 1) continue;
      if (/(auto|scroll)/.test(getComputedStyle(n).overflowY)) return n;
    }
    return null;
  }

  function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    el = null;
  }

  function frame(now) {
    if (!el || !el.isConnected) return stop();
    // Moved by something else (scrollbar drag, keyboard, WhatsApp itself): let go.
    if (Math.abs(el.scrollTop - expected) > 3) return stop();
    const dt = Math.min(50, now - last) || 16.7;
    last = now;
    const left = target - expected;
    if (Math.abs(left) < 0.4) { el.scrollTop = target; return stop(); }
    expected += left * (1 - Math.pow(1 - EASE, dt / 16.7));
    el.scrollTop = expected;
    raf = requestAnimationFrame(frame);
  }

  const calm = window.matchMedia('(prefers-reduced-motion: reduce)');

  function onWheel(e) {
    if (calm.matches) return;                // asked the system for less motion: leave scrolling to the browser
    if (e.ctrlKey || e.shiftKey || e.defaultPrevented || e.deltaMode !== 0 || Math.abs(e.deltaY) < MIN_NOTCH) return;
    const node = e.target instanceof Element ? e.target : null;
    if (!node) return;
    const box = scrollerOf(node);
    if (!box) return;
    if (box !== el) { stop(); el = box; expected = target = box.scrollTop; }
    const max = box.scrollHeight - box.clientHeight;
    target = Math.max(0, Math.min(max, target + e.deltaY));
    e.preventDefault();
    if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); }
  }

  // A page-wide non-passive wheel listener would make the browser wait for the main thread
  // before scrolling *anything*, including the message pane. So the listener lives only on
  // the chat list and the side panels themselves, attached as they appear.
  const bound = new WeakSet();
  function bind() {
    for (const zone of document.querySelectorAll(ZONES)) {
      if (bound.has(zone)) continue;
      bound.add(zone);
      zone.addEventListener('wheel', onWheel, { passive: false });
    }
  }
  setInterval(bind, 1000);
  bind();

  R.scroll = { stop };
})();
