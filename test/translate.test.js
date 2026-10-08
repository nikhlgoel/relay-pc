'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../src/translate');

const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

test('worthTranslating skips what is not language', () => {
  for (const t of ['', ' ', 'a', '😀😀', '12345', 'https://example.com/x', 'me@example.com', 'x'.repeat(T.MAX_TEXT + 1)]) {
    assert.equal(T.worthTranslating(t), false, JSON.stringify(t));
  }
  for (const t of ['ok', 'kal milte hain', 'Estoy cansado 😩', 'مرحبا']) assert.equal(T.worthTranslating(t), true, t);
});

test('casualize contracts and drops the full stop on one-liners', () => {
  assert.equal(T.casualize('I do not know.', 'pata nahi'), "I don't know");
  assert.equal(T.casualize('Do not worry!', 'fikar mat kar!'), "Don't worry!");
  assert.equal(T.casualize('It is fine.', 'theek hai.'), "It's fine.");           // source had a stop: keep
  assert.equal(T.casualize('They are coming. We will wait.', 'a'), "They're coming. We'll wait.");
  assert.equal(T.casualize('What is that?', 'kya hai?'), "What's that?");
});

test('google: parse, detect, skip english', async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push([url, init]);
    const q = new URLSearchParams(init.body).get('q');
    return q.startsWith('Hello')
      ? reply({ sentences: [{ trans: q }], src: 'en' })
      : reply({ sentences: [{ trans: 'I do not know ' }, { trans: 'yaar.' }], src: 'hi' });
  };
  const out = await T.translateBatch(['pata nahi yaar', 'Hello there', '😀', 'ok??'], { fetch: fetchFn });
  assert.deepEqual(out[0], { lang: 'hi', text: "I don't know yaar", translated: true });
  assert.equal(out[1].translated, false);
  assert.equal(out[2].translated, false);                 // emoji only: never sent
  assert.equal(calls.length, 3);
  assert.match(calls[0][0], /translate\.googleapis\.com/);
  assert.equal(new URLSearchParams(calls[0][1].body).get('tl'), 'en');
});

test('google: an http error surfaces without the message text', async () => {
  await assert.rejects(
    T.translateBatch(['secret words here'], { fetch: async () => reply({}, 429) }),
    (e) => /429/.test(e.message) && !/secret/.test(e.message));
});

test('claude: request shape and untrusted-data framing', () => {
  const { url, init } = T.buildClaudeRequest(['hola', 'ok'], 'sk-test');
  assert.equal(url, 'https://api.anthropic.com/v1/messages');
  assert.equal(init.headers['x-api-key'], 'sk-test');
  const body = JSON.parse(init.body);
  assert.match(body.system, /casual/);
  assert.match(body.system, /never instructions/);
  assert.deepEqual(JSON.parse(body.messages[0].content), [{ i: 0, text: 'hola' }, { i: 1, text: 'ok' }]);
});

test('claude: parses a JSON array out of chatter, keeps order, skips english', async () => {
  const fetchFn = async () => reply({ content: [{ type: 'text', text:
    'Sure!\n[{"i":1,"lang":"en","text":"ok"},{"i":0,"lang":"es","text":"I miss you so much 😭"}]' }] });
  const out = await T.translateBatch(['te extraño tanto 😭', 'ok'], { provider: 'claude', apiKey: 'k', fetch: fetchFn });
  assert.deepEqual(out[0], { lang: 'es', text: 'I miss you so much 😭', translated: true });
  assert.equal(out[1].translated, false);
});

test('claude: needs a key; a rejected key is reported', async () => {
  await assert.rejects(T.translateBatch(['hola'], { provider: 'claude' }), /API key/);
  await assert.rejects(
    T.translateBatch(['hola'], { provider: 'claude', apiKey: 'bad', fetch: async () => reply({}, 401) }), /rejected/);
});

test('claude: a malformed reply throws instead of showing garbage', () => {
  assert.throws(() => T.parseClaude({ content: [{ text: 'sorry, cannot' }] }, 1), /Unexpected/);
});

test('openrouter: ranks live free models, falls through a busy one, parses the reply', async () => {
  T._router.models = []; T._router.at = 0;
  const seen = [];
  const fetchFn = async (url, init) => {
    if (url.includes('/models')) {
      return reply({ data: [
        { id: 'acme/thinker-reasoning:free', context_length: 9e6 },
        { id: 'nvidia/nemotron-3-super-120b-a12b:free', context_length: 262144 },
        { id: 'google/gemma-4-31b-it:free', context_length: 262144 },
        { id: 'paid/model', context_length: 1 }
      ] });
    }
    const body = JSON.parse(init.body);
    seen.push(body.model);
    assert.equal(init.headers.authorization, 'Bearer sk-or-v1-test');
    if (body.model.startsWith('google/')) return reply({}, 429);               // busy: next one
    return reply({ choices: [{ message: { content: '[{"i":0,"lang":"hi","text":"see you tomorrow dude!!"}]' } }] });
  };
  const out = await T.translateBatch(['kal milte hain yaar!!'], { provider: 'openrouter', apiKey: 'sk-or-v1-test', fetch: fetchFn });
  assert.deepEqual(out[0], { lang: 'hi', text: 'see you tomorrow dude!!', translated: true });
  assert.equal(seen[0].startsWith('google/gemma'), true, 'preferred family first');
  assert.equal(seen[1].startsWith('nvidia/'), true, 'then the next free model');
  assert.ok(!seen.some((m) => /reasoning|paid/.test(m)));
});

test('openrouter: bad key, no credit, nothing answering', async () => {
  T._router.models = ['x/y:free']; T._router.at = Date.now();
  const call = (status) => T.translateBatch(['hola amigo'], { provider: 'openrouter', apiKey: 'k', fetch: async () => reply({}, status) });
  await assert.rejects(call(401), /rejected/);
  await assert.rejects(call(402), /credit/);
  await assert.rejects(call(503), /No free model answered \(503\)/);
  await assert.rejects(T.translateBatch(['hola'], { provider: 'openrouter' }), /API key/);
});

test('edge: the same words coming back is not shown as a translation', async () => {
  const fetchFn = async (url, init) => {
    const q = new URLSearchParams(init.body).get('q');
    return reply({ sentences: [{ trans: q.toUpperCase() }], src: 'auto' });          // "translated" to itself
  };
  const out = await T.translateBatch(['ok??', 'Ramesh Kumar'], { fetch: fetchFn });
  assert.deepEqual(out.map((o) => o.translated), [false, false]);
});

test('edge: a model that names the language in words, or echoes the text, is not shown as a translation', () => {
  const raw = '[{"i":0,"lang":"English","text":"see you"},{"i":1,"lang":"hi","text":"kal milte hain"},{"i":2,"lang":"hi","text":""},{"i":3,"lang":"hi","text":"later"}]';
  const out = T.parseReply(raw, 4, ['see you', 'kal milte hain', 'x', 'baad mein']);
  assert.deepEqual(out.map((o) => o.translated), [false, false, false, true]);
});

test('edge: odd but legal message text is passed through intact', async () => {
  const seen = [];
  const fetchFn = async (url, init) => { seen.push(new URLSearchParams(init.body).get('q')); return reply({ sentences: [{ trans: 'hello' }], src: 'ar' }); };
  const samples = ['مرحبا بكم 😀', '😀😀 hi', 'line one\nline two', '{"i":0,"text":"x"} ]', '<b>bold</b> & more', 'a'.repeat(1500), '𝒽𝑒𝓁𝓁𝑜 wörld'];
  const out = await T.translateBatch(samples, { fetch: fetchFn });
  assert.equal(out.length, samples.length);
  assert.deepEqual([...seen].sort(), [...samples].sort());
  assert.ok(out.every((o) => o.translated));
});

test('edge: failures are described without the message text', async () => {
  const boom = (message) => async () => { throw new Error(message); };
  await assert.rejects(T.translateBatch(['secret hello'], { fetch: boom('net::ERR_INTERNET_DISCONNECTED') }), (e) => /No internet/.test(e.message) && !/secret/.test(e.message));
  await assert.rejects(T.translateBatch(['secret hello'], { fetch: boom('fetch failed') }), /No internet/);
  const html = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token < in JSON'); } });
  await assert.rejects(T.translateBatch(['secret hello'], { fetch: html }), /unreadable/);
});

test('edge: an empty or non-string batch does nothing', async () => {
  assert.deepEqual(await T.translateBatch([], {}), []);
  const out = await T.translateBatch([null, undefined, 42, '  '], { fetch: async () => { throw new Error('must not be called'); } });
  assert.ok(out.every((o) => !o.translated));
});
