// End-to-end check-in through a real browser.
//
// Starts a server, creates a class and a session, renders the session's
// upcoming codes to a WAV file (through the simulated room: echo, roll-off,
// noise), and feeds that file to headless Chrome as its microphone. The real
// student page then has to identify, listen, decode and check in.
//
//   npm run e2e               quiet band
//   npm run e2e -- audible    audible band

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { openDb } from '../server/db.js';
import { createApp } from '../server/app.js';
import { tagFor } from '../server/codes.js';
import { BANDS, WINDOW_MS, packPayload } from '../public/js/modem/protocol.js';
import { record } from '../test/helpers/channel.js';
import { launch, openPage } from './lib/cdp.js';
import { config } from '../server/config.js';

const bandName = process.argv[2] || 'quiet';
const band = BANDS[bandName];
const shotDir = process.env.SHOTS;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'earshot-e2e-'));
const KEY = 'e2e-key';

const db = openDb(':memory:');
const app = createApp({ db, lecturerKey: KEY, publicDir: config.publicDir });
const server = http.createServer(app.handle);
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;

const call = async (method, p, body) => {
  const res = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json', cookie: `es_lecturer=${KEY}` },
    body: body && JSON.stringify(body),
  });
  return res.json();
};

function writeWav(file, samples, rate) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(Math.max(-1, Math.min(1, samples[i])) * 32767, i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, data]));
}

let exitCode = 1;
let chrome;
try {
  const { course } = await call('POST', '/api/courses', { code: 'E2E', title: 'End to end', roster: '21CS001, Asha Rao' });
  const started = await call('POST', `/api/courses/${course.id}/sessions`, { mode: bandName });
  const s = { ...started.session, secret: started.secret };

  // Codes for the next minute, starting with the current window.
  const w0 = Math.floor((Date.now() - s.startedAt) / WINDOW_MS);
  const payloads = [];
  for (let w = w0; w < w0 + 8; w++) payloads.push(packPayload(w & 0xff, tagFor(s.secret, s.id, w)));
  const audio = record({ payloads, band, sampleRate: 48000, snrDb: Number(process.env.SNR ?? 3), rt60: 0.6, wet: 0.5, rolloffHz: bandName === 'quiet' ? 16500 : 0, leadMs: 0, seed: 9 });
  const wav = path.join(tmp, 'mic.wav');
  writeWav(wav, audio, 48000);
  if (process.env.KEEPWAV) fs.copyFileSync(wav, process.env.KEEPWAV);
  console.log(`session ${s.id}, ${payloads.length} codes, ${(audio.length / 48000).toFixed(0)} s of ${bandName} audio, SNR ${process.env.SNR ?? 3} dB in band`);

  chrome = await launch({
    headed: true,
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-audio-capture=${wav}`,
      // The sandboxed audio service cannot read the file and plays silence.
      '--disable-features=AudioServiceOutOfProcess,AudioServiceSandbox',
    ],
  });
  const page = await openPage(chrome.port);
  if (!process.env.NOVP) await page.viewport(390, 844, { mobile: true });
  page.on((m) => {
    if (m.method === 'Runtime.exceptionThrown') console.log('page error:', m.params.exceptionDetails.exception?.description);
  });

  await page.goto(`${base}/c/E2E`, 800);
  if ((await page.eval('document.querySelector("#app").dataset.view')) !== 'identify') throw new Error('expected identify view');
  await page.eval(`(() => { const f = document.querySelector('#who'); f.roll.value = '21cs001'; f.requestSubmit(); })()`);
  await new Promise((r) => setTimeout(r, 800));
  const v = await page.eval('document.querySelector("#app").dataset.view');
  if (v !== 'ready') throw new Error(`expected ready view, got ${v}`);

  const t0 = Date.now();
  await page.eval(`document.querySelector('[data-act=listen]').click()`);
  let view = '';
  let shotTaken = false;
  while (Date.now() - t0 < 45_000) {
    await new Promise((r) => setTimeout(r, 250));
    view = await page.eval('document.querySelector("#app").dataset.view');
    if (shotDir && !shotTaken && view === 'listening' && Date.now() - t0 > 1200) {
      const filled = await page.eval('document.querySelectorAll(".slot.on").length');
      if (filled >= 5) {
        await page.screenshot(path.join(shotDir, `e2e-${bandName}-listening.png`));
        shotTaken = true;
      }
    }
    // Frames of the catch animation, for reviewing the motion.
    if (shotDir && process.env.FRAMES && (await page.eval('!!document.querySelector(".s-viz.caught")'))) {
      for (let k = 0; k < 6; k++) {
        await page.screenshot(path.join(shotDir, `e2e-catch-${k}.png`));
        await new Promise((r) => setTimeout(r, 160));
      }
      await new Promise((r) => setTimeout(r, 800));
      view = await page.eval('document.querySelector("#app").dataset.view');
    }
    if (view !== 'listening') break;
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (shotDir) await page.screenshot(path.join(shotDir, `e2e-${bandName}-${view}.png`));

  const sv = await call('GET', `/api/sessions/${s.id}`);
  const ok = view === 'present' && sv.checkins.length === 1 && sv.checkins[0].roll === '21CS001' && sv.checkins[0].status === 'present';
  if (!ok) console.log('page stats:', JSON.stringify(await page.eval('window.__earshot').catch(() => null)));
  console.log(ok ? `PASS: marked present after ${secs} s of listening` : `FAIL: view=${view}, checkins=${JSON.stringify(sv.checkins)}`);
  exitCode = ok ? 0 : 1;
  page.close();
} catch (e) {
  console.error('FAIL:', e.message);
} finally {
  await chrome?.close();
  app.hub.close();
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(exitCode);
}
