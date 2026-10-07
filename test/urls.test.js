'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isWhatsAppWebUrl, isWhatsAppOwnedUrl, deepLinkToWebUrl, shouldOpenExternally
} = require('../src/urls');

test('isWhatsAppWebUrl accepts only the real origin', () => {
  assert.equal(isWhatsAppWebUrl('https://web.whatsapp.com/'), true);
  assert.equal(isWhatsAppWebUrl('https://web.whatsapp.com/send?phone=1'), true);
  // The old startsWith() check let these through.
  assert.equal(isWhatsAppWebUrl('https://web.whatsapp.com.evil.example/'), false);
  assert.equal(isWhatsAppWebUrl('https://web.whatsapp.com@evil.example/'), false);
  assert.equal(isWhatsAppWebUrl('http://web.whatsapp.com/'), false);
  assert.equal(isWhatsAppWebUrl('not a url'), false);
});

test('isWhatsAppOwnedUrl rejects look-alikes that merely contain the name', () => {
  assert.equal(isWhatsAppOwnedUrl('https://webtp.whatsapp.net/pdf-viewer/'), true);
  assert.equal(isWhatsAppOwnedUrl('https://faq.whatsapp.com/'), true);
  // The old url.includes('whatsapp.com') check allowed these.
  assert.equal(isWhatsAppOwnedUrl('https://evil.example/?whatsapp.com'), false);
  assert.equal(isWhatsAppOwnedUrl('https://notwhatsapp.com/'), false);
  assert.equal(isWhatsAppOwnedUrl('https://whatsapp.com.evil.example/'), false);
});

test('deepLinkToWebUrl maps whatsapp:// onto web.whatsapp.com only', () => {
  assert.equal(deepLinkToWebUrl('whatsapp://send?phone=123'),
    'https://web.whatsapp.com/send?phone=123');
  assert.equal(deepLinkToWebUrl('WHATSAPP://send?phone=123'),
    'https://web.whatsapp.com/send?phone=123');
  // The real host is always prepended, so an authority trick ends up as a
  // plain path on web.whatsapp.com rather than redirecting off-origin.
  const tricky = deepLinkToWebUrl('whatsapp://@evil.example/');
  assert.equal(new URL(tricky).hostname, 'web.whatsapp.com');
  // Anything that is not a whatsapp:// link is rejected outright.
  assert.equal(deepLinkToWebUrl('https://evil.example/'), null);
});

test('shouldOpenExternally never hands dangerous schemes to the OS', () => {
  assert.equal(shouldOpenExternally('https://example.com/page'), true);
  assert.equal(shouldOpenExternally('http://example.com/'), true);
  for (const bad of [
    'file:///C:/Windows/System32/calc.exe',
    'ms-msdt:/id PCWDiagnostic',
    'javascript:alert(1)',
    'smb://attacker/share',
    'not a url'
  ]) {
    assert.equal(shouldOpenExternally(bad), false, bad);
  }
});
