// Turns a payload into audio samples.

import { SYMBOL_MS, RAMP_MS, FRAME_SLOTS, bankOf, toneHz, frameTones } from './protocol.js';

/**
 * Render one frame as mono PCM.
 * The raised-cosine ramps matter: a hard edge on an 18 kHz tone is an audible click.
 */
export function synthFrame(payloadNibbles, { band, sampleRate, amplitude = 0.5 }) {
  const tones = frameTones(payloadNibbles);
  const symLen = Math.round((sampleRate * SYMBOL_MS) / 1000);
  const rampLen = Math.round((sampleRate * RAMP_MS) / 1000);
  const out = new Float32Array(symLen * FRAME_SLOTS);

  const ramp = new Float32Array(rampLen);
  for (let i = 0; i < rampLen; i++) ramp[i] = 0.5 - 0.5 * Math.cos((Math.PI * i) / rampLen);

  for (let slot = 0; slot < FRAME_SLOTS; slot++) {
    const f = toneHz(band, bankOf(slot), tones[slot]);
    const w = (2 * Math.PI * f) / sampleRate;
    const offset = slot * symLen;
    for (let i = 0; i < symLen; i++) {
      let env = 1;
      if (i < rampLen) env = ramp[i];
      else if (i >= symLen - rampLen) env = ramp[symLen - 1 - i];
      out[offset + i] = amplitude * env * Math.sin(w * i);
    }
  }
  return out;
}
