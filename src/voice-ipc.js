'use strict';
/*
 * Messages between the app and the voice-engine process. Electron and plain Node.js use different V8 versions, so their
 * structured-clone formats do not match ("unable to deserialize cloned data"); plain JSON always does. Binary audio is
 * carried as { __bin: <base64> } and comes back as an ArrayBuffer.
 */

/** Deep copy of `value` with every ArrayBuffer / typed array / Buffer replaced by { __bin }. */
function encode(value) {
  if (value instanceof ArrayBuffer) return { __bin: Buffer.from(value).toString('base64') };
  if (ArrayBuffer.isView(value)) return { __bin: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64') };
  if (Array.isArray(value)) return value.map(encode);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = encode(v);
    return out;
  }
  return value;
}

/** The reverse: every { __bin } becomes an ArrayBuffer. */
function decode(value) {
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === 'object') {
    if (typeof value.__bin === 'string' && Object.keys(value).length === 1) {
      const b = Buffer.from(value.__bin, 'base64');
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = decode(v);
    return out;
  }
  return value;
}

module.exports = { encode, decode };
