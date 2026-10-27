import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as rs from '../public/js/modem/rs.js';
import { BANDS, packPayload, unpackPayload } from '../public/js/modem/protocol.js';
import { Demodulator } from '../public/js/modem/demod.js';
import { record, rng } from './helpers/channel.js';

function randomPayload(rand) {
  return packPayload(Math.floor(rand() * 256), Math.floor(rand() * 2 ** 24));
}

function listen(samples, sampleRate) {
  const frames = [];
  const demod = new Demodulator({ sampleRate, onFrame: (f) => frames.push(f) });
  // Feed in browser-sized chunks.
  for (let i = 0; i < samples.length; i += 2048) demod.push(samples.subarray(i, i + 2048));
  return frames;
}

test('RS round trip with no errors', () => {
  const rand = rng(7);
  for (let i = 0; i < 200; i++) {
    const data = Array.from({ length: 8 }, () => Math.floor(rand() * 16));
    const word = rs.encode(data);
    assert.deepEqual(rs.syndromes(word), [0, 0, 0, 0]);
    assert.deepEqual(rs.decode(word).data, data);
  }
});

test('RS corrects any single symbol error', () => {
  const rand = rng(9);
  for (let i = 0; i < 300; i++) {
    const data = Array.from({ length: 8 }, () => Math.floor(rand() * 16));
    const word = rs.encode(data);
    const pos = Math.floor(rand() * 12);
    word[pos] ^= 1 + Math.floor(rand() * 15);
    const res = rs.decode(word);
    assert.ok(res, 'should decode');
    assert.equal(res.corrected, 1);
    assert.deepEqual(res.data, data);
  }
});

test('RS rejects most double errors and almost all noise', () => {
  const rand = rng(11);
  let wrongAccept = 0;
  for (let i = 0; i < 2000; i++) {
    const noise = Array.from({ length: 12 }, () => Math.floor(rand() * 16));
    if (rs.decode(noise)) wrongAccept++;
  }
  // Expected rate is 181 / 65536, about 0.28%.
  assert.ok(wrongAccept < 20, `accepted ${wrongAccept} of 2000 random words`);
});

test('payload packing round trip', () => {
  const nib = packPayload(0xab, 0x123456);
  assert.deepEqual(nib, [0xa, 0xb, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(unpackPayload(nib), { counter: 0xab, tag: 0x123456 });
});

for (const [name, band] of Object.entries(BANDS)) {
  for (const fs of [48000, 44100]) {
    test(`decodes a clean ${name} transmission at ${fs} Hz`, () => {
      const rand = rng(fs + name.length);
      const p = randomPayload(rand);
      const audio = record({ payloads: [p], band, sampleRate: fs, snrDb: 25, rt60: 0, seed: 3 });
      const frames = listen(audio, fs);
      assert.ok(frames.length >= 4, `got ${frames.length} frames`);
      for (const f of frames) assert.deepEqual(f.nibbles, p);
    });
  }
}

test('decodes through echo, roll-off, drift and noise', () => {
  const rand = rng(42);
  const p1 = randomPayload(rand);
  const p2 = randomPayload(rand);
  const audio = record({
    payloads: [p1, p2],
    band: BANDS.quiet,
    snrDb: 6,
    rt60: 0.8,
    wet: 0.6,
    rolloffHz: 16500,
    drift: 1.0002,
    seed: 5,
  });
  const frames = listen(audio, 48000);
  const got = new Set(frames.map((f) => f.nibbles.join(',')));
  assert.ok(got.has(p1.join(',')), 'first code heard');
  assert.ok(got.has(p2.join(',')), 'second code heard');
  for (const g of got) assert.ok(g === p1.join(',') || g === p2.join(','), 'no false decodes');
});

test('silence and noise produce no frames', () => {
  const rand = rng(3);
  const noise = new Float32Array(48000 * 20);
  for (let i = 0; i < noise.length; i++) noise[i] = (rand() - 0.5) * 0.2;
  assert.equal(listen(noise, 48000).length, 0);
});
