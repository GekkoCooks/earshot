// Field test: play test codes on one device, measure on another.
// Test codes use a fixed tag so they are easy to tell apart from real ones.

import { startReceiver, MicError } from './lib/receiver.js';
import { Waterfall } from './lib/listen-view.js';
import { synthFrame } from './modem/synth.js';
import { BANDS, FRAME_MS, FRAMES_PER_WINDOW, packPayload, unpackPayload } from './modem/protocol.js';

const $ = (s) => document.querySelector(s);
const TEST_TAG = 0xea5011;

document.querySelectorAll('[data-mode]').forEach((b) =>
  b.addEventListener('click', () => {
    document.querySelectorAll('[data-mode]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    $('#listen').hidden = b.dataset.mode !== 'listen';
    $('#play').hidden = b.dataset.mode !== 'play';
  }),
);

// ---------- listen ----------

let rx = null;
const stats = { syncs: 0, frames: 0, lost: 0, first: null, started: 0 };

function renderStats() {
  const rate = stats.syncs ? Math.round((100 * stats.frames) / stats.syncs) : 0;
  $('#stats').innerHTML = [
    ['Frames heard', stats.syncs],
    ['Decoded', stats.frames],
    ['Success', `${rate}%`],
    ['First code', stats.first == null ? '-' : `${stats.first.toFixed(1)} s`],
  ]
    .map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`)
    .join('');
}

function log(html) {
  const li = document.createElement('li');
  li.innerHTML = `${new Date().toLocaleTimeString()} ${html}`;
  $('#log').prepend(li);
  while ($('#log').children.length > 40) $('#log').lastChild.remove();
}

$('#listenBtn').addEventListener('click', async () => {
  if (rx) {
    rx.stop();
    rx = null;
    $('#listenBtn').textContent = 'Start listening';
    return;
  }
  const wfQ = new Waterfall($('#wfQuiet'));
  const wfA = new Waterfall($('#wfAudible'));
  Object.assign(stats, { syncs: 0, frames: 0, lost: 0, first: null, started: performance.now() });
  renderStats();
  try {
    rx = await startReceiver({
      onLevel(lv) {
        $('#lvQuiet').textContent = `${lv.quiet.toFixed(0)} dB`;
        $('#lvAudible').textContent = `${lv.audible.toFixed(0)} dB`;
        wfQ.push(rx?.demod.spectrum('quiet'));
        wfA.push(rx?.demod.spectrum('audible'));
      },
      onSync() {
        stats.syncs++;
        renderStats();
      },
      onLost({ band, syncScore }) {
        stats.lost++;
        log(`frame lost in noise (${band}, sync ${syncScore.toFixed(2)})`);
      },
      onFrame(f) {
        stats.frames++;
        stats.first ??= (performance.now() - stats.started) / 1000;
        const { counter, tag } = unpackPayload(f.nibbles);
        const kind = tag === TEST_TAG ? 'test code' : 'class code';
        const how = [f.combined > 1 ? `${f.combined} repeats combined` : null, f.corrected ? '1 symbol fixed' : null].filter(Boolean).join(', ');
        log(`<b>${kind} ${counter}</b> on ${f.band}${how ? `, ${how}` : ''}`);
        renderStats();
      },
    });
    $('#listenBtn').textContent = 'Stop';
    log(`microphone at ${rx.sampleRate} Hz`);
  } catch (e) {
    log(`<b>Could not start the microphone:</b> ${e instanceof MicError ? e.kind : e.message}`);
  }
});

// ---------- play ----------

let player = null;
let band = 'quiet';

document.querySelectorAll('[data-band]').forEach((b) =>
  b.addEventListener('click', () => {
    band = b.dataset.band;
    document.querySelectorAll('[data-band]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  }),
);

$('#vol').addEventListener('input', (e) => player?.gain.gain.setTargetAtTime(Number(e.target.value), player.ctx.currentTime, 0.05));

$('#playBtn').addEventListener('click', () => {
  if (player) {
    clearInterval(player.timer);
    player.ctx.close();
    player = null;
    $('#playBtn').textContent = 'Play test codes';
    return;
  }
  const ctx = new AudioContext({ latencyHint: 'playback' });
  const gain = ctx.createGain();
  gain.gain.value = Number($('#vol').value);
  gain.connect(ctx.destination);
  let next = ctx.currentTime + 0.2;
  let frame = 0;
  const schedule = () => {
    while (next < ctx.currentTime + 2) {
      const counter = Math.floor(frame / FRAMES_PER_WINDOW) & 0xff;
      const pcm = synthFrame(packPayload(counter, TEST_TAG), { band: BANDS[band], sampleRate: ctx.sampleRate, amplitude: 0.9 });
      const buf = ctx.createBuffer(1, pcm.length, ctx.sampleRate);
      buf.copyToChannel(pcm, 0);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(gain);
      src.start(next);
      next += FRAME_MS / 1000;
      frame++;
    }
  };
  schedule();
  player = { ctx, gain, timer: setInterval(schedule, 300) };
  $('#playBtn').textContent = 'Stop';
});

renderStats();
