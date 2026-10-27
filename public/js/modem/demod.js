// Turns microphone samples back into payloads.
//
// Every hop (a quarter symbol, 25 ms) we run Goertzel filters on the last
// 75 ms of audio for all 64 tones (2 bands x 32 tones). Because the window is
// shorter than a symbol and the hop is a quarter of one, at least one hop per
// symbol sees a window that sits fully inside that symbol.
//
// Each bin is divided by its own noise floor, so a bin's value is roughly its
// signal-to-noise ratio. Sync is found by looking for the 4 known sync tones
// spaced 4 hops apart. Then each data slot is read at the same alignment.
// If a frame fails the Reed-Solomon check, its soft values are added to the
// previous one or two frames (the transmitter repeats each code 5 times) and
// we try again. This is what makes weak signals usable.

import * as rs from './rs.js';
import {
  SYMBOL_MS,
  SYNC_SLOTS,
  FRAME_SLOTS,
  SYNC_TONES,
  TONES_PER_BANK,
  BAND_LIST,
  bankOf,
  toneHz,
} from './protocol.js';

const HOPS_PER_SYMBOL = 4;
const WINDOW_SYMBOLS = 0.75;
const HISTORY = 160; // hops kept, 4 s
const FRAME_HOPS = FRAME_SLOTS * HOPS_PER_SYMBOL;

export const SYNC_THRESHOLD = 0.42;
const SYNC_MIN_SNR = 4; // about 6 dB

export class Demodulator {
  constructor({ sampleRate, bands = BAND_LIST, onFrame, onSync, onSymbol, onLost, onLevel } = {}) {
    this.fs = sampleRate;
    this.bands = bands;
    this.cb = { onFrame, onSync, onSymbol, onLost, onLevel };

    const symLen = (sampleRate * SYMBOL_MS) / 1000;
    this.hopF = symLen / HOPS_PER_SYMBOL;
    this.win = Math.round(symLen * WINDOW_SYMBOLS);

    this.hann = new Float32Array(this.win);
    for (let i = 0; i < this.win; i++) this.hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (this.win - 1));
    this.xw = new Float32Array(this.win);

    // bins[b][bank][tone] -> flat index b*32 + tone*2 + bank
    this.nBins = bands.length * TONES_PER_BANK * 2;
    this.coef = new Float32Array(this.nBins);
    for (let b = 0; b < bands.length; b++) {
      for (let t = 0; t < TONES_PER_BANK; t++) {
        for (let bank = 0; bank < 2; bank++) {
          const f = toneHz(bands[b], bank, t);
          this.coef[this.binIndex(b, bank, t)] = 2 * Math.cos((2 * Math.PI * f) / sampleRate);
        }
      }
    }

    this.reset();
  }

  binIndex(b, bank, tone) {
    return b * TONES_PER_BANK * 2 + tone * 2 + bank;
  }

  reset() {
    this.buf = new Float32Array(Math.ceil(this.fs * 1.5));
    this.bufStart = 0; // absolute sample index of buf[0]
    this.bufLen = 0;
    this.nextHop = 0;
    this.hist = new Array(HISTORY);
    this.floor = null;
    this.scan = 0;
    this.pending = null;
    this.recent = [];
    this.level = new Float32Array(this.bands.length);
  }

  push(samples) {
    this.append(samples);
    for (;;) {
      const start = Math.round(this.nextHop * this.hopF);
      if (start + this.win > this.bufStart + this.bufLen) break;
      this.analyse(this.nextHop, start - this.bufStart);
      this.nextHop++;
      this.step();
    }
  }

  append(samples) {
    // Drop samples that no future hop needs.
    const keepFrom = Math.round(this.nextHop * this.hopF);
    const drop = Math.max(0, Math.min(keepFrom - this.bufStart, this.bufLen));
    if (drop > 0 && this.bufLen + samples.length > this.buf.length) {
      this.buf.copyWithin(0, drop, this.bufLen);
      this.bufLen -= drop;
      this.bufStart += drop;
    }
    if (this.bufLen + samples.length > this.buf.length) {
      const bigger = new Float32Array((this.bufLen + samples.length) * 2);
      bigger.set(this.buf.subarray(0, this.bufLen));
      this.buf = bigger;
    }
    this.buf.set(samples, this.bufLen);
    this.bufLen += samples.length;
  }

  analyse(hop, offset) {
    const { win, hann, xw, buf, coef, nBins } = this;
    for (let i = 0; i < win; i++) xw[i] = buf[offset + i] * hann[i];

    const energy = new Float32Array(nBins);
    for (let k = 0; k < nBins; k++) {
      const c = coef[k];
      let s1 = 0;
      let s2 = 0;
      for (let i = 0; i < win; i++) {
        const s0 = xw[i] + c * s1 - s2;
        s2 = s1;
        s1 = s0;
      }
      energy[k] = s1 * s1 + s2 * s2 - c * s1 * s2 + 1e-12;
    }

    // Noise floor: drops quickly, rises slowly (about 2% per hop).
    if (!this.floor) this.floor = Float32Array.from(energy);
    const snr = new Float32Array(nBins);
    for (let k = 0; k < nBins; k++) {
      const f = this.floor[k];
      this.floor[k] = energy[k] < f ? 0.5 * f + 0.5 * energy[k] : f * 1.02;
      snr[k] = energy[k] / this.floor[k];
    }
    this.hist[hop % HISTORY] = snr;

    const per = TONES_PER_BANK * 2;
    for (let b = 0; b < this.bands.length; b++) {
      let max = 0;
      for (let k = b * per; k < (b + 1) * per; k++) if (snr[k] > max) max = snr[k];
      this.level[b] = 0.85 * this.level[b] + 0.15 * max;
    }
    this.cb.onLevel?.(this.levels());
  }

  /** Current level per band in dB above that band's noise floor. */
  levels() {
    const out = {};
    this.bands.forEach((band, b) => (out[band.id] = Math.max(0, 10 * Math.log10(this.level[b] || 1))));
    return out;
  }

  get(hop) {
    if (hop < 0 || hop >= this.nextHop || hop < this.nextHop - HISTORY) return null;
    return this.hist[hop % HISTORY];
  }

  /** Values for one slot: the 16 tone bins of the right bank and band. */
  slotValues(hop, b, slot) {
    const snr = this.get(hop);
    if (!snr) return null;
    const bank = bankOf(slot);
    const v = new Float32Array(TONES_PER_BANK);
    for (let t = 0; t < TONES_PER_BANK; t++) v[t] = snr[this.binIndex(b, bank, t)];
    return v;
  }

  syncScore(h, b) {
    let total = 0;
    for (let s = 0; s < SYNC_SLOTS; s++) {
      const v = this.slotValues(h + s * HOPS_PER_SYMBOL, b, s);
      if (!v) return 0;
      const want = v[SYNC_TONES[s]];
      if (want < SYNC_MIN_SNR) return 0;
      let sum = 0;
      for (let t = 0; t < TONES_PER_BANK; t++) sum += v[t];
      total += want / sum;
    }
    return total / SYNC_SLOTS;
  }

  step() {
    const latest = this.nextHop - 1;

    if (this.pending) {
      this.collect(latest);
      return;
    }

    // A half-aligned window can still score well (the bank alternation keeps
    // the other half quiet), so only accept h if nothing within a symbol
    // either side scores higher. That needs hops up to h + 12 + 3.
    const lastSyncHop = (SYNC_SLOTS - 1) * HOPS_PER_SYMBOL;
    const R = HOPS_PER_SYMBOL - 1;
    this.scan = Math.max(this.scan, latest - HISTORY + 20);
    while (this.scan + lastSyncHop + R <= latest) {
      const h = this.scan++;
      for (let b = 0; b < this.bands.length; b++) {
        const s = this.syncScore(h, b);
        if (s < SYNC_THRESHOLD) continue;
        let isPeak = true;
        for (let d = -R; d <= R && isPeak; d++) {
          if (d === 0) continue;
          const o = this.syncScore(h + d, b);
          if (d < 0 ? o > s : o >= s) isPeak = false;
        }
        if (!isPeak) continue;
        this.pending = { h0: h, b, slots: [], score: s };
        this.cb.onSync?.({ band: this.bands[b].id, score: s });
        this.collect(latest);
        return;
      }
    }
  }

  collect(latest) {
    const p = this.pending;
    while (p.slots.length < rs.N) {
      const slot = SYNC_SLOTS + p.slots.length;
      const hop = p.h0 + slot * HOPS_PER_SYMBOL;
      if (hop > latest) return;
      const v = this.slotValues(hop, p.b, slot);
      let sum = 0;
      for (let t = 0; t < TONES_PER_BANK; t++) sum += v[t];
      for (let t = 0; t < TONES_PER_BANK; t++) v[t] /= sum;
      p.slots.push(v);
      const { best, conf } = pick(v);
      this.cb.onSymbol?.({ index: p.slots.length - 1, value: best, confidence: conf, band: this.bands[p.b].id });
    }
    this.pending = null;
    // After a good frame, skip ahead to just before the next one. After a bad
    // one, the lock may have been false, so rescan from right after it.
    this.scan = this.finish(p) ? p.h0 + FRAME_HOPS - HOPS_PER_SYMBOL : p.h0 + 1;
  }

  finish(frame) {
    // Try this frame alone, then combined with up to two earlier repeats.
    const chain = [frame];
    for (let i = this.recent.length - 1; i >= 0 && chain.length < 3; i--) {
      const prev = this.recent[i];
      const gap = frame.h0 - prev.h0;
      const k = Math.round(gap / FRAME_HOPS);
      if (prev.b === frame.b && k >= 1 && k <= 2 && Math.abs(gap - k * FRAME_HOPS) <= 2) chain.push(prev);
    }
    this.recent.push(frame);
    if (this.recent.length > 3) this.recent.shift();

    for (let n = 1; n <= chain.length; n++) {
      const word = [];
      let confSum = 0;
      for (let i = 0; i < rs.N; i++) {
        const acc = new Float32Array(TONES_PER_BANK);
        for (let j = 0; j < n; j++) for (let t = 0; t < TONES_PER_BANK; t++) acc[t] += chain[j].slots[i][t];
        const { best, conf } = pick(acc);
        word.push(best);
        confSum += conf;
      }
      const res = rs.decode(word);
      if (res) {
        this.cb.onFrame?.({
          nibbles: res.data,
          band: this.bands[frame.b].id,
          corrected: res.corrected,
          combined: n,
          confidence: confSum / rs.N,
          syncScore: frame.score,
        });
        return true;
      }
    }
    this.cb.onLost?.({ band: this.bands[frame.b].id, syncScore: frame.score });
    return false;
  }
}

function pick(v) {
  let best = -1;
  let second = -1;
  for (let t = 0; t < v.length; t++) {
    if (best < 0 || v[t] > v[best]) {
      second = best;
      best = t;
    } else if (second < 0 || v[t] > v[second]) {
      second = t;
    }
  }
  const total = v[best] + v[second];
  return { best, conf: total > 0 ? v[best] / total : 0 };
}
