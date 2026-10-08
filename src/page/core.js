/* Relay panel - shared core. Runs in WhatsApp's page, delivered by src/main.js
   (see PAGE_MODULES) and injected by src/preload.js. Talks to the main process
   only through the preload's allow-listed postMessage bridge. */
(() => {
  'use strict';
  if (window.__relay) return;

  const pending = new Map();
  const subs = new Set();
  let seq = 0;
  let state = null;

  const setState = (next) => {
    state = next;
    window.__relayDnd = Boolean(next && next.dnd);       // read by the notification hook
    subs.forEach((fn) => { try { fn(next); } catch (e) { /* one bad listener must not stop the rest */ } });
  };

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (e.source !== window || !d) return;
    if (d.__relay === 'res') {
      const p = pending.get(d.id);
      if (!p) return;
      pending.delete(d.id);
      clearTimeout(p.timer);
      if (d.error) p.reject(new Error(d.error)); else p.resolve(d.result);
    } else if (d.__relay === 'evt' && d.ch === 'state') {
      setState(d.data);
    }
  });

  // Material Design icon paths (24px grid, Apache-2.0).
  const ICONS = {
    translate: 'M12.87 15.07l-2.54-2.51.03-.03A17.52 17.52 0 0014.07 6H17V4h-7V2H8v2H1v2h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z',
    bolt: 'M7 2v11h3v9l7-12h-4l4-8z',
    bell: 'M20 18.69L7.84 6.14 5.27 3.49 4 4.76l2.8 2.8v.01c-.52.99-.8 2.16-.8 3.42v5l-2 2v1h13.73l2 2L21 19.72l-1-1.03zM12 22c1.11 0 2-.89 2-2h-4c0 1.11.89 2 2 2zm6-7.32V11c0-3.08-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68c-.15.03-.29.08-.42.12-.1.03-.2.07-.3.11h-.01c-.01 0-.01 0-.02.01-.23.09-.46.2-.68.31 0 0-.01 0-.01.01L18 14.68z',
    wave: 'M7 18h2V6H7v12zm4 4h2V2h-2v20zm-8-8h2v-4H3v4zm12 4h2V6h-2v12zm4-8v4h2v-4h-2z',
    video: 'M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z',
    mic: 'M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z',
    record: 'M12 7a5 5 0 100 10 5 5 0 000-10zm0-5C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z',
    folder: 'M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z',
    info: 'M11 7h2v2h-2zm0 4h2v6h-2zm1-9C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z',
    close: 'M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
    plus: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z',
    key: 'M12.65 10A5.99 5.99 0 007 6c-3.31 0-6 2.69-6 6s2.69 6 6 6a5.99 5.99 0 005.65-4H17v4h4v-4h2v-4H12.65zM7 14c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z'
  };
  const SVG = 'http://www.w3.org/2000/svg';

  /** Tiny element builder: el('div', {class, text, on:{click}, attrs:{}}, ...children) */
  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'on') for (const [ev, fn] of Object.entries(v)) n.addEventListener(ev, fn);
      else if (k === 'attrs') for (const [a, av] of Object.entries(v)) n.setAttribute(a, av);
      else n[k] = v;
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid);
    return n;
  }

  function icon(name, size) {
    const s = document.createElementNS(SVG, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('width', size || 20);
    s.setAttribute('height', size || 20);
    s.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(SVG, 'path');
    p.setAttribute('d', ICONS[name] || '');
    p.setAttribute('fill', 'currentColor');
    s.append(p);
    return s;
  }

  let toastTimer = 0;
  function toast(text) {
    let t = document.getElementById('relay-toast');
    if (!t) { t = el('div', { id: 'relay-toast', attrs: { role: 'status' } }); document.body.append(t); }
    t.textContent = text;
    t.dataset.show = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.dataset.show = ''; }, 3600);
  }

  window.__relay = {
    get state() { return state; },
    call(ch, ...args) {
      return new Promise((resolve, reject) => {
        const id = ++seq;
        const timer = setTimeout(() => { if (pending.delete(id)) reject(new Error('Timed out')); }, 90000);
        pending.set(id, { resolve, reject, timer });
        window.postMessage({ __relay: 'req', id, ch, args }, location.origin);
      });
    },
    subscribe(fn) { subs.add(fn); if (state) fn(state); return () => subs.delete(fn); },
    el, icon, toast
  };

  window.__relay.call('state').then(setState).catch(() => {});
})();
