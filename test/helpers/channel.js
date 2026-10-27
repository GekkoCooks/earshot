// A rough simulated classroom: speaker roll-off, room echo, background noise,
// a random start time and clock drift. Good enough to catch regressions in the
// modem; not a substitute for testing in a real room.

import { synthFrame } from '../../public/js/modem/synth.js';
import { FRAMES_PER_WINDOW } from '../../public/js/modem/protocol.js';

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(rand) {
  const u = Math.max(rand(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

/** Lowpass biquad (RBJ cookbook), used to fake a laptop speaker rolling off. */
function lowpass(x, fs, fc, q = 0.707) {
  const w0 = (2 * Math.PI * fc) / fs;
  const alpha = Math.sin(w0) / (2 * q);
  const cos = Math.cos(w0);
  const a0 = 1 + alpha;
  const b0 = (1 - cos) / 2 / a0;
  const b1 = (1 - cos) / a0;
  const b2 = b0;
  const a1 = (-2 * cos) / a0;
  const a2 = (1 - alpha) / a0;
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v;
    y[i] = v;
  }
  return y;
}

/** Schroeder reverb: 4 parallel combs + 2 allpasses, mixed with the dry path. */
function reverb(x, fs, rt60, wet) {
  if (!rt60) return x;
  const combMs = [29.7, 37.1, 41.1, 43.7];
  const out = new Float32Array(x.length);
  for (const ms of combMs) {
    const d = Math.round((fs * ms) / 1000);
    const g = Math.pow(10, (-3 * ms) / 1000 / rt60);
    const line = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) line[i] = x[i] + (i >= d ? g * line[i - d] : 0);
    for (let i = 0; i < x.length; i++) out[i] += line[i] / combMs.length;
  }
  let y = out;
  for (const [ms, g] of [[5, 0.7], [1.7, 0.7]]) {
    const d = Math.round((fs * ms) / 1000);
    const z = new Float32Array(y.length);
    for (let i = 0; i < y.length; i++) {
      const xd = i >= d ? y[i - d] : 0;
      const zd = i >= d ? z[i - d] : 0;
      z[i] = -g * y[i] + xd + g * zd;
    }
    y = z;
  }
  const res = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) res[i] = (1 - wet) * x[i] + wet * y[i] * 3;
  return res;
}

/**
 * Build what a phone microphone would record.
 * snrDb is signal power vs noise power inside the band's 2 kHz.
 */
export function record({
  payloads,
  band,
  sampleRate = 48000,
  snrDb = 20,
  rt60 = 0.6,
  wet = 0.5,
  rolloffHz = 0,
  drift = 1,
  leadMs = 700,
  seed = 1,
  babble = 0,
}) {
  const rand = rng(seed);
  const parts = [];
  for (const p of payloads) {
    const frame = synthFrame(p, { band, sampleRate: sampleRate * drift, amplitude: 0.3 });
    for (let i = 0; i < FRAMES_PER_WINDOW; i++) parts.push(frame);
  }
  const lead = Math.round(((leadMs * (0.5 + rand())) / 1000) * sampleRate);
  const total = lead + parts.reduce((n, p) => n + p.length, 0) + sampleRate / 2;
  let sig = new Float32Array(total);
  let pos = lead;
  for (const p of parts) {
    sig.set(p, pos);
    pos += p.length;
  }

  if (rolloffHz) sig = lowpass(sig, sampleRate, rolloffHz);
  sig = reverb(sig, sampleRate, rt60, wet);

  // Measure signal power where it is actually playing.
  let pSig = 0;
  for (let i = lead; i < pos; i++) pSig += sig[i] * sig[i];
  pSig /= pos - lead;

  const inBandFraction = 2000 / (sampleRate / 2);
  const noiseTotal = pSig / Math.pow(10, snrDb / 10) / inBandFraction;
  const sigma = Math.sqrt(noiseTotal);
  const out = new Float32Array(total);
  // Babble: low-frequency, speech-like bursts that mostly hit the audible band.
  let b1 = 0;
  let b2 = 0;
  for (let i = 0; i < total; i++) {
    let n = sigma * gauss(rand);
    if (babble) {
      b1 = 0.6 * b1 + 0.4 * gauss(rand);
      b2 = 0.6 * b2 + 0.4 * b1;
      const env = 0.5 + 0.5 * Math.sin((2 * Math.PI * 4 * i) / sampleRate + 3 * Math.sin(i / 9000));
      n += babble * env * b2;
    }
    out[i] = sig[i] + n;
  }
  return out;
}
