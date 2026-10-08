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
 * Web links, plain mailto: and tel: links. Everything else is dropped, because
 * shell.openExternal will happily launch any registered protocol handler
 * (ms-msdt:, file:, ...).
 */
function shouldOpenExternally(url) {
  try {
    const { protocol } = new URL(url);
    if (protocol === 'https:' || protocol === 'http:') return true;
    // Email addresses and phone numbers in chats should work, but only in their plain form:
    // no attachment parameters (some mail clients would attach a local file), no extra schemes.
    if (protocol === 'mailto:') return MAILTO.test(url) && url.length < 2000;
    if (protocol === 'tel:') return TEL.test(url);
    return false;
  } catch {
    return false;
  }
}

const MAILTO = /^mailto:[^?#\s]*(\?(subject|body|cc|bcc)=[^&#\s]*(&(subject|body|cc|bcc)=[^&#\s]*)*)?$/i;
const TEL = /^tel:\+?[0-9()\-.\s]{3,24}$/i;

module.exports = { isWhatsAppWebUrl, isWhatsAppOwnedUrl, deepLinkToWebUrl, shouldOpenExternally };
