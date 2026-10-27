// Sweeps the simulated channel and prints how often a listener catches the
// code within one 8 s window, and how long it takes.
//   node scripts/modem-bench.js [trials]

import { BANDS, packPayload } from '../public/js/modem/protocol.js';
import { Demodulator } from '../public/js/modem/demod.js';
import { record, rng } from '../test/helpers/channel.js';

const trials = Number(process.argv[2] || 12);
const fs = 48000;

function run(opts, seed) {
  const rand = rng(seed);
  const p = packPayload(Math.floor(rand() * 256), Math.floor(rand() * 2 ** 24));
  const audio = record({ payloads: [p], sampleRate: fs, seed, leadMs: 0, ...opts });
  let firstAt = null;
  let wrong = 0;
  let pushed = 0;
  const demod = new Demodulator({
    sampleRate: fs,
    onFrame: (f) => {
      if (f.nibbles.join() === p.join()) firstAt ??= pushed / fs;
      else wrong++;
    },
  });
  for (let i = 0; i < audio.length; i += 2048) {
    const chunk = audio.subarray(i, i + 2048);
    pushed += chunk.length;
    demod.push(chunk);
  }
  return { firstAt, wrong };
}

const rows = [];
for (const [bandName, band] of Object.entries(BANDS)) {
  for (const rt60 of [0.4, 0.8, 1.2]) {
    for (const snrDb of [-12, -9, -6, -3, 0, 6]) {
      let ok = 0;
      let wrong = 0;
      const times = [];
      for (let t = 0; t < trials; t++) {
        const r = run(
          { band, snrDb, rt60, wet: 0.6, rolloffHz: bandName === 'quiet' ? 16500 : 0, drift: 1 + (t % 3) * 1e-4, babble: bandName === 'audible' ? 0.02 : 0 },
          1000 + t * 7 + snrDb * 31 + rt60 * 100,
        );
        if (r.firstAt != null) {
          ok++;
          times.push(r.firstAt);
        }
        wrong += r.wrong;
      }
      times.sort((a, b) => a - b);
      rows.push({
        band: bandName,
        rt60,
        'snr dB': snrDb,
        'caught %': Math.round((100 * ok) / trials),
        'median s': times.length ? times[Math.floor(times.length / 2)].toFixed(1) : '-',
        'false': wrong,
      });
    }
  }
}
console.table(rows);
