// Rotating presence codes.
//
// Each session has a random secret. Time since the session started is split
// into 8 s windows. The code for window w is
//   counter = w mod 256
//   tag     = first 24 bits of HMAC-SHA256(secret, "earshot/v1|<sessionId>|<w>")
// The lecturer's browser computes the same thing with WebCrypto
// (public/js/lib/codes.js) and plays it as sound.

import crypto from 'node:crypto';
import { WINDOW_MS } from '../public/js/modem/protocol.js';

export const newSecret = () => crypto.randomBytes(32).toString('hex');

export function tagFor(secretHex, sessionId, window) {
  const mac = crypto.createHmac('sha256', Buffer.from(secretHex, 'hex')).update(`earshot/v1|${sessionId}|${window}`).digest();
  return (mac[0] << 16) | (mac[1] << 8) | mac[2];
}

export const windowAt = (startedAt, now) => Math.floor((now - startedAt) / WINDOW_MS);

/**
 * Check a heard code. Accepts the current window and one either side, which
 * covers decode time, network lag and a little clock skew. A code is therefore
 * useful for 16 to 24 s at most.
 */
export function verifyCode(session, counter, tag, now) {
  const current = windowAt(session.started_at, now);
  for (const w of [current, current - 1, current + 1]) {
    if (w < 0 || (w & 0xff) !== counter) continue;
    const want = Buffer.alloc(3);
    want.writeUIntBE(tagFor(session.secret, session.id, w), 0, 3);
    const got = Buffer.alloc(3);
    got.writeUIntBE(tag >>> 0, 0, 3);
    if (crypto.timingSafeEqual(want, got)) return { ok: true, window: w, age: current - w };
  }
  // Distinguish "right code, too late" so the phone can keep listening quietly.
  for (let back = 2; back <= 40; back++) {
    const w = current - back;
    if (w < 0) break;
    if ((w & 0xff) === counter && tagFor(session.secret, session.id, w) === tag) return { ok: false, reason: 'stale_code' };
  }
  return { ok: false, reason: 'bad_code' };
}
