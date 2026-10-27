// Fills a live session with simulated phones, for demos and screenshots.
// Each phone makes its own key, enrols, pings as a listener and checks in
// with a real signed request. It reads the session secret straight from the
// database, which a real phone obviously cannot do.
//
//   node scripts/simulate-class.js CS201 [count] [seconds]

import { config } from '../server/config.js';
import { openDb } from '../server/db.js';
import { tagFor } from '../server/codes.js';
import { enrolMessage, checkinMessage } from '../server/devices.js';
import { WINDOW_MS, packPayload, nibblesToHex } from '../public/js/modem/protocol.js';

const [code = 'CS201', countArg, secondsArg] = process.argv.slice(2);
const base = process.env.BASE || `http://localhost:${config.httpPort}`;
const db = openDb(config.dbFile);
const course = db.courses.byCode(code);
if (!course) throw new Error(`No class ${code}`);
const session = db.sessions.live(course.id);
if (!session) throw new Error(`Start a session for ${code} first`);

const students = db.students.forCourse(course.id);
const count = Math.min(Number(countArg || Math.round(students.length * 0.85)), students.length);
const seconds = Number(secondsArg || 40);
const chosen = students.sort(() => Math.random() - 0.5).slice(0, count);

const post = (path, body) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

async function phone() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const publicKey = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
  const sign = async (m) => Buffer.from(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(m))).toString('base64url');
  return { publicKey, sign, id: Math.random().toString(36).slice(2) };
}

function payloadNow() {
  const w = Math.floor((Date.now() - session.started_at) / WINDOW_MS);
  return nibblesToHex(packPayload(w & 0xff, tagFor(session.secret, session.id, w)));
}

let done = 0;
await Promise.all(
  chosen.map(async (st, i) => {
    const p = await phone();
    const wait = Math.pow(Math.random(), 1.6) * seconds * 1000;
    // Some phones show up as listening (or struggling) before they get through.
    setTimeout(() => post(`/api/join/${code}/ping`, { device: p.id, state: i % 7 === 0 ? 'faint' : 'listening', level: 14 }), Math.max(0, wait - 3000));
    await new Promise((r) => setTimeout(r, wait));
    if (!st.device_id) {
      const nonce = crypto.randomUUID();
      await post(`/api/join/${code}/enrol`, { roll: st.roll, publicKey: p.publicKey, nonce, sig: await p.sign(enrolMessage(code, st.roll, nonce)) });
    }
    const payload = payloadNow();
    const nonce = crypto.randomUUID();
    const r = await post('/api/checkin', {
      sessionId: session.id,
      roll: st.roll,
      payload,
      band: 'quiet',
      nonce,
      publicKey: p.publicKey,
      sig: await p.sign(checkinMessage(session.id, st.roll, payload, nonce)),
      meta: { combined: 1 },
    });
    done++;
    process.stdout.write(`\r${done}/${count} ${st.roll} ${r.status || r.error}        `);
  }),
);
console.log('\ndone');
