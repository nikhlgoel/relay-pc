/* Relay panel - the in-app quick settings (page side).
   A button at the foot of the left rail opens one panel with every Relay switch:
   translation, do-not-disturb, call quality and recording, and quick replies.
   It is built from plain elements styled in src/theme.css so it reads as part of
   the app. State lives in the main process (src/hub.js); this only shows it. */
(() => {
  'use strict';
  const R = window.__relay;
  if (!R || R.hub) return;
  const { el, icon } = R;

  let panel = null;
  let railBtn = null;
  let draft = '';

  const fail = (err) => R.toast(err && err.message ? err.message : 'Something went wrong');

  function switchEl(on, onToggle) {
    const b = el('button', {
      class: 'relay-sw', type: 'button',
      attrs: { role: 'switch', 'aria-checked': on ? 'true' : 'false' }
    }, el('span', { class: 'relay-sw-knob' }));
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const next = b.getAttribute('aria-checked') !== 'true';
      b.setAttribute('aria-checked', String(next));
      Promise.resolve(onToggle(next)).catch((err) => { fail(err); render(); });
    });
    return b;
  }

  function row(ic, title, sub, control) {
    return el('div', { class: 'relay-row' },
      el('span', { class: 'relay-row-ic' }, icon(ic, 20)),
      el('div', { class: 'relay-row-tx' },
        el('div', { class: 'relay-row-t', text: title }),
        sub ? el('div', { class: 'relay-row-s', text: sub }) : null),
      control);
  }

  const setting = (name) => (value) => R.call('set', name, value);

  // --- appearance: WhatsApp's own Dark / Light theme, one tap away ------------------------------------------
  // WhatsApp keeps its theme in two local keys and reads them only at start-up, so a change reloads the page once
  // (drafts are kept by WhatsApp itself). Relay's dark styling steps aside when WhatsApp is light (src/preload.js).
  const currentTheme = () => {
    try { return JSON.parse(localStorage.getItem('theme') || '"dark"') === 'light' ? 'light' : 'dark'; } catch (e) { return 'dark'; }
  };
  function setTheme(next) {
    if (next === currentTheme()) return;
    if (document.querySelector('[data-testid="move_resize_component"]')) { R.toast('Finish the call first - changing the theme reloads WhatsApp for a moment'); return; }
    try {
      localStorage.setItem('theme', JSON.stringify(next));
      localStorage.setItem('system-theme-mode', 'false');
    } catch (e) { fail(e); return; }
    close();
    R.toast(next === 'light' ? 'Switching to the light theme...' : 'Switching to the dark theme...');
    setTimeout(() => location.reload(), 450);
  }
  function appearanceSection() {
    const cur = currentTheme();
    return [
      el('div', { class: 'relay-seg', attrs: { role: 'group', 'aria-label': 'Theme', style: 'margin-left:0' } },
        ...[['dark', 'Dark'], ['light', 'Light']].map(([v, text]) => el('button', {
          type: 'button', class: 'relay-seg-b', text, attrs: { 'aria-pressed': String(cur === v) }, on: { click: () => setTheme(v) }
        }))),
      el('div', { class: 'relay-note relay-note-dim', style: 'margin-left:0', text: 'WhatsApp reloads for a moment when you change it.' })
    ];
  }

  /** The language live captions are shown in (a drop-down; names come from the system). */
  function captionLanguage(s) {
    const c = s.captions;
    if (!c || !Array.isArray(c.targets)) return null;
    let names = null;
    try { names = new Intl.DisplayNames([navigator.language || 'en'], { type: 'language' }); } catch (e) { /* codes are shown instead */ }
    const nm = (code) => (names && names.of(code)) || code;
    const sorted = c.targets.slice().sort((a, b) => (a === 'en' ? -1 : b === 'en' ? 1 : nm(a).localeCompare(nm(b))));
    return el('select', {
      class: 'relay-select', attrs: { 'aria-label': 'Caption language' },
      on: { change: (e) => R.call('caption-set', 'lang', e.target.value).catch(fail) }
    }, ...sorted.map((code) => el('option', { value: code, text: nm(code), selected: code === c.lang })));
  }

  async function setTranslateAll(value) {
    if (value && !(await R.translate.ready())) { render(); return; }
    await R.call('set', 'translateAll', value);
  }

  const KEY_HELP = {
    openrouter: 'Free models, your own key. Create one at openrouter.ai/keys, then add it here.',
    claude: 'Keeps the tone and feeling of the original. Needs your own API key.',
    google: 'Free, no key. A literal translation, with a light casual touch.'
  };

  function translateSection(s) {
    const t = s.translate;
    const cur = t.providers.find((x) => x.id === t.provider) || t.providers[0];
    const out = [
      row('translate', 'Translate chats', 'Any language to casual English', switchEl(t.all, setTranslateAll)),
      el('div', { class: 'relay-seg', attrs: { role: 'group', 'aria-label': 'Translator' } },
        ...t.providers.map((p) => el('button', {
          type: 'button', class: 'relay-seg-b', text: p.name,
          attrs: { 'aria-pressed': String(t.provider === p.id) },
          on: { click: () => R.call('translate-provider', p.id).catch(fail) }
        })))
    ];
    if (cur.needsKey) {
      out.push(el('div', { class: 'relay-note' },
        el('span', { text: cur.hasKey ? 'Your ' + cur.name + ' key is saved on this PC' : KEY_HELP[cur.id] }),
        el('div', { class: 'relay-note-a' },
          el('button', { type: 'button', class: 'relay-link', text: cur.hasKey ? 'Replace key' : 'Add key', on: { click: () => R.call('key-prompt', cur.id).catch(fail) } }),
          cur.id === 'openrouter' && !cur.hasKey ? el('button', { type: 'button', class: 'relay-link', text: 'Get a free key', on: { click: () => R.call('action', 'get-openrouter-key').catch(fail) } }) : null,
          cur.hasKey ? el('button', { type: 'button', class: 'relay-link', text: 'Remove', on: { click: () => R.call('key-clear', cur.id).catch(fail) } }) : null)));
    } else {
      out.push(el('div', { class: 'relay-note', text: KEY_HELP[cur.id] }));
    }
    out.push(el('div', { class: 'relay-note relay-note-dim', text: 'In a chat, use the translate button at the top to turn it on for just that chat.' }));
    return out;
  }

  // --- network: a VPN or proxy for places where WhatsApp is blocked -----------------------------------------
  let proxyDraft = null;
  function networkSection(s) {
    const cur = s.proxy || '';
    if (proxyDraft === null) proxyDraft = cur;
    const input = el('input', {
      class: 'relay-input', type: 'text', placeholder: '127.0.0.1:7890  or  socks5://127.0.0.1:1080', maxLength: 120, value: proxyDraft,
      attrs: { 'aria-label': 'Proxy address', spellcheck: 'false' },
      on: { input: (e) => { proxyDraft = e.target.value; } }
    });
    const apply = (value) => R.call('proxy-set', value).then(() => { proxyDraft = null; R.toast(value ? 'Proxy saved' : 'Using the Windows settings'); render(); }).catch(fail);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); apply(input.value); } });
    return [
      el('div', { class: 'relay-note', text: cur ? 'Relay connects through ' + cur : 'Relay follows your Windows proxy / VPN settings.' }),
      el('div', { class: 'relay-add' }, input, el('button', {
        type: 'button', class: 'relay-add-b', title: 'Save', attrs: { 'aria-label': 'Save proxy' }, on: { click: () => apply(input.value) }
      }, icon('plus', 18))),
      el('div', { class: 'relay-note relay-note-dim', text: 'Only needed if WhatsApp is blocked where you are and your VPN does not set the Windows proxy itself. Leave empty to follow Windows.' }),
      cur ? el('div', { class: 'relay-note-a' }, el('button', { type: 'button', class: 'relay-link', text: 'Use Windows settings', on: { click: () => apply('') } })) : null
    ];
  }

  function languageSection(s) {
    const cur = s.waLang === 'en' ? 'en' : 'auto';
    return [
      el('div', { class: 'relay-seg', attrs: { role: 'group', 'aria-label': 'WhatsApp language', style: 'margin-left:0' } },
        ...[['auto', 'My language'], ['en', 'English']].map(([v, text]) => el('button', {
          type: 'button', class: 'relay-seg-b', text, attrs: { 'aria-pressed': String(cur === v) }, on: { click: () => { R.call('wa-lang', v).catch(fail); } }
        }))),
      el('div', { class: 'relay-note relay-note-dim', style: 'margin-left:0', text: 'Call extras (captions, record, shortcuts, back) need WhatsApp in English.' })
    ];
  }

  function quickReplies(s) {
    const list = s.snippets || [];
    const save = (next) => R.call('snippets', next).catch(fail);
    const input = el('input', {
      class: 'relay-input', type: 'text', placeholder: 'Add a quick reply', maxLength: 1000, value: draft,
      attrs: { 'aria-label': 'New quick reply', spellcheck: 'true' },
      on: { input: (e) => { draft = e.target.value; } }
    });
    const add = () => {
      const text = draft.trim();
      if (!text) return;
      draft = '';
      save([...list, { id: Math.random().toString(36).slice(2, 10), text }]);
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
    return [
      ...list.map((q) => el('div', { class: 'relay-qr' },
        el('button', { type: 'button', class: 'relay-qr-t', raw: true, text: q.text, title: q.text, on: { click: () => useReply(q.text) } }),
        el('button', {
          type: 'button', class: 'relay-qr-x', title: 'Remove', attrs: { 'aria-label': 'Remove quick reply' },
          on: { click: () => save(list.filter((x) => x.id !== q.id)) }
        }, icon('close', 16)))),
      list.length ? null : el('div', { class: 'relay-note relay-note-dim', text: 'Tap one to drop it into the message box.' }),
      el('div', { class: 'relay-add' }, input, el('button', {
        type: 'button', class: 'relay-add-b', title: 'Add', attrs: { 'aria-label': 'Add quick reply' }, on: { click: add }
      }, icon('plus', 18)))
    ];
  }

  /** Types a quick reply into the message box of the open chat. */
  function useReply(text) {
    const box = document.querySelector('[data-testid="conversation-compose-box-input"]') ||
      document.querySelector('#main footer [contenteditable="true"]');
    if (!box) { R.toast('Open a chat first'); return; }
    close();
    box.focus();
    text.split('\n').forEach((line, i) => {
      if (i) document.execCommand('insertLineBreak');
      if (line) document.execCommand('insertText', false, line);
    });
  }

  function render() {
    if (!panel) return;
    const s = R.state;
    if (!s) return;
    const keep = panel.querySelector('.relay-body');
    const scroll = keep ? keep.scrollTop : 0;
    const hadFocus = document.activeElement && document.activeElement.classList.contains('relay-input');
    const section = (title, ...kids) => el('section', { class: 'relay-sec' }, el('h3', { text: title }), ...kids);

    panel.replaceChildren(
      el('div', { class: 'relay-head' },
        el('span', { class: 'relay-mark' }),
        el('div', {}, el('div', { class: 'relay-title', text: 'Relay' }), el('div', { class: 'relay-sub', text: 'Quick settings' })),
        el('button', { type: 'button', class: 'relay-x', title: 'Close', attrs: { 'aria-label': 'Close' }, on: { click: close } }, icon('close', 18))),
      el('div', { class: 'relay-body' },
        section('Appearance', ...appearanceSection()),
        section('Chats', ...translateSection(s)),
        section('Notifications',
          row('bell', 'Do not disturb', 'Silences pop-ups, sound and flashing', switchEl(s.dnd, setting('dnd')))),
        section('Calls',
          row('wave', 'Noise suppression', 'Removes background noise from your mic', switchEl(s.noise, setting('noise'))),
          row('video', 'Enhance camera', 'Brighter, cleaner video', switchEl(s.camera, setting('camera'))),
          row('video', 'Sharper video', 'Clearer picture from the people you call', switchEl(s.sharpVideo !== false, setting('sharpVideo'))),
          row('mic', 'Voice clarity', 'Levelling and EQ for your voice', switchEl(s.mic, setting('mic'))),
          row('record', 'Record calls automatically', 'Saved to your Videos folder', switchEl(s.autoRecord, setting('autoRecord'))),
          s.captions ? row('caption', 'Captions language', 'Live captions: tap CC in a call', captionLanguage(s)) : null,
          el('div', { class: 'relay-note relay-note-dim', text: 'In a call: M mute · V camera · S share screen · F full screen · R record · C captions' })),
        section('Language', ...languageSection(s)),
        section('Network', ...networkSection(s)),
        section('Quick replies', ...quickReplies(s))),
      el('div', { class: 'relay-foot' },
        el('button', { type: 'button', class: 'relay-link', on: { click: () => R.call('action', 'open-recordings').catch(fail) } }, icon('folder', 16), 'Recordings'),
        el('button', { type: 'button', class: 'relay-link', on: { click: () => R.call('action', 'about').catch(fail) } }, icon('info', 16), 'About')));

    const body = panel.querySelector('.relay-body');
    body.scrollTop = scroll;
    if (hadFocus) { const i = panel.querySelector('.relay-input'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }
  }

  // --- quick replies from the message box -------------------------------------
  let qrBtn = null;
  let qrPop = null;

  function renderQr() {
    if (!qrPop) return;
    const list = (R.state && R.state.snippets) || [];
    qrPop.replaceChildren(
      el('div', { class: 'relay-qrp-h', text: 'Quick replies' }),
      el('div', { class: 'relay-qrp-b' },
        list.length
          ? list.map((q) => el('button', { type: 'button', class: 'relay-qrp-i', raw: true, text: q.text, title: q.text, on: { click: () => { closeQr(); useReply(q.text); } } }))
          : el('div', { class: 'relay-note relay-note-dim', text: 'No quick replies yet.' })),
      el('button', { type: 'button', class: 'relay-link relay-qrp-m', text: list.length ? 'Manage' : 'Add one', on: { click: () => { closeQr(); open(); } } }));
  }

  function closeQr() {
    if (!qrPop) return;
    qrPop.remove();
    qrPop = null;
    if (qrBtn) qrBtn.setAttribute('aria-expanded', 'false');
  }

  function toggleQr() {
    if (qrPop && qrPop.isConnected) return closeQr();
    qrPop = null;
    close();
    qrPop = el('div', { class: 'relay-panel relay-qrp', attrs: { role: 'menu', 'aria-label': 'Quick replies' } });
    document.body.append(qrPop);
    const r = qrBtn.getBoundingClientRect();
    qrPop.style.left = Math.max(12, Math.round(r.left - 8)) + 'px';
    qrPop.style.bottom = Math.round(innerHeight - r.top + 10) + 'px';
    qrBtn.setAttribute('aria-expanded', 'true');
    renderQr();
  }

  function mountCompose() {
    const input = document.querySelector('#main [data-testid="conversation-compose-box-input"]');
    const pill = input && input.closest('[tabindex="-1"]');
    if (!pill) { qrBtn = null; return; }
    if (pill.querySelector('.relay-qr-btn')) return;
    // Next to the emoji button, before the text field.
    let cell = input;
    while (cell.parentElement && cell.parentElement !== pill) cell = cell.parentElement;
    qrBtn = el('button', {
      class: 'relay-qr-btn', type: 'button', title: 'Quick replies',
      attrs: { 'aria-label': 'Quick replies', 'aria-haspopup': 'menu', 'aria-expanded': 'false' },
      on: { click: (e) => { e.preventDefault(); e.stopPropagation(); toggleQr(); } }
    }, icon('bolt', 22));
    pill.insertBefore(qrBtn, cell);
  }

  function place() {
    if (!panel || !railBtn) return;
    const r = railBtn.getBoundingClientRect();
    panel.style.left = Math.round(r.right + 12) + 'px';
    panel.style.bottom = Math.max(12, Math.round(innerHeight - r.bottom)) + 'px';
    panel.style.maxHeight = Math.min(620, Math.max(240, Math.round(r.bottom - 12))) + "px";
  }

  function open() {
    if (panel && panel.isConnected) return;
    panel = null;                       // a stale reference (the page dropped the panel) must not block reopening
    panel = el('div', { class: 'relay-panel', attrs: { role: 'dialog', 'aria-label': 'Relay' } });
    document.body.append(panel);
    railBtn.setAttribute('aria-expanded', 'true');
    place();
    render();
  }

  function close() {
    if (!panel) return;
    panel.remove();
    panel = null;
    if (railBtn) railBtn.setAttribute('aria-expanded', 'false');
  }

  const toggle = () => (panel && panel.isConnected ? close() : open());

  function mountRail() {
    const foot = document.querySelector('[data-testid="navbar-footer-section"] > div');
    if (!foot || foot.querySelector('.relay-rail-btn')) return;
    railBtn = el('button', {
      class: 'relay-rail-btn', type: 'button', title: 'Relay',
      attrs: { 'aria-label': 'Relay', 'aria-expanded': 'false', 'aria-haspopup': 'dialog' },
      on: { click: (e) => { e.stopPropagation(); toggle(); } }
    }, el('span', { class: 'relay-mark' }));
    foot.insertBefore(railBtn, foot.firstElementChild);
    paintDot(R.state);
  }

  function paintDot(s) { if (railBtn) railBtn.dataset.dot = s && s.dnd ? '1' : ''; }

  document.addEventListener('pointerdown', (e) => {
    if (panel && !panel.contains(e.target) && !(railBtn && railBtn.contains(e.target))) close();
    if (qrPop && !qrPop.contains(e.target) && !(qrBtn && qrBtn.contains(e.target))) closeQr();
  }, true);
  addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (panel) close(); if (qrPop) closeQr(); } });
  addEventListener('resize', place);

  R.hub = { open, close, toggle };
  R.subscribe((s) => { paintDot(s); render(); renderQr(); });

  let mountTimer = 0;
  new MutationObserver(() => { if (!mountTimer) mountTimer = setTimeout(() => { mountTimer = 0; mountRail(); mountCompose(); }, 300); })
    .observe(document.getElementById('app') || document.body, { childList: true, subtree: true });
  mountRail();
  mountCompose();
})();
