'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');

test('every {{placeholder}} in about.html is filled in by main.js', () => {
  const html = src('about.html');
  const main = src('main.js');
  const used = new Set([...html.matchAll(/\{\{([A-Z]+)\}\}/g)].map((m) => m[1]));
  assert.ok(used.size > 0);
  for (const name of used) {
    assert.ok(main.includes("replaceAll('{{" + name + "}}'"), name + ' is never substituted');
  }
});

test('about.html runs no scripts and loads nothing remote', () => {
  const html = src('about.html');
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /default-src 'none'/);
  assert.doesNotMatch(html, /(src|href)="http:/i);
});

test('the Relay icon placeholder in theme.css is substituted', () => {
  assert.match(src('theme.css'), /__RELAY_ICON__/);
  assert.match(src('main.js'), /replaceAll\('__RELAY_ICON__'/);
});
