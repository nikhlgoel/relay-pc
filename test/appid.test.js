'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('the AUMID set in main.js matches build.appId', () => {
  const pkg = require('../package.json');
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const m = /setAppUserModelId\('([^']+)'\)/.exec(main);
  assert.ok(m, 'setAppUserModelId call not found');
  assert.equal(m[1], pkg.build.appId);
});

test('main.js does not read the build section at runtime', () => {
  // electron-builder strips "build" from the packaged package.json.
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  assert.doesNotMatch(main, /pkg\.build/);
});
