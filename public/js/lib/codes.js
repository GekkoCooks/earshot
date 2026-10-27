// The lecturer's browser computes the rotating code locally with WebCrypto, so
// the sound keeps playing through short network drops. Must match server/codes.js.

import { WINDOW_MS, packPayload } from '../modem/protocol.js';

const enc = new TextEncoder();

export async function importSecret(hex) {
  const bytes = new Uint8Array(hex.match(/../g).map((h) => parseInt(h, 16)));
  return crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

export async function payloadFor(key, sessionId, window) {
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`earshot/v1|${sessionId}|${window}`)));
  const tag = (mac[0] << 16) | (mac[1] << 8) | mac[2];
  return packPayload(window & 0xff, tag);
}

export const windowAt = (startedAt, now) => Math.floor((now - startedAt) / WINDOW_MS);
