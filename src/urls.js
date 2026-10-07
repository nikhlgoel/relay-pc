'use strict';

// URL policy for the main process. Pure functions only (no Electron imports) so
// they can be unit-tested with `npm test`.

/** True for pages that are genuinely WhatsApp Web. Parsed, never prefix-matched:
 *  'https://web.whatsapp.com.evil.example' must not pass. */
function isWhatsAppWebUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === 'web.whatsapp.com';
  } catch {
    return false;
  }
}

/** WhatsApp-owned hosts that may open in an app window (media/PDF viewers). */
function isWhatsAppOwnedUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && /(^|\.)whatsapp\.(com|net)$/.test(u.hostname);
  } catch {
    return false;
  }
}

/** whatsapp://send?phone=... -> https://web.whatsapp.com/send?phone=... */
function deepLinkToWebUrl(url) {
  const webUrl = url.replace(/^whatsapp:\/\//i, 'https://web.whatsapp.com/');
  return isWhatsAppWebUrl(webUrl) ? webUrl : null;
}

/**
 * Should this URL be handed to the OS (default browser / mail client)?
 * Everything not allowed here is dropped, because shell.openExternal will
 * happily launch any registered protocol handler (ms-msdt:, file:, ...).
 */
function shouldOpenExternally(url) {
  // TODO(human): decide the policy for non-web links (mailto:, tel:, ...).
  // Baseline: web links only.
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

module.exports = { isWhatsAppWebUrl, isWhatsAppOwnedUrl, deepLinkToWebUrl, shouldOpenExternally };
