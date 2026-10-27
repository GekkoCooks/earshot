// Plays the rotating code from the lecturer's laptop.
//
// Frames are scheduled on the Web Audio clock a few seconds ahead, aligned to
// the server's windows, so the sound stays steady even if the tab is in the
// background or the network drops for a moment.

import { FRAME_MS, FRAMES_PER_WINDOW, BANDS, frameTones } from '../modem/protocol.js';
import { synthFrame } from '../modem/synth.js';
import { importSecret, payloadFor } from '../lib/codes.js';
import { serverNow } from '../lib/clock.js';

const LOOKAHEAD_MS = 3200;

export class Transmitter {
  constructor({ sessionId, secretHex, startedAt, mode = 'quiet', volume = 0.8 }) {
    this.sessionId = sessionId;
    this.secretHex = secretHex;
    this.startedAt = startedAt;
    this.mode = mode;
    this.volume = volume;
    this.buffers = new Map();
    this.payloads = new Map();
    this.scheduled = [];
    this.nextFrame = null;
    this.running = false;
  }

  /** Call from a click handler: browsers only start audio after a gesture. */
  start() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx({ latencyHint: 'playback' });
    this.gain = this.ctx.createGain();
    this.gain.gain.value = this.volume;
    this.gain.connect(this.ctx.destination);
    this.ctx.resume();
    this.running = true;
    this.ready = importSecret(this.secretHex).then((k) => (this.key = k));
    this.timer = setInterval(() => this.tick(), 200);
    this.tick();
    return this.ready;
  }

  get state() {
    return this.ctx?.state ?? 'closed';
  }

  setVolume(v) {
    this.volume = v;
    if (this.gain) this.gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    // Drop frames queued in the old band so the switch is heard within a frame.
    const soon = this.ctx ? this.ctx.currentTime + 0.05 : 0;
    this.scheduled = this.scheduled.filter((s) => {
      if (s.at > soon) {
        s.node.onended = null;
        s.node.stop();
        if (this.nextFrame === null || s.frame < this.nextFrame) this.nextFrame = s.frame;
        return false;
      }
      return true;
    });
  }

  async payload(window) {
    if (!this.payloads.has(window)) this.payloads.set(window, payloadFor(this.key, this.sessionId, window));
    if (this.payloads.size > 8) this.payloads.delete(this.payloads.keys().next().value);
    return this.payloads.get(window);
  }

  async buffer(window) {
    const k = `${window}:${this.mode}`;
    if (!this.buffers.has(k)) {
      const mode = this.mode;
      this.buffers.set(
        k,
        this.payload(window).then((p) => {
          const pcm = synthFrame(p, { band: BANDS[mode], sampleRate: this.ctx.sampleRate, amplitude: 0.9 });
          const buf = this.ctx.createBuffer(1, pcm.length, this.ctx.sampleRate);
          buf.copyToChannel(pcm, 0);
          return buf;
        }),
      );
      if (this.buffers.size > 8) this.buffers.delete(this.buffers.keys().next().value);
    }
    return this.buffers.get(k);
  }

  async tick() {
    if (!this.running || !this.key || this.busy) return;
    this.busy = true;
    try {
      const now = serverNow();
      const current = Math.floor((now - this.startedAt) / FRAME_MS);
      if (this.nextFrame === null || this.nextFrame < current) this.nextFrame = current;
      while (this.startedAt + this.nextFrame * FRAME_MS < now + LOOKAHEAD_MS) {
        const f = this.nextFrame;
        const window = Math.floor(f / FRAMES_PER_WINDOW);
        const buf = await this.buffer(window);
        const startServer = this.startedAt + f * FRAME_MS;
        const at = this.ctx.currentTime + (startServer - serverNow()) / 1000;
        this.nextFrame = f + 1;
        // A frame we can no longer start on time would be cut short; skip it.
        if (at < this.ctx.currentTime + 0.02) continue;
        const node = this.ctx.createBufferSource();
        node.buffer = buf;
        node.connect(this.gain);
        node.start(at);
        const entry = { frame: f, at, node };
        node.onended = () => (this.scheduled = this.scheduled.filter((s) => s !== entry));
        this.scheduled.push(entry);
      }
    } finally {
      this.busy = false;
    }
  }

  /** What is playing right now, for the on-screen picture. */
  async nowPlaying() {
    if (!this.key) return null;
    const t = serverNow() - this.startedAt;
    const f = Math.floor(t / FRAME_MS);
    const window = Math.floor(f / FRAMES_PER_WINDOW);
    const slot = Math.floor((t % FRAME_MS) / (FRAME_MS / 16));
    const tones = frameTones(await this.payload(window));
    return { window, slot, tones, mode: this.mode };
  }

  stop() {
    this.running = false;
    clearInterval(this.timer);
    this.scheduled.forEach((s) => {
      s.node.onended = null;
      try {
        s.node.stop();
      } catch {
        /* not started */
      }
    });
    this.scheduled = [];
    this.ctx?.close();
  }
}
