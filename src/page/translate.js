/* Relay panel - chat translation (page side).
   Translates incoming messages to casual English under the original, for chats
   where it is switched on (header button) or for every chat (Relay panel). The
   text goes to the main process (src/hub.js) which asks the chosen provider.
   Only messages near the viewport are sent, each text at most once. */
(() => {
  'use strict';
  const R = window.__relay;
  if (!R || R.translate) return;

  const STORE = 'relay.translate';
  const PANEL = '[data-testid="conversation-panel-messages"]';
  const read = () => { try { return JSON.parse(localStorage.getItem(STORE) || '{}') || {}; } catch (e) { return {}; } };
  let chats = read();                        // chat id -> true | false (an explicit choice)
  const save = () => { try { localStorage.setItem(STORE, JSON.stringify(chats)); } catch (e) { /* private mode */ } };

  let langNames = null;
  try { langNames = new Intl.DisplayNames(['en'], { type: 'language' }); } catch (e) { /* older engine */ }
  const langName = (code) => { try { return (langNames && langNames.of(code)) || code; } catch (e) { return code; } };

  const cache = new Map();                   // original text -> { lang, text, translated }
  const failed = new Map();                  // original text -> time of the last failure
  const wanted = new Map();                  // original text -> Set of message elements waiting
  const seen = new WeakMap();                // message element -> { text, res }
  let inflight = false, scanTimer = 0, lastError = 0, streak = 0, pausedUntil = 0;

  /** A stable key for the open chat: its title, hashed (message ids do not carry the chat). */
  function chatId() {
    const t = document.querySelector('#main [data-testid="conversation-info-header-chat-title-name"]');
    const name = t && t.textContent.trim();
    if (!name) return null;
    let h = 5381;
    for (let i = 0; i < name.length; i++) h = ((h << 5) + h + name.charCodeAt(i)) | 0;
    return 'c' + (h >>> 0).toString(36);
  }
  const globalOn = () => Boolean(R.state && R.state.translate.all);
  const enabledFor = (id) => Boolean(id) && (id in chats ? chats[id] : globalOn());

  /** Plain text of a message, with emoji images turned back into characters. */
  function flat(node) {
    let s = '';
    node.childNodes.forEach((n) => {
      if (n.nodeType === 3) s += n.nodeValue;
      else if (n.classList && n.classList.contains('relay-tr')) return;
      else if (n.nodeName === 'IMG') s += n.getAttribute('alt') || '';
      else if (n.nodeName === 'BR') s += '\n';
      else s += flat(n);
    });
    return s;
  }

  // A reply shows the quoted message above its own text, and in a group the sender's name can sit in
  // the same block: the message's own words are the last text that is not part of a quote.
  const QUOTED = '[data-testid*="quoted" i], [aria-label*="quoted" i]';
  const textNodeOf = (msg) => {
    const all = [...msg.querySelectorAll('.copyable-text [data-testid="selectable-text"]')].filter((n) => !n.closest(QUOTED));
    return all.length ? all[all.length - 1] : null;
  };

  /** Incoming bubbles sit on the left. The tail icon says so when there is one; otherwise geometry. */
  function isIncoming(msg, panelRect) {
    if (msg.querySelector('[data-icon="tail-in"]')) return true;
    if (msg.querySelector('[data-icon="tail-out"]')) return false;
    const b = (msg.querySelector('[data-testid="msg-container"]') || msg).getBoundingClientRect();
    const left = b.left - panelRect.left, right = panelRect.right - b.right;
    return left + 24 < right;
  }

  function render(msg, node, res) {
    let tr = msg.querySelector('.relay-tr');
    if (!res || !res.translated) { if (tr) tr.remove(); return; }
    if (!tr) {
      tr = R.el('div', { class: 'relay-tr' });
      // Sits directly under the message text, inside the bubble.
      // (the text span itself also carries .copyable-text, so ask for the block element)
      const host = node.closest('div.copyable-text') || node.parentElement.parentElement;
      host.append(tr);
    }
    tr.textContent = res.text;
    tr.dir = 'ltr';                                  // the translation is English, even inside a right-to-left bubble
    tr.dataset.lang = res.lang;
    tr.title = 'Translated from ' + langName(res.lang);
  }

  function scan() {
    scanTimer = 0;
    mountHeaderButton();
    const panel = document.querySelector(PANEL);
    const id = chatId();
    const on = enabledFor(id);
    document.documentElement.dataset.relayTr = on ? 'on' : 'off';
    updateButton(on);
    if (!panel || !on) return;
    const bottom = innerHeight + 900;
    const pr = panel.getBoundingClientRect();
    for (const msg of panel.querySelectorAll('[data-id][data-testid^="conv-msg-"]')) {
      const node = textNodeOf(msg);
      if (!node) continue;
      const rect = msg.getBoundingClientRect();
      if (rect.bottom < -900 || rect.top > bottom) continue;          // only what is near the screen
      if (!isIncoming(msg, pr)) continue;                              // only what others wrote
      const text = flat(node).trim();
      const rec = seen.get(msg);
      if (rec && rec.text === text) {
        if (rec.res && rec.res.translated && !msg.querySelector('.relay-tr')) render(msg, node, rec.res);
        continue;
      }
      const hit = cache.get(text);
      seen.set(msg, { text, res: hit || null });
      if (hit) { render(msg, node, hit); continue; }
      const t = failed.get(text);
      if (t && Date.now() - t < 30000) continue;
      if (!wanted.has(text)) wanted.set(text, new Set());
      wanted.get(text).add(msg);
    }
    flush();
  }

  // A queued scan is left alone, but one that has been waiting far too long (a timer lost
  // while the window was still hidden) is replaced, so the button can never go missing for good.
  let scanAt = 0;
  const scanSoon = () => {
    const now = Date.now();
    if (scanTimer && now - scanAt < 1500) return;
    clearTimeout(scanTimer);
    scanAt = now;
    scanTimer = setTimeout(scan, 220);
  };

  async function flush() {
    if (inflight || !wanted.size) return;
    if (Date.now() < pausedUntil) return;                    // backing off after repeated failures
    inflight = true;
    const texts = [...wanted.keys()].slice(0, 20);
    try {
      const out = await R.call('translate', texts);
      texts.forEach((t, i) => {
        cache.set(t, out[i]);
        const els = wanted.get(t) || [];
        wanted.delete(t);
        els.forEach((msg) => {
          const rec = seen.get(msg);
          if (rec && rec.text === t) rec.res = out[i];
          const node = textNodeOf(msg);
          if (node && msg.isConnected && enabledFor(chatId())) render(msg, node, out[i]);
        });
      });
      if (cache.size > 800) for (const k of [...cache.keys()].slice(0, 200)) cache.delete(k);
      streak = 0;
    } catch (err) {
      texts.forEach((t) => { failed.set(t, Date.now()); wanted.delete(t); });
      if (failed.size > 400) for (const k of [...failed.keys()].slice(0, 200)) failed.delete(k);
      streak++;
      if (streak >= 3) {
        // A key out of credit, a daily limit or no internet: stop asking (it only burns quota) and say so once.
        pausedUntil = Date.now() + 5 * 60 * 1000;
        streak = 0;
        wanted.clear();
        R.toast('Translation paused for 5 minutes: ' + err.message);
      } else if (Date.now() - lastError > 20000) {
        lastError = Date.now();
        R.toast('Translation: ' + err.message);
      }
    } finally {
      inflight = false;
      if (wanted.size) setTimeout(flush, 150);
    }
  }

  // --- the header button ----------------------------------------------------
  let button = null;

  async function ready() {
    const t = R.state && R.state.translate;
    if (!t) return false;
    if (!t.hasKey) { R.toast('Add your ' + t.providerName.split(' (')[0] + ' API key in the Relay panel first'); return false; }
    return R.call('translate-consent');
  }

  async function toggleChat() {
    const id = chatId();
    if (!id) { R.toast('Open a chat with messages first'); return; }
    const next = !enabledFor(id);
    if (next && !(await ready())) return;
    chats[id] = next;
    save();
    scan();
    R.toast(next ? 'Translating this chat to casual English' : 'Translation off for this chat');
  }

  function updateButton(on) {
    if (!button) return;
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
    button.title = on ? 'Translating this chat (click to stop)' : 'Translate this chat to English';
  }

  function mountHeaderButton() {
    const header = document.querySelector('#main header');
    if (!header) { button = null; return; }
    if (header.querySelector('.relay-tr-btn')) return;
    // The icon row (calls, menu) is the header's last block; our button goes first in it.
    const actions = [...header.children].reverse().find((c) => c.firstElementChild && !c.querySelector('[data-testid="conversation-info-header"]'));
    if (!actions) return;
    const row = actions.children.length === 1 ? actions.firstElementChild : actions;
    button = R.el('button', {
      class: 'relay-tr-btn', type: 'button',
      attrs: { 'aria-label': 'Translate this chat', 'aria-pressed': 'false' },
      on: { click: (e) => { e.preventDefault(); e.stopPropagation(); toggleChat(); } }
    }, R.icon('translate', 22));
    row.insertBefore(button, row.firstElementChild);
    updateButton(enabledFor(chatId()));
  }

  // --- on demand: the right-click menu (src/main.js asks the page to translate what was clicked) ---------------
  const MSG = '[data-id][data-testid^="conv-msg-"]';
  /** Messages ticked in WhatsApp's "select messages" mode. */
  function selectedMessages() {
    return [...document.querySelectorAll(PANEL + ' ' + MSG)].filter((m) =>
      m.querySelector('[role="checkbox"][aria-checked="true"], input[type="checkbox"]:checked') ||
      m.getAttribute('aria-selected') === 'true' || m.closest('[aria-selected="true"]'));
  }

  async function translateNow(msgs) {
    const items = msgs.map((msg) => ({ msg, node: textNodeOf(msg) })).filter((x) => x.node && x.node.isConnected);
    if (!items.length) { R.toast('Nothing to translate in that message'); return; }
    if (!(await ready())) return;
    const texts = [...new Set(items.map((x) => flat(x.node).trim()).filter(Boolean))];
    let done = 0;
    try {
      for (let i = 0; i < texts.length; i += 20) {
        const part = texts.slice(i, i + 20);
        const out = await R.call('translate', part);
        part.forEach((t, k) => cache.set(t, out[k]));
      }
      for (const { msg, node } of items) {
        const res = cache.get(flat(node).trim());
        if (res && res.translated) { seen.set(msg, { text: flat(node).trim(), res }); render(msg, node, res); done++; }
      }
      R.toast(done ? (done === 1 ? 'Translated' : 'Translated ' + done + ' messages') : 'Already in English');
    } catch (err) { R.toast('Translation: ' + err.message); }
  }

  /** Tells the main process what a right-click is on, so its menu can offer "Translate". */
  addEventListener('contextmenu', (e) => {
    const hit = e.target && e.target.closest ? e.target.closest(MSG) : null;
    const picked = selectedMessages();
    const kind = picked.length > 1 && (!hit || picked.includes(hit)) ? 'many' : hit ? 'one' : '';
    R.call('context-hint', kind, picked.length).catch(() => {});
    window.__relayCtx = { x: e.clientX, y: e.clientY, hit, picked };
  }, true);

  R.on('translate-now', () => {
    const c = window.__relayCtx;
    if (!c) return;
    const list = c.picked.length > 1 && (!c.hit || c.picked.includes(c.hit)) ? c.picked : c.hit ? [c.hit] : [];
    translateNow(list);
  });

  R.translate = { toggleChat, ready, scan: scanSoon, translateNow, selectedMessages };
  R.subscribe(scanSoon);

  const app = document.getElementById('app') || document.body;
  new MutationObserver(scanSoon).observe(app, { childList: true, subtree: true });
  addEventListener('scroll', scanSoon, { passive: true, capture: true });
  scanSoon();
})();
