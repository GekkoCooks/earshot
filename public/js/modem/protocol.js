// The Earshot sound protocol. Shared by the lecturer transmitter, the student
// receiver and the Node test suite, so it must stay free of DOM APIs.
//
// A frame is 16 symbols of 100 ms each (1.6 s):
//   slots 0-3   sync pattern (fixed tones)
//   slots 4-11  payload: 8-bit window counter + 24-bit HMAC tag, as nibbles
//   slots 12-15 Reed-Solomon parity
//
// Each symbol is one tone out of 16. Even slots use tone bank A and odd slots
// use bank B. The banks interleave in frequency, so the echo of a symbol lands
// in the bank that is not being read in the next slot.

import * as rs from './rs.js';

export const SYMBOL_MS = 100;
export const RAMP_MS = 12;
export const SYNC_SLOTS = 4;
export const FRAME_SLOTS = SYNC_SLOTS + rs.N;
export const FRAME_MS = FRAME_SLOTS * SYMBOL_MS;

// A code is valid for one window; the transmitter repeats it every frame.
export const WINDOW_MS = 8000;
export const FRAMES_PER_WINDOW = WINDOW_MS / FRAME_MS;

export const TONES_PER_BANK = 16;
export const SPACING_HZ = 62.5;

export const BANDS = {
  // Near-ultrasonic: most adults cannot hear it and phone-call codecs drop it.
  quiet: { id: 'quiet', base: 18000 },
  // Audible fallback for big rooms or weak speakers. Passes through calls.
  audible: { id: 'audible', base: 2400 },
};
export const BAND_LIST = [BANDS.quiet, BANDS.audible];

// Sync tones, one per sync slot. Slot parity decides the bank.
export const SYNC_TONES = [3, 12, 9, 6];

export const bankOf = (slot) => slot % 2;

export function toneHz(band, bank, tone) {
  return band.base + SPACING_HZ * (2 * tone + bank);
}

/** Pack an 8-bit counter and a 24-bit tag into 8 nibbles. */
export function packPayload(counter, tag) {
  const bytes = [counter & 0xff, (tag >>> 16) & 0xff, (tag >>> 8) & 0xff, tag & 0xff];
  return bytes.flatMap((b) => [b >> 4, b & 0xf]);
}

export function unpackPayload(nibbles) {
  const b = [];
  for (let i = 0; i < 8; i += 2) b.push((nibbles[i] << 4) | nibbles[i + 1]);
  return { counter: b[0], tag: ((b[1] << 16) | (b[2] << 8) | b[3]) >>> 0 };
}

export const nibblesToHex = (n) => n.map((v) => v.toString(16)).join('');
export const hexToNibbles = (h) => [...h].map((c) => parseInt(c, 16));

/** The 16 tone indices for one frame, in slot order. */
export function frameTones(payloadNibbles) {
  return [...SYNC_TONES, ...rs.encode(payloadNibbles)];
}
