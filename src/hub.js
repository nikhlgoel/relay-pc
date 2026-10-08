'use strict';
/*
 * Main-process half of the in-app "Relay" panel (page side: src/page/*.js).
 *
 * The panel holds the switches that used to live only in the tray: translation,
 * do-not-disturb, noise suppression, camera, recording, plus quick replies. This
 * file owns their state, asks for consent before any chat text leaves the PC,
 * stores the optional API key encrypted (Windows DPAPI via safeStorage), and
 * proxies translation requests so the page never sees the key.
 *
 * Every channel is `relay:*` and is only honoured from WhatsApp's own page.
 */

const { translateBatch, MAX_TEXT } = require('./translate');

// In order of preference: free-with-your-key first, then paid, then the keyless fallback.
const PROVIDERS = {
  openrouter: { name: 'OpenRouter (free models)', host: 'openrouter.ai', needsKey: true,
    note: 'Free models on OpenRouter may keep prompts to improve their models.' },
  claude: { name: 'Claude (Anthropic)', host: 'api.anthropic.com', needsKey: true, note: '' },
  google: { name: 'Google Translate', host: 'translate.googleapis.com', needsKey: false, note: '' }
};
/** A proxy address Chromium accepts: host:port, optionally with http://, https://, socks4:// or socks5://. '' = follow Windows. null = invalid. */
function cleanProxy(v) {
  const t = String(v == null ? '' : v).trim();
  if (!t) return '';
  return /^((https?|socks4|socks5):\/\/)?([A-Za-z0-9-]+\.)*[A-Za-z0-9-]+:\d{1,5}$/i.test(t) && Number(t.split(':').pop()) <= 65535 ? t : null;
}
const MAX_SNIPPETS = 40;
const MAX_SNIPPET_LEN = 1000;

// Switches the page may flip, and the store key each one lives under.
const SWITCHES = {
  dnd: 'dnd',
  noise: 'noiseSuppression',
  camera: 'enhanceCamera',
  mic: 'enhanceMic',
  sharpVideo: 'sharpVideo',
  autoRecord: 'autoRecord',
  translateAll: 'translateAll'
};

/** Whatever is stored, the page only ever sees a short list of { id, text } strings. */
function cleanSnippets(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, MAX_SNIPPETS)
    .filter((s) => s && typeof s.text === 'string' && s.text.trim())
    .map((s) => ({ id: String(s.id || '').slice(0, 24) || Math.random().toString(36).slice(2, 10), text: s.text.slice(0, MAX_SNIPPET_LEN) }));
}

function setupHub(ctx) {
  const { store, safeStorage, net, handle, send, showBox, promptKey, afterChange, extraState, applyProxy, relaunch } = ctx;
  const cache = new Map();              // "provider\0text" -> result, newest last

  const consented = (p) => Boolean((store.get('translateConsent') || {})[p]);

  // One stored key per provider, encrypted. (The first version kept a single Claude key.)
  const keys = () => {
    const k = { ...(store.get('translateKeys') || {}) };
    if (!k.claude && store.get('translateKeyEnc')) k.claude = store.get('translateKeyEnc');
    return k;
  };
  const hasKey = (p) => Boolean(keys()[p]);

  /** Your pick if you made one; otherwise the first provider you have a key for; otherwise Google. */
  function provider() {
    const choice = store.get('translateChoice');
    if (typeof choice === 'string' && Object.hasOwn(PROVIDERS, choice)) return choice;
    return Object.keys(PROVIDERS).find((p) => PROVIDERS[p].needsKey && hasKey(p)) || 'google';
  }

  function apiKey(p) {
    const enc = keys()[p];
    if (!enc || !safeStorage.isEncryptionAvailable()) return '';
    try { return safeStorage.decryptString(Buffer.from(enc, 'base64')); } catch (e) { return ''; }
  }

  function state() {
    const p = provider();
    return {
      dnd: Boolean(store.get('dnd')),
      noise: Boolean(store.get('noiseSuppression')),
      camera: Boolean(store.get('enhanceCamera')),
      mic: Boolean(store.get('enhanceMic')),
      sharpVideo: store.get('sharpVideo') !== false,
      proxy: cleanProxy(store.get('proxy')) || '',
      waLang: store.get('waLang') === 'en' ? 'en' : 'auto',
      autoRecord: Boolean(store.get('autoRecord')),
      translate: {
        all: Boolean(store.get('translateAll')),
        provider: p,
        providerName: PROVIDERS[p].name,
        hasKey: !PROVIDERS[p].needsKey || hasKey(p),
        providers: Object.keys(PROVIDERS).map((id) => ({ id, name: { openrouter: 'OpenRouter', claude: 'Claude', google: 'Google' }[id], needsKey: PROVIDERS[id].needsKey, hasKey: hasKey(id) })),
        keyStorage: safeStorage.isEncryptionAvailable(),
        consent: consented(p)
      },
      snippets: cleanSnippets(store.get('snippets')),
      ...(extraState ? extraState() : {})            // e.g. { captions } from src/captions.js
    };
  }

  const push = () => send('relay:state', state());

  handle('relay:state', () => state());

  handle('relay:set', async (_e, name, value) => {
    const key = SWITCHES[name];
    if (!key || typeof value !== 'boolean') throw new Error('Unknown setting');
    store.set(key, value);
    afterChange(name, value);
    return state();
  });

  // --- WhatsApp's language: Relay's call extras need the English button names ---------------
  handle('relay:wa-lang', async (_e, value) => {
    if (value !== 'en' && value !== 'auto') throw new Error('Unknown language choice');
    if (store.get('waLang') === value || (value === 'auto' && store.get('waLang') !== 'en')) { store.set('waLang', value); return state(); }
    store.set('waLang', value);
    const { response } = await showBox({
      type: 'question', title: 'Relay', message: 'Restart Relay to change the language of WhatsApp?',
      detail: 'Your chats and drafts are kept.', buttons: ['Restart now', 'Later'], defaultId: 0, cancelId: 1
    });
    if (response === 0 && relaunch) relaunch();
    return state();
  });

  // --- network: for places where WhatsApp needs a VPN or proxy ----------------------------
  handle('relay:proxy-set', async (_e, value) => {
    const v = cleanProxy(value);
    if (v === null) throw new Error('Use the form 127.0.0.1:7890 or socks5://127.0.0.1:1080');
    if (v && v !== cleanProxy(store.get('proxy'))) {
      // All of Relay's traffic would go through it: only the person at the keyboard may do that, not a script in the page.
      const { response } = await showBox({
        type: 'question', title: 'Proxy', message: 'Send all Relay traffic through ' + v + '?',
        detail: 'WhatsApp and the downloads will use this proxy until you change it in the Relay panel.', buttons: ['Use this proxy', 'Cancel'], defaultId: 1, cancelId: 1
      });
      if (response !== 0) return state();
    }
    if (v) store.set('proxy', v); else store.delete('proxy');
    if (applyProxy) await applyProxy();
    afterChange('proxy', v);
    return state();
  });

  // --- translation ---------------------------------------------------------
  handle('relay:translate-provider', (_e, p) => {
    if (typeof p !== 'string' || !Object.hasOwn(PROVIDERS, p)) throw new Error('Unknown provider');
    store.set('translateChoice', p);
    if (!consented(p)) store.set('translateAll', false);               // "all chats" must be re-confirmed for a new translator
    afterChange('translateProvider', p);
    return state();
  });

  /** One-time notice per provider: chat text leaves this PC for that service. */
  handle('relay:translate-consent', async () => {
    const p = provider();
    if (consented(p)) return true;
    if (PROVIDERS[p].needsKey && !hasKey(p)) return false;
    const { response } = await showBox({
      type: 'question',
      title: 'Translate chats',
      message: 'Messages you translate are sent to ' + PROVIDERS[p].name + '.',
      detail: 'Only the text of messages in chats where translation is on is sent, to ' +
        PROVIDERS[p].host + ', so it can be translated. Nothing is stored by Relay, and your ' +
        'own messages are never sent. Turn translation off at any time in the Relay panel.\n\n' +
        (PROVIDERS[p].note ? PROVIDERS[p].note + '\n\n' : '') +
        'Messages from other people may be private to them as well. Only translate chats where that is fine.',
      buttons: ['Allow', 'Cancel'],
      defaultId: 1,
      cancelId: 1
    });
    if (response !== 0) return false;
    store.set('translateConsent', { ...(store.get('translateConsent') || {}), [p]: true });
    push();
    return true;
  });

  // The key is typed into a native window (ctx.promptKey), never into the page, so
  // WhatsApp's scripts cannot read it.
  function setKey(p, key) {
    if (typeof p !== 'string' || !Object.hasOwn(PROVIDERS, p) || !PROVIDERS[p].needsKey) throw new Error('Unknown provider');
    key = typeof key === 'string' ? key.trim().replace(/^bearer\s+/i, '') : key;       // pasted straight from a curl example
    if (typeof key !== 'string' || !/^[\w.-]{20,300}$/.test(key)) throw new Error('That does not look like an API key');
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure storage is not available on this PC');
    store.set('translateKeys', { ...keys(), [p]: safeStorage.encryptString(key).toString('base64') });
    afterChange('translateKey', true);
  }

  handle('relay:key-prompt', async (_e, p) => {
    if (typeof p !== 'string' || !Object.hasOwn(PROVIDERS, p) || !PROVIDERS[p].needsKey) throw new Error('Unknown provider');
    const key = await promptKey(p);
    if (key) setKey(p, key);
    return state();
  });

  handle('relay:key-clear', (_e, p) => {
    if (typeof p !== 'string' || !Object.hasOwn(PROVIDERS, p)) throw new Error('Unknown provider');
    const k = keys();
    delete k[p];
    store.set('translateKeys', k);
    if (p === 'claude') store.delete('translateKeyEnc');
    const c = { ...(store.get('translateConsent') || {}) };
    delete c[p];
    store.set('translateConsent', c);
    afterChange('translateKey', false);
    return state();
  });

  handle('relay:translate', async (_e, texts) => {
    if (!Array.isArray(texts) || texts.length === 0 || texts.length > 40 ||
        texts.some((t) => typeof t !== 'string')) throw new Error('Bad request');
    texts = texts.map((t) => (t.length > MAX_TEXT ? '' : t));           // too long to translate: left alone
    const p = provider();
    if (!consented(p)) throw new Error('Turn translation off and on again to allow ' + PROVIDERS[p].name);
    const out = new Array(texts.length);
    const miss = [];
    texts.forEach((t, i) => {
      const hit = cache.get(p + '\0' + t);
      if (hit) out[i] = hit; else miss.push(i);
    });
    if (miss.length) {
      const got = await translateBatch(miss.map((i) => texts[i]), {
        provider: p,
        apiKey: PROVIDERS[p].needsKey ? apiKey(p) : '',
        fetch: net.fetch.bind(net)
      });
      miss.forEach((i, k) => {
        out[i] = got[k];
        cache.set(p + '\0' + texts[i], got[k]);
      });
      while (cache.size > 600) cache.delete(cache.keys().next().value);
    }
    return out;
  });

  // --- quick replies ---------------------------------------------------------
  handle('relay:snippets', (_e, list) => {
    if (!Array.isArray(list) || list.length > MAX_SNIPPETS) throw new Error('Too many quick replies');
    const clean = list.map((s) => ({
      id: String((s && s.id) || '').slice(0, 24) || Math.random().toString(36).slice(2, 10),
      text: String((s && s.text) || '').slice(0, MAX_SNIPPET_LEN)
    })).filter((s) => s.text.trim());
    store.set('snippets', clean);
    push();
    return clean;
  });

  return { state, push };
}

module.exports = { setupHub, PROVIDERS, cleanSnippets, cleanProxy };
