'use strict';
/*
 * Local text translation for live call translation (loaded by src/voice-engine.js).
 *
 *   primary   TranslateGemma 4B (Google, Gemma Terms of Use), one 2.5 GB GGUF file run by llama.cpp
 *             through @fugood/llama.node - on the graphics card with Vulkan, or on the processor.
 *             Any language to any language; the source language may be 'auto'.
 *   fallback  OPUS-MT (Helsinki-NLP, small per-pair models) through @huggingface/transformers on the
 *             processor, when the GGUF or llama.node cannot be used. Good for English <-> Chinese,
 *             Russian, Spanish, French, German, Arabic; poor for Hindi; some pairs do not exist.
 *
 * Nothing here sends text anywhere: the only network use is downloading models. The text to translate
 * is UNTRUSTED data (it is what the other person said): it is never treated as an instruction, special
 * tokens are taken out of it, and an answer that is far longer than the question is cut.
 *
 * The GGUF is saved in `modelsDir` under a name starting with 'translategemma' (src/voice.js looks for
 * that). While it downloads it is called 'incomplete-translategemma-....part', so a half-downloaded
 * file is never mistaken for the model; it gets its real name only after its size and SHA-256 match.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createRequire } = require('module');
const { pathToFileURL } = require('url');

// --- models ---------------------------------------------------------------------------------

const GGUF_FILE = 'translategemma-4b-it-Q4_K_M.gguf';
const GGUF_PATH = 'bullerwins/translategemma-4b-it-GGUF/resolve/main/' + GGUF_FILE;
// Same file, same SHA-256. hf-mirror.com is reachable from mainland China when huggingface.co is not.
const HOSTS = ['https://huggingface.co/', 'https://hf-mirror.com/'];
const PART_PREFIX = 'incomplete-';
const STALL_MS = 30000;          // a download that delivers nothing for this long is given up (and resumed from the next server)
const CONNECT_MS = 15000;        // a server that has not answered by then is skipped for the next one

const MODELS = {
  translategemma: {
    file: GGUF_FILE,
    url: HOSTS[0] + GGUF_PATH,
    mirrors: HOSTS.map((h) => h + GGUF_PATH),
    bytes: 2489909312,
    mb: 2490,
    sha256: '7f7357c14abd9da4eb200b38b05da502cd6e10d7e1d403fbc9f78c19f3209b72',
    licence: 'Gemma Terms of Use (https://ai.google.dev/gemma/terms); quantised GGUF by bullerwins of google/translategemma-4b-it',
    runtime: '@fugood/llama.node (MIT), Vulkan or CPU'
  },
  opus: {
    // Fallback only. Small per-pair models fetched on first use into <modelsDir>/opus-mt (about 80-150 MB per pair).
    repo: 'Xenova/opus-mt-{src}-{tgt}',
    licence: 'Helsinki-NLP OPUS-MT: Apache-2.0 or CC-BY-4.0 depending on the pair',
    runtime: '@huggingface/transformers (Apache-2.0), CPU'
  }
};

// OPUS-MT pairs that exist as ready-made ONNX models (Xenova/opus-mt-*). Japanese is 'jap' in English->Japanese.
const OPUS_PAIRS = new Set([
  'zh-en', 'ru-en', 'es-en', 'fr-en', 'de-en', 'ar-en', 'ko-en', 'tr-en', 'ja-en', 'hi-en',
  'en-zh', 'en-ru', 'en-es', 'en-fr', 'en-de', 'en-ar', 'en-hi', 'en-jap',
  'fr-de', 'de-fr', 'es-de', 'de-es', 'es-fr', 'fr-es', 'es-ru', 'ru-es', 'fr-ru', 'ru-fr'
]);
const opusCode = (from, to) => (from === 'en' && to === 'ja' ? 'en-jap' : from + '-' + to);

/**
 * What can be translated. `opus` is the quality of the OPUS-MT fallback to and from English:
 * 'good', 'poor' (it works but is often wrong - Hindi), 'from-en'/'to-en' (one direction only) or 'none'.
 * TranslateGemma handles all of them (it is weaker on short, informal speech in low-resource languages).
 */
const LANGS = [
  { code: 'en', name: 'English', opus: 'good' },
  { code: 'hi', name: 'Hindi', opus: 'poor', note: 'OPUS-MT Hindi is poor - TranslateGemma is needed for usable Hindi' },
  { code: 'zh', name: 'Chinese', opus: 'good' },
  { code: 'ru', name: 'Russian', opus: 'good' },
  { code: 'es', name: 'Spanish', opus: 'good' },
  { code: 'fr', name: 'French', opus: 'good' },
  { code: 'de', name: 'German', opus: 'good' },
  { code: 'ar', name: 'Arabic', opus: 'good' },
  { code: 'ja', name: 'Japanese', opus: 'poor', note: 'OPUS-MT Japanese is weak' },
  { code: 'ko', name: 'Korean', opus: 'to-en' },
  { code: 'pt', name: 'Portuguese', opus: 'none' },
  { code: 'tr', name: 'Turkish', opus: 'to-en' },
  { code: 'bn', name: 'Bengali', opus: 'none' },
  { code: 'ur', name: 'Urdu', opus: 'none' },
  { code: 'it', name: 'Italian', opus: 'none' },
  { code: 'nl', name: 'Dutch', opus: 'none' },
  { code: 'pl', name: 'Polish', opus: 'none' },
  { code: 'uk', name: 'Ukrainian', opus: 'none' },
  { code: 'fa', name: 'Persian', opus: 'none' },
  { code: 'he', name: 'Hebrew', opus: 'none' },
  { code: 'el', name: 'Greek', opus: 'none' },
  { code: 'id', name: 'Indonesian', opus: 'none' },
  { code: 'ms', name: 'Malay', opus: 'none' },
  { code: 'vi', name: 'Vietnamese', opus: 'none' },
  { code: 'th', name: 'Thai', opus: 'none' },
  { code: 'sw', name: 'Swahili', opus: 'none' },
  { code: 'ta', name: 'Tamil', opus: 'none' },
  { code: 'te', name: 'Telugu', opus: 'none' },
  { code: 'mr', name: 'Marathi', opus: 'none' },
  { code: 'gu', name: 'Gujarati', opus: 'none' },
  { code: 'kn', name: 'Kannada', opus: 'none' },
  { code: 'ml', name: 'Malayalam', opus: 'none' },
  { code: 'pa', name: 'Punjabi', opus: 'none' },
  { code: 'ne', name: 'Nepali', opus: 'none' }
];
const LANG_NAME = new Map(LANGS.map((l) => [l.code, l.name]));

const CACHE_SIZE = 200;
const TIMEOUT_MS = 8000;
const CHUNK_CHARS = 240;         // longer text is translated sentence group by sentence group (n_ctx is only 512)
const MAX_INPUT_CHARS = 2000;    // a live-call clip is 8-15 s of speech; anything far longer is not one
const N_CTX = 512;

// --- pure helpers (unit tested) ---------------------------------------------------------------

/** 'zh-CN', 'ZH_tw', ' en ' -> 'zh', 'zh', 'en'; anything unknown -> ''. */
function normLang(code) {
  const c = String(code == null ? '' : code).trim().toLowerCase().split(/[-_]/)[0];
  if (c === 'auto') return 'auto';
  if (c === 'iw') return 'he';
  if (c === 'jw' || c === 'jv') return '';
  return LANG_NAME.has(c) ? c : '';
}

// Function words for telling Latin-script languages apart (a short clip has few words, so these are short too).
const STOP = {
  en: 'the and is are you to of it that in what for this have we with be not my me do can will was i your how he she they there no yes'.split(' '),
  es: 'el la los las que y es en un una por para con no mi yo tu está pero muy qué cómo se lo del al te me sí eso hay estoy'.split(' '),
  fr: 'le la les des et est je tu vous nous un une pas que qui ce c\'est pour avec mais très il elle ne du au suis oui ça j\'ai'.split(' '),
  de: 'der die das und ist ich du nicht ein eine zu mit auf es wir sie was wie den dem auch haben bin ja nein sehr aber noch'.split(' '),
  pt: 'o os as que e é em um uma não para com você eu do da no na mas muito está isso sim eles ela obrigado'.split(' '),
  it: 'il lo che è di un una non per con sono ho mi ti ma molto questo come gli sì grazie anche'.split(' '),
  tr: 've bir bu ne mi ben sen için çok var yok değil ile nasıl evet hayır şey ama da de gibi'.split(' '),
  nl: 'de het een en is ik je niet van dat wat op te met zijn maar ook er hij wij jij'.split(' '),
  id: 'yang dan di ini itu saya kamu tidak ada dengan untuk apa ke akan sudah aku bisa'.split(' ')
};
const DIACRITIC_HINTS = [
  [/[ñ¿¡]/i, 'es', 3], [/[ãõ]/i, 'pt', 3], [/[ğışİ]/, 'tr', 3], [/ß/, 'de', 3], [/[äöü]/i, 'de', 1],
  [/[èêëœ]/i, 'fr', 2], [/[àùç]/i, 'fr', 1], [/[ç]/i, 'pt', 1], [/[öüç]/i, 'tr', 1], [/[ìò]/i, 'it', 2]
];

/**
 * A best guess at the language of a short piece of text, from its script (and, for Latin script, its
 * function words). Returns a code from LANGS, or '' when it cannot tell.
 */
function detectLanguage(text) {
  const s = String(text || '');
  const count = (re) => (s.match(re) || []).length;
  const scripts = [
    ['hi', count(/[ऀ-ॿ]/g)], ['bn', count(/[ঀ-৿]/g)], ['pa', count(/[਀-੿]/g)],
    ['gu', count(/[઀-૿]/g)], ['ta', count(/[஀-௿]/g)], ['te', count(/[ఀ-౿]/g)],
    ['kn', count(/[ಀ-೿]/g)], ['ml', count(/[ഀ-ൿ]/g)], ['th', count(/[฀-๿]/g)],
    ['ko', count(/[가-힯ᄀ-ᇿ㄰-㆏]/g)], ['kana', count(/[぀-ヿ]/g)],
    ['han', count(/[一-鿿㐀-䶿]/g)], ['cyr', count(/[Ѐ-ӿ]/g)],
    ['arab', count(/[؀-ۿݐ-ݿ]/g)], ['he', count(/[֐-׿]/g)], ['el', count(/[Ͱ-Ͽ]/g)],
    ['latin', count(/[A-Za-zÀ-ɏ]/g)]
  ].sort((a, b) => b[1] - a[1]);
  const [top, n] = scripts[0];
  if (!n) return '';
  if (top === 'kana' || (top === 'han' && count(/[぀-ヿ]/g) > 0)) return 'ja';
  if (top === 'han') return 'zh';
  if (top === 'cyr') return /[іїєґ]/i.test(s) ? 'uk' : 'ru';
  if (top === 'arab') {
    if (/[ےںٹڈڑھہۓ]/.test(s)) return 'ur';      // ے ں ٹ ڈ ڑ ھ ہ ۓ
    if (/[پچژگکی]/.test(s)) return 'fa';                  // پ چ ژ گ ک ی
    return 'ar';
  }
  if (top !== 'latin') return top;
  const words = s.toLowerCase().replace(/[’]/g, '\'').match(/[\p{L}']+/gu) || [];
  const score = Object.fromEntries(Object.keys(STOP).map((k) => [k, 0]));
  for (const w of words) for (const k of Object.keys(STOP)) if (STOP[k].includes(w)) score[k] += 1;
  for (const [re, k, pts] of DIACRITIC_HINTS) if (re.test(s)) score[k] += pts;
  const ranked = Object.entries(score).sort((a, b) => b[1] - a[1]);
  if (!ranked[0][1] || ranked[0][1] === ranked[1][1]) return ranked[0][1] && ranked[0][0] === 'en' ? 'en' : '';
  return ranked[0][0];
}

/** How "long" a text is, counting a Chinese/Japanese/Korean character as 3 (it carries about a word). */
function textWeight(s) {
  let w = 0;
  for (const ch of String(s || '')) w += /[ᄀ-ᇿ぀-ヿ㄰-㆏㐀-䶿一-鿿가-힯豈-﫿]/.test(ch) ? 3 : 1;
  return w;
}

/**
 * The text is data, not a prompt: chat-control tokens (<start_of_turn>, <end_of_turn>, <bos>, <unused12>,
 * <start_of_image> ...) are removed so it cannot close the user turn and speak as the model.
 */
function sanitizeInput(text) {
  let t = String(text == null ? '' : text).normalize('NFC');
  t = t.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩﻿]/g, '');
  let prev;
  do { prev = t; t = t.replace(/<\s*\/?\s*\|?\s*(?:start_of_turn|end_of_turn|start_of_image|end_of_image|image_soft_token|bos|eos|pad|unk|mask|unused\d*|\[multimodal\])\s*\|?\s*>/gi, ' '); } while (t !== prev);
  t = t.replace(/\[multimodal\]/gi, ' ');
  return t.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim().slice(0, MAX_INPUT_CHARS);
}

/**
 * The exact prompt TranslateGemma was trained on (its chat template, written out so no template engine is
 * involved). `from` '' = unknown source language: the same wording without naming it.
 */
function buildPrompt(text, from, to) {
  const T = LANG_NAME.get(to);
  if (!T) throw new Error('Unsupported language: ' + to);
  const S = from ? LANG_NAME.get(from) : '';
  const head = S
    ? 'You are a professional ' + S + ' (' + from + ') to ' + T + ' (' + to + ') translator. Your goal is to accurately convey the meaning and ' +
      'nuances of the original ' + S + ' text while adhering to ' + T + ' grammar, vocabulary, and cultural sensitivities.\n' +
      'Produce only the ' + T + ' translation, without any additional explanations or commentary. Please translate the following ' + S + ' text into ' + T + ':\n\n\n'
    : 'You are a professional translator into ' + T + ' (' + to + '). Your goal is to accurately convey the meaning and ' +
      'nuances of the original text while adhering to ' + T + ' grammar, vocabulary, and cultural sensitivities.\n' +
      'Produce only the ' + T + ' translation, without any additional explanations or commentary. Please translate the following text into ' + T + ':\n\n\n';
  // <bos> is added by the tokenizer (add_bos_token = true).
  return '<start_of_turn>user\n' + head + String(text).trim() + '<end_of_turn>\n<start_of_turn>model\n';
}

const QUOTES = [['"', '"'], ['“', '”'], ['„', '“'], ['«', '»'], ['「', '」'], ['『', '』'], ['\'', '\''], ['‘', '’']];

/** Cuts `t` to at most `max` weight units, at a sentence end or a space when there is one near the end. */
function cutToWeight(t, max) {
  if (textWeight(t) <= max) return t;
  let w = 0, i = 0;
  const chars = Array.from(t);
  for (; i < chars.length; i++) { w += textWeight(chars[i]); if (w > max) break; }
  let out = chars.slice(0, i).join('');
  const end = Math.max(out.search(/[.!?。！？][^.!?。！？]*$/), -1);
  if (end > out.length * 0.6) out = out.slice(0, end + 1);
  else { const sp = out.lastIndexOf(' '); if (sp > out.length * 0.6) out = out.slice(0, sp); }
  return out.trim();
}

/**
 * The model's answer -> just the translation. Removes turn markers, "Here is the translation:" style
 * preambles, notes and explanations, quotes the input did not have, and markdown; then caps the length at
 * 4x the input (by weight, so Chinese -> English is not cut short), because a model that was talked into
 * doing something else tends to say much more than the input did.
 */
function cleanOutput(raw, input) {
  const src = String(input || '').trim();
  let t = String(raw == null ? '' : raw);
  const stop = t.search(/<(?:end_of_turn|start_of_turn|eos|bos)>/);
  if (stop >= 0) t = t.slice(0, stop);
  t = t.replace(/<[a-z_]+\d*>/gi, ' ').replace(/\r/g, '').trim();
  t = t.replace(/^\s*model\s*\n/i, '');
  t = t.replace(/^(?:(?:sure|okay|ok|certainly)[,!.]?\s*)?(?:here(?:'s| is) (?:the |my |your |a )?(?:[a-z]+ )?translation[^:\n]{0,60}:|(?:[a-z]+ )?translation\s*(?:\([^)\n]{0,40}\))?\s*:)\s*/i, '');
  // A one-line input has a one-line answer: anything after a blank line is commentary.
  if (!/\n/.test(src)) {
    t = t.split(/\n\s*\n/)[0];
    t = t.split('\n').filter((l) => !/^\s*(?:\(?\s*(?:note|explanation|translation note|literal(?:ly)?|alternative(?:ly)?)\b)/i.test(l)).join(' ');
  }
  t = t.replace(/\s*\((?:note|literally|lit\.)[^)]*\)\s*$/i, '');
  t = t.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/^#+\s*/, '').replace(/[ \t]+/g, ' ').trim();
  const inputQuoted = QUOTES.some(([a, b]) => src.startsWith(a) && src.endsWith(b));
  if (!inputQuoted) {
    for (const [a, b] of QUOTES) {
      if (t.length >= 2 && t.startsWith(a) && t.endsWith(b) && !t.slice(1, -1).includes(b === a ? a : b)) { t = t.slice(1, -1).trim(); break; }
    }
  }
  return cutToWeight(t, Math.max(4 * textWeight(src), 24));
}

/** Splits long text into pieces of at most `max` characters, at sentence ends where possible. */
function splitChunks(text, max = CHUNK_CHARS) {
  const t = String(text || '').trim();
  if (t.length <= max) return t ? [t] : [];
  const sentences = t.match(/[^.!?。！？।\n]+(?:[.!?。！？।]+|\n|$)\s*/g) || [t];
  const out = [];
  let cur = '';
  const push = () => { if (cur.trim()) out.push(cur.trim()); cur = ''; };
  for (let s of sentences) {
    while (s.length > max) {                       // one huge "sentence": cut at a space (or hard)
      const sp = s.lastIndexOf(' ', max);
      const at = sp > max * 0.5 ? sp : max;
      push(); out.push(s.slice(0, at).trim()); s = s.slice(at);
    }
    if ((cur + s).length > max) push();
    cur += s;
  }
  push();
  return out.filter(Boolean);
}

/** A small least-recently-used cache. */
function createLru(max = CACHE_SIZE) {
  const m = new Map();
  return {
    get(k) { if (!m.has(k)) return undefined; const v = m.get(k); m.delete(k); m.set(k, v); return v; },
    set(k, v) { m.delete(k); m.set(k, v); while (m.size > max) m.delete(m.keys().next().value); },
    get size() { return m.size; },
    clear() { m.clear(); }
  };
}

/**
 * One job at a time (the model has one context; the graphics card is shared). `task(deadlineAt)` returns
 * { result, settled }: `result` is what the caller gets, `settled` is when the model is free again (a job
 * that timed out is still stopping). A job whose deadline passed while it waited is not started at all.
 */
function createSerialQueue() {
  let tail = Promise.resolve();
  return function enqueue(task, deadlineAt) {
    let expired = false;
    const started = tail.then(() => {
      if (expired || (deadlineAt && Date.now() >= deadlineAt)) return { result: Promise.reject(new Error('The translator took too long')), settled: Promise.resolve() };
      try { return task(deadlineAt); } catch (e) { return { result: Promise.reject(e), settled: Promise.resolve() }; }
    });
    tail = started.then((h) => h.settled).catch(() => {}).then(() => {});
    const result = started.then((h) => h.result);
    // The caller's limit also counts the time spent waiting behind other jobs.
    return deadlineAt ? withDeadline(result, deadlineAt, () => { expired = true; }) : result;
  };
}

/** Rejects with a plain-language timeout once `ms` have passed; `onTimeout` stops the work. */
function withDeadline(promise, deadlineAt, onTimeout) {
  promise.catch(() => {});                       // a late failure after the deadline is not an unhandled rejection
  const left = deadlineAt - Date.now();
  if (left <= 0) { try { onTimeout && onTimeout(); } catch (e) { /* ignore */ } return Promise.reject(new Error('The translator took too long')); }
  let timer;
  const t = new Promise((_, reject) => {
    timer = setTimeout(() => { try { onTimeout && onTimeout(); } catch (e) { /* ignore */ } reject(new Error('The translator took too long')); }, left);
  });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}

/** The OPUS-MT model chain for a pair: direct, or through English. null when there is none. */
function opusRoute(from, to) {
  if (from === to) return [];
  if (OPUS_PAIRS.has(opusCode(from, to))) return [opusCode(from, to)];
  if (from !== 'en' && to !== 'en' && OPUS_PAIRS.has(opusCode(from, 'en')) && OPUS_PAIRS.has(opusCode('en', to))) return [opusCode(from, 'en'), opusCode('en', to)];
  return null;
}

/**
 * Which Vulkan device to use: the discrete card with the most memory, or none. Integrated graphics are not
 * used: measured on an Intel Raptor Lake iGPU it generated 3.7 words-pieces/s, slower than the processor.
 */
function pickVulkanDevice(devices) {
  const list = (Array.isArray(devices) ? devices : []).filter((d) => d && d.backend === 'Vulkan' && d.type === 'gpu' && typeof d.deviceName === 'string');
  return list.sort((a, b) => (b.maxMemorySize || 0) - (a.maxMemorySize || 0))[0] || null;
}

/**
 * How many of the model's 35 layers (34 blocks + output) go on the graphics card. All of them take about
 * 2.4 GB (+ ~150 MB working memory); the card is shared with Whisper and the voice engine, so the model
 * takes at most ~2.9 GB and leaves 1.5 GB of the card free. A smaller card gets some layers (the rest
 * run on the processor, slower); under ~1 GB of room it is not worth it (0 = processor only).
 */
function gpuLayersFor(dev) {
  if (!dev || dev.type !== 'gpu') return 0;
  const mib = (dev.maxMemorySize || 0) / (1024 * 1024);
  const room = Math.min(2900, mib - 1536);
  if (room >= 2600) return 99;
  if (room < 1000) return 0;
  return Math.max(1, Math.min(34, Math.floor((room - 250) / 55)));   // ~54 MB per block; the output layer (~0.5 GB) then stays on the CPU
}

// --- loading the optional packages --------------------------------------------------------------

/** require() for a package that may live outside the app (RELAY_MT_MODULES / options.modulesDir - used by tests). */
function packageRequire(name, modulesDir) {
  const bases = [modulesDir, process.env.RELAY_MT_MODULES, __dirname].filter(Boolean);
  let last = null;
  for (const b of bases) {
    try {
      const req = createRequire(path.join(path.resolve(b), '__relay_mt__.js'));
      return { req, resolved: req.resolve(name) };
    } catch (e) { last = e; }
  }
  throw Object.assign(new Error(name + ' is not installed'), { cause: last, missing: true });
}

// --- the download -------------------------------------------------------------------------------

const downloads = new Map();     // final path -> Promise

const modelPath = (dir) => path.join(dir, MODELS.translategemma.file);
function modelReady(dir) {
  try { return fs.statSync(modelPath(dir)).size === MODELS.translategemma.bytes; } catch (e) { return false; }
}

function plainDownloadError(err) {
  const msg = String((err && err.message) || err);
  if (err && err.plain) return err;
  if (/ENOSPC/i.test(msg)) return Object.assign(new Error('There is not enough free disk space for the translation model (it needs about 2.5 GB)'), { plain: true });
  if (/EACCES|EPERM|EBUSY/i.test(msg)) return Object.assign(new Error('The translation model could not be saved (the folder is locked or read-only)'), { plain: true });
  if (/stalled|timed? ?out|abort/i.test(msg)) return Object.assign(new Error('The download of the translation model stalled - check the internet connection and try again (it continues where it stopped)'), { plain: true });
  if (/ERR_INTERNET|ERR_NAME|ERR_CONNECTION|ERR_NETWORK|ENOTFOUND|ECONNRESET|ECONNREFUSED|EAI_AGAIN|fetch failed|network/i.test(msg)) {
    return Object.assign(new Error('No internet connection - the translation model could not be downloaded'), { plain: true });
  }
  return err instanceof Error ? err : new Error(msg);
}

/** Feeds the bytes already on disk into `hash` (resuming a download). */
async function hashFile(file, hash) {
  await new Promise((resolve, reject) => {
    const s = fs.createReadStream(file, { highWaterMark: 4 << 20 });
    s.on('data', (d) => hash.update(d));
    s.on('error', reject);
    s.on('end', resolve);
  });
}

function preferredOrder(urls) {
  let zh = false;
  try { zh = /^zh/i.test(Intl.DateTimeFormat().resolvedOptions().locale || '') || /^zh/i.test(process.env.LANG || ''); } catch (e) { /* default order */ }
  return zh ? urls.slice().reverse() : urls.slice();
}

/**
 * Makes sure the TranslateGemma GGUF is in `dir` (downloading it once, 2.5 GB). Checks the size and SHA-256,
 * writes to 'incomplete-<file>.part' and renames only when both match, tries huggingface.co then hf-mirror.com
 * (the reverse on a Chinese system), resumes a broken download, gives up on a server that stalls.
 * onProgress(fraction 0..1). Resolves to the model's path. Options (for tests): fetch, urls, stallMs, connectMs, model.
 */
function ensureModel(dir, onProgress, opts = {}) {
  const m = opts.model || MODELS.translategemma;
  const final = path.join(dir, m.file);
  if (downloads.has(final)) return downloads.get(final);
  const report = typeof onProgress === 'function' ? onProgress : () => {};
  const fetchFn = opts.fetch || globalThis.fetch;
  const stallMs = opts.stallMs || STALL_MS, connectMs = opts.connectMs || CONNECT_MS;
  const p = (async () => {
    try {
      if (fs.statSync(final).size === m.bytes) { report(1); return final; }
      await fs.promises.unlink(final);                 // wrong size: not ours, or damaged - fetch it again
    } catch (e) { if (e.code !== 'ENOENT') throw plainDownloadError(e); }
    await fs.promises.mkdir(dir, { recursive: true });
    try {
      if (typeof fs.statfsSync === 'function') {
        const st = fs.statfsSync(dir);
        let have = 0; try { have = fs.statSync(path.join(dir, PART_PREFIX + m.file + '.part')).size; } catch (e) { /* none */ }
        if (st.bavail * st.bsize < m.bytes - have + 64 * 1024 * 1024) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
      }
    } catch (e) { if (e.code === 'ENOSPC') throw plainDownloadError(e); }

    const part = path.join(dir, PART_PREFIX + m.file + '.part');
    const urls = opts.urls || preferredOrder(m.mirrors || [m.url]);
    let lastErr = null, damaged = 0;
    for (let round = 0; round < 2; round++) {
      for (const url of urls) {
        let have = 0;
        try { have = fs.statSync(part).size; } catch (e) { have = 0; }
        if (have > m.bytes) { await fs.promises.unlink(part).catch(() => {}); have = 0; }
        if (have === m.bytes) {                        // finished earlier but never renamed (Relay closed at that moment)
          const h = crypto.createHash('sha256');
          await hashFile(part, h);
          if (h.digest('hex') === m.sha256) { await fs.promises.rename(part, final); report(1); return final; }
          await fs.promises.unlink(part).catch(() => {});
          have = 0;
        }
        try {
          const done = await downloadOnce({ url, part, have, m, fetchFn, stallMs, connectMs, report });
          if (done) {
            await fs.promises.rename(part, final);
            report(1);
            return final;
          }
        } catch (err) {
          lastErr = err;
          if (err && err.restart) await fs.promises.unlink(part).catch(() => {});
          if (err && err.damaged) {
            await fs.promises.unlink(part).catch(() => {});
            if (++damaged >= 2) throw plainDownloadError(err);          // twice wrong: do not fetch 2.5 GB again and again
          }
          if (err && err.fatal) throw plainDownloadError(err);
        }
      }
    }
    throw plainDownloadError(lastErr || new Error('fetch failed'));
  })().finally(() => downloads.delete(final));
  downloads.set(final, p);
  return p;
}

async function downloadOnce({ url, part, have, m, fetchFn, stallMs, connectMs, report }) {
  const ctl = new AbortController();
  let t = setTimeout(() => ctl.abort(new Error('timed out')), connectMs);
  let res;
  try {
    res = await fetchFn(url, { signal: ctl.signal, redirect: 'follow', headers: have ? { range: 'bytes=' + have + '-' } : {} });
  } finally { clearTimeout(t); }
  const drop = () => { try { if (res.body) res.body.cancel().catch(() => {}); } catch (e) { /* closed */ } };
  if (have && res.status === 200) have = 0;                       // the server ignored the range: start again
  else if (have && res.status === 416) { drop(); throw Object.assign(new Error('The download server refused to resume'), { restart: true }); }
  if (!(res.status === 200 || res.status === 206) || !res.body) { drop(); throw new Error('The download server answered ' + res.status); }
  if (res.status === 206) {
    const cr = /bytes\s+(\d+)-/i.exec((res.headers && res.headers.get && res.headers.get('content-range')) || '');
    if (!have || !cr || Number(cr[1]) !== have) { drop(); throw Object.assign(new Error('The download server resumed at the wrong place'), { restart: true }); }
  }
  const hash = crypto.createHash('sha256');
  if (have) await hashFile(part, hash);
  let got = have, lastReport = 0, failure = null;
  const reader = res.body.getReader();
  const giveUp = (e) => { failure = failure || e; try { ctl.abort(e); } catch (x) { /* gone */ } try { reader.cancel(); } catch (x) { /* closed */ } };
  const out = fs.createWriteStream(part, { flags: have ? 'a' : 'w' });
  out.on('error', (e) => giveUp(Object.assign(e, { fatal: /ENOSPC|EACCES|EPERM/.test(e.code || '') })));
  try {
    for (;;) {
      clearTimeout(t);
      t = setTimeout(() => giveUp(new Error('the download stalled')), stallMs);
      let chunk;
      try { chunk = await reader.read(); } catch (e) { giveUp(e); break; }
      if (failure || chunk.done) break;
      const value = chunk.value;
      got += value.length;
      if (got > m.bytes) { giveUp(Object.assign(new Error('The downloaded translation model was damaged - please try again'), { damaged: true, plain: true })); break; }
      hash.update(value);
      if (!out.write(value)) await new Promise((r) => { const go = () => { out.off('drain', go); out.off('error', go); r(); }; out.once('drain', go); out.once('error', go); });
      const now = Date.now();
      if (now - lastReport > 250) { lastReport = now; report(Math.min(0.999, got / m.bytes)); }
    }
  } finally {
    clearTimeout(t);
    await new Promise((resolve) => { if (out.closed || out.destroyed) resolve(); else out.end(resolve); out.once('error', resolve); });
  }
  if (failure) throw failure;
  if (got !== m.bytes || hash.digest('hex') !== m.sha256) {
    throw Object.assign(new Error('The downloaded translation model was damaged - please try again'), { damaged: true, plain: true });
  }
  return true;
}

// --- TranslateGemma through llama.node ------------------------------------------------------------

async function loadGemma({ file, device, modulesDir, gpuLayers, threads, log }) {
  const { resolved } = packageRequire('@fugood/llama.node', modulesDir);
  const L = createRequire(resolved)(resolved);
  const cpuThreads = threads || Math.max(2, Math.min(8, (os.availableParallelism ? os.availableParallelism() : os.cpus().length) - 2));
  // A small micro-batch keeps the compute buffer small (its size is n_ubatch x the 262k-word vocabulary):
  // 64 -> about 70 MB instead of 260 MB at 256, for ~10 ms more on a 100-token prompt.
  const base = {
    model: file, n_ctx: N_CTX, n_batch: 128, n_ubatch: 64, n_parallel: 1, use_mmap: true,
    n_threads: cpuThreads, flash_attn_type: 'auto', ctx_shift: false
  };
  const attempts = [];
  if (device !== 'cpu') {
    let dev = null;
    try { dev = pickVulkanDevice(await L.getBackendDevicesInfo('vulkan')); } catch (e) { log('vulkan: ' + e.message); }
    const layers = gpuLayers == null ? gpuLayersFor(dev) : gpuLayers;
    if (dev && layers > 0) attempts.push({ ...base, lib_variant: 'vulkan', devices: [dev.deviceName], n_gpu_layers: layers, _label: 'gpu', _dev: dev });
    else log('no usable Vulkan graphics card: using the processor');
  }
  attempts.push({ ...base, lib_variant: 'default', n_gpu_layers: 0, _label: 'cpu' });
  let lastErr = null;
  for (const a of attempts) {
    const { _label, _dev, ...opts } = a;
    try {
      const ctx = await L.loadModel(opts);
      return { L, ctx, device: _label, deviceName: _dev ? _dev.deviceName : 'CPU', gpuLayers: opts.n_gpu_layers };
    } catch (e) { lastErr = e; log(_label + ' load failed: ' + e.message); }
  }
  throw lastErr || new Error('The translation model could not be loaded');
}

function gemmaEngine(g) {
  const { ctx } = g;
  let current = null;
  return {
    name: 'translategemma',
    device: g.device,
    deviceName: g.deviceName,
    supports: (from, to) => LANG_NAME.has(to) && (!from || LANG_NAME.has(from)),
    /** One chunk; returns { result, settled } for the queue. */
    run(text, from, to, deadlineAt) {
      const job = (async () => {
        const prompt = buildPrompt(text, from, to);
        const tok = await ctx.tokenize(prompt);
        const nPrompt = tok && tok.tokens ? tok.tokens.length : Math.ceil(prompt.length / 2);
        const room = N_CTX - nPrompt - 8;
        if (room < 16) throw new Error('That is too long to translate in one go');
        const want = Math.min(room, 32 + Math.ceil(textWeight(text) * 1.6));
        current = ctx.completion({
          prompt, n_predict: want, temperature: 0, top_k: 1, top_p: 1, min_p: 0, seed: 0,
          stop: ['<end_of_turn>', '<start_of_turn>', '<eos>'], penalty_repeat: 1
        });
        const r = await current;
        return r && typeof r.text === 'string' ? r.text : '';
      })();
      const result = withDeadline(job, deadlineAt, () => { try { ctx.stopCompletion(); } catch (e) { /* not running */ } });
      return { result, settled: job.then(() => {}, () => {}) };
    },
    async dispose() { try { await ctx.release(); } catch (e) { /* already gone */ } }
  };
}


// --- OPUS-MT through transformers.js ----------------------------------------------------------------

/** How well OPUS-MT does a pair it has a route for: 'good', or 'poor' (Hindi, Japanese). */
function opusQuality(from, to) {
  const q = (c) => (LANGS.find((l) => l.code === c) || {}).opus;
  return [from, to].some((c) => c !== 'en' && q(c) === 'poor') ? 'poor' : 'good';
}

async function opusEngine({ modelsDir, modulesDir, log, hosts = ['https://huggingface.co/', 'https://hf-mirror.com/'] }) {
  const { resolved } = packageRequire('@huggingface/transformers', modulesDir);
  const T = await import(pathToFileURL(resolved).href);
  const { pipeline, env } = T;
  env.cacheDir = path.join(modelsDir, 'opus-mt');
  env.allowLocalModels = false;
  try { env.backends.onnx.logLevel = 'error'; } catch (e) { /* older */ }
  const pipes = new Map();          // pair -> Promise<pipeline>
  function getPipe(pair) {
    if (pipes.has(pair)) { const p = pipes.get(pair); pipes.delete(pair); pipes.set(pair, p); return p; }
    const p = (async () => {
      let last = null;
      for (const h of preferredOrder(hosts)) {
        env.remoteHost = h;
        try { return await pipeline('translation', 'Xenova/opus-mt-' + pair, { dtype: 'q8', device: 'cpu' }); } catch (e) { last = e; log('opus ' + pair + ' from ' + h + ': ' + e.message); }
      }
      throw plainDownloadError(last);
    })();
    pipes.set(pair, p);
    p.catch(() => { if (pipes.get(pair) === p) pipes.delete(pair); });
    while (pipes.size > 4) {                                          // keep memory small: drop the least recently used pair
      const [k, old] = pipes.entries().next().value;
      pipes.delete(k);
      old.then((x) => x.dispose && x.dispose()).catch(() => {});
    }
    return p;
  }
  return {
    name: 'opus-mt',
    device: 'cpu',
    deviceName: 'CPU',
    supports: (from, to) => Boolean(from) && opusRoute(from, to) !== null,
    /** Downloads (first time) and loads the models for a pair, outside any request's time limit. */
    async prepare(from, to) { for (const pair of opusRoute(from, to) || []) await getPipe(pair); },
    run(text, from, to, deadlineAt) {
      const job = (async () => {
        const route = opusRoute(from, to);
        if (!route) throw new Error('This language pair needs the full translation model');
        let t = text;
        for (const pair of route) {
          const pipe = await getPipe(pair);
          const r = await pipe(t, { max_new_tokens: Math.min(400, 24 + Math.ceil(textWeight(t) * 1.6)) });
          t = (r && r[0] && r[0].translation_text) || '';
        }
        return t;
      })();
      const result = withDeadline(job, deadlineAt);
      // A first-time download can take minutes: the queue moves on at the deadline instead of waiting for it
      // (it keeps going in the background, and the next request for the pair uses it).
      return { result, settled: result.then(() => {}, () => {}) };
    },
    async dispose() {
      for (const p of pipes.values()) { try { const x = await p; if (x.dispose) await x.dispose(); } catch (e) { /* ignore */ } }
      pipes.clear();
    }
  };
}

// --- the translator ---------------------------------------------------------------------------------

/**
 * createTranslator({ modelsDir, device: 'gpu'|'cpu', engine: 'auto'|'translategemma'|'opus', gpuLayers, timeoutMs, modulesDir, onLog })
 * -> { engine, device, deviceName, translate(text, from, to), languages(), prepare(from, to), dispose() }
 *
 * 'auto': TranslateGemma on the graphics card (Vulkan) does everything. Without a usable card (or with
 * device 'cpu') llama.cpp on the processor is far too slow for a live call (~9 tokens/s: 5-10 s a sentence),
 * so OPUS-MT takes the pairs it does well, and TranslateGemma on the processor only the rest (Hindi, Urdu,
 * Bengali, Portuguese ...), where slow is still better than wrong. Either one alone is used when the other
 * is missing.
 */
async function createTranslator(options = {}) {
  const modelsDir = String(options.modelsDir || '');
  if (!modelsDir) throw new Error('No models folder');
  const device = options.device === 'cpu' ? 'cpu' : 'gpu';
  const want = options.engine || 'auto';
  const timeoutMs = options.timeoutMs || TIMEOUT_MS;
  const log = typeof options.onLog === 'function' ? options.onLog : () => {};

  let gemma = null, opus = null, gemmaErr = null, opusErr = null;
  if (want !== 'opus') {
    if (modelReady(modelsDir)) {
      try {
        gemma = gemmaEngine(await loadGemma({ file: modelPath(modelsDir), device, modulesDir: options.modulesDir, gpuLayers: options.gpuLayers, threads: options.threads, log }));
        if (gemma.device === 'gpu') {
          // The very first run on a graphics card compiles its shaders (8 s measured on a fresh driver cache):
          // do it now, outside the time limit of a real request.
          const w = gemma.run('Hello.', 'en', 'es', Date.now() + 120000);
          await w.result.catch((e) => log('warm-up: ' + e.message));
          await w.settled;
        }
      } catch (e) { gemmaErr = e; gemma = null; log('translategemma: ' + e.message); }
    } else gemmaErr = new Error('The translation model is not downloaded yet');
    if (!gemma && want === 'translategemma') throw gemmaErr;
  }
  if (want !== 'translategemma' && (!gemma || gemma.device !== 'gpu')) {
    try { opus = await opusEngine({ modelsDir, modulesDir: options.modulesDir, log }); } catch (e) { opusErr = e; log('opus-mt: ' + e.message); }
  }
  if (!gemma && !opus) {
    throw new Error((gemmaErr ? gemmaErr.message + '; ' : '') + 'the backup translator is not available either (' + (opusErr ? opusErr.message : 'not installed') + ')');
  }

  /** The engine for a pair (src '' = not recognised), or null. */
  function pick(src, tgt) {
    if (gemma && gemma.device === 'gpu') return gemma;
    if (opus && opus.supports(src, tgt) && (!gemma || opusQuality(src, tgt) === 'good')) return opus;
    if (gemma && gemma.supports(src, tgt)) return gemma;
    if (opus && opus.supports(src, tgt)) return opus;
    return null;
  }

  const cache = createLru(CACHE_SIZE);
  const enqueue = createSerialQueue();
  let disposed = false;

  function resolvePair(text, from, to) {
    const tgt = normLang(to);
    if (!tgt || tgt === 'auto') throw new Error('Unsupported language: ' + String(to).slice(0, 20));
    let src = normLang(from);
    if (src === '' && from && from !== 'auto') throw new Error('Unsupported language: ' + String(from).slice(0, 20));
    if (src === 'auto' || !src) src = text ? detectLanguage(text) : '';
    return { src, tgt };
  }

  async function translate(text, from = 'auto', to = 'en') {
    if (disposed) throw new Error('The translator was closed');
    const deadlineAt = Date.now() + timeoutMs;
    const clean = sanitizeInput(text);
    const { src, tgt } = resolvePair(clean, from, to);
    if (!clean || !/[\p{L}\p{N}]/u.test(clean)) return '';
    if (src === tgt) return clean;
    const eng = pick(src, tgt);
    if (!eng) throw new Error(src ? 'This language pair needs the full translation model' : 'The language could not be recognised - choose it instead of "auto"');
    const key = (src || '?') + '>' + tgt + ':' + clean;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const pieces = [];
    for (const chunk of splitChunks(clean)) {
      const raw = await enqueue((dl) => eng.run(chunk, src, tgt, dl), deadlineAt);
      pieces.push(cleanOutput(raw, chunk));
    }
    const out = pieces.filter(Boolean).join(tgt === 'zh' || tgt === 'ja' ? '' : ' ').trim();
    cache.set(key, out);
    return out;
  }

  /** Optional: get a pair ready (OPUS-MT downloads its per-pair models on first use). */
  async function prepare(from, to) {
    const { src, tgt } = resolvePair('', from, to);
    const eng = src && src !== tgt ? pick(src, tgt) : null;
    if (eng && eng.prepare) await eng.prepare(src, tgt);
    return Boolean(eng);
  }

  /**
   * [{ code, name, quality }]: 'good'; 'slow' (TranslateGemma on the processor: right, but 5-10 s a sentence);
   * or, with OPUS-MT alone, 'poor' / 'to-en' (only into English) / 'from-en'.
   */
  function languages() {
    if (gemma && gemma.device === 'gpu') return LANGS.map((l) => ({ code: l.code, name: l.name, quality: 'good' }));
    return LANGS.filter((l) => gemma || (opus && l.opus !== 'none')).map((l) => {
      const quality = opus && l.opus === 'good' ? 'good' : gemma ? 'slow' : l.opus;
      return { code: l.code, name: l.name, quality, ...(l.note && !gemma ? { note: l.note } : {}) };
    });
  }

  async function dispose() {
    if (disposed) return;
    disposed = true;
    cache.clear();
    await enqueue(() => ({ result: Promise.all([gemma && gemma.dispose(), opus && opus.dispose()]), settled: Promise.resolve() })).catch(() => {});
  }

  const main = gemma || opus;
  return {
    engine: gemma && opus ? 'translategemma+opus-mt' : main.name,
    device: gemma ? gemma.device : 'cpu',
    deviceName: main.deviceName,
    translate, languages, prepare, dispose
  };
}

module.exports = {
  MODELS, LANGS, OPUS_PAIRS, TIMEOUT_MS, CACHE_SIZE,
  ensureModel, createTranslator, modelPath, modelReady,
  // pure parts (tests)
  normLang, detectLanguage, textWeight, sanitizeInput, buildPrompt, cleanOutput, cutToWeight, splitChunks,
  createLru, createSerialQueue, withDeadline, opusRoute, opusQuality, pickVulkanDevice, gpuLayersFor, PART_PREFIX
};
