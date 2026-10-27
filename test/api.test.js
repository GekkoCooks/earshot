import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { openDb } from '../server/db.js';
import { createApp } from '../server/app.js';
import { tagFor } from '../server/codes.js';
import { enrolMessage, checkinMessage } from '../server/devices.js';
import { importSecret, payloadFor } from '../public/js/lib/codes.js';
import { WINDOW_MS, packPayload, nibblesToHex } from '../public/js/modem/protocol.js';

const KEY = 'test-lecturer-key';
let clock = Date.UTC(2026, 9, 27, 9, 0, 0);
let server;
let base;
let app;

before(async () => {
  const db = openDb(':memory:');
  app = createApp({ db, lecturerKey: KEY, publicDir: '/nonexistent', now: () => clock });
  server = http.createServer(app.handle);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  app.hub.close();
  server.close();
});

async function call(method, path, body, { lecturer = false } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (lecturer) headers.cookie = `es_lecturer=${KEY}`;
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, body: json };
}

async function phone() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const publicKey = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
  const sign = async (msg) =>
    Buffer.from(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(msg))).toString('base64url');
  return {
    publicKey,
    async enrol(code, roll, name) {
      const nonce = crypto.randomUUID();
      return call('POST', `/api/join/${code}/enrol`, { roll, name, publicKey, nonce, sig: await sign(enrolMessage(code, roll, nonce)) });
    },
    async checkin(sessionId, roll, payload, extra = {}) {
      const nonce = crypto.randomUUID();
      return call('POST', '/api/checkin', {
        sessionId,
        roll,
        payload,
        band: 'quiet',
        nonce,
        publicKey,
        sig: await sign(checkinMessage(sessionId, roll, payload, nonce)),
        ...extra,
      });
    },
    sign,
  };
}

const currentPayload = (s) => {
  const w = Math.floor((clock - s.startedAt) / WINDOW_MS);
  return nibblesToHex(packPayload(w & 0xff, tagFor(s.secret, s.id, w)));
};

let course;
let session;

test('lecturer endpoints need the key', async () => {
  assert.equal((await call('GET', '/api/courses')).status, 401);
  assert.equal((await call('POST', '/api/login', { key: 'nope' })).status, 401);
  assert.equal((await call('POST', '/api/login', { key: KEY })).status, 200);
});

test('create a course with a roster and start a session', async () => {
  const r = await call(
    'POST',
    '/api/courses',
    { code: 'cs201', title: 'Data Structures', roster: 'roll,name\n21CS001, Asha Rao\n21CS002,Vikram Iyer\n21CS003\tMeera Nair\n=EVIL(),Hacker' },
    { lecturer: true },
  );
  assert.equal(r.status, 201);
  course = r.body.course;
  assert.equal(course.code, 'CS201');
  // "roll,name" header and the formula row are rejected by the roll format check.
  assert.equal(r.body.added, 3);

  const s = await call('POST', `/api/courses/${course.id}/sessions`, {}, { lecturer: true });
  assert.equal(s.status, 201);
  session = { ...s.body.session, secret: s.body.secret };
  assert.match(session.secret, /^[0-9a-f]{64}$/);

  const again = await call('POST', `/api/courses/${course.id}/sessions`, {}, { lecturer: true });
  assert.equal(again.body.session.id, session.id, 'starting twice resumes the live session');
});

test('browser and server compute the same code', async () => {
  const key = await importSecret(session.secret);
  for (const w of [0, 1, 255, 256, 9999]) {
    const browser = await payloadFor(key, session.id, w);
    assert.deepEqual(browser, packPayload(w & 0xff, tagFor(session.secret, session.id, w)));
  }
});

let asha;

test('a student with the live code is marked present', async () => {
  asha = await phone();
  const join = await call('GET', '/api/join/cs201');
  assert.equal(join.body.session.id, session.id);
  assert.equal((await asha.enrol('CS201', '21CS001')).body.binding, 'yours');

  const r = await asha.checkin(session.id, '21CS001', currentPayload(session));
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'present');
  assert.equal(r.body.student.name, 'Asha Rao');

  const again = await asha.checkin(session.id, '21CS001', currentPayload(session));
  assert.equal(again.body.status, 'already');
});

test('one phone cannot check in a second person', async () => {
  const r = await asha.checkin(session.id, '21CS002', currentPayload(session));
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'device_used');
  const e = await asha.enrol('CS201', '21CS002');
  assert.equal(e.body.error, 'device_taken');
});

test('a recorded code stops working after its window', async () => {
  const vikram = await phone();
  await vikram.enrol('CS201', '21CS002');
  const recorded = currentPayload(session);
  clock += WINDOW_MS * 2 + 10;
  const r = await vikram.checkin(session.id, '21CS002', recorded);
  assert.equal(r.status, 422);
  assert.equal(r.body.error, 'stale_code');
  // The previous window is still accepted, to cover decode and network time.
  const prevWindow = Math.floor((clock - session.startedAt) / WINDOW_MS) - 1;
  const prev = nibblesToHex(packPayload(prevWindow & 0xff, tagFor(session.secret, session.id, prevWindow)));
  assert.equal((await vikram.checkin(session.id, '21CS002', prev)).body.status, 'present');
});

test('made-up codes are rejected', async () => {
  const meera = await phone();
  await meera.enrol('CS201', '21CS003');
  const r = await meera.checkin(session.id, '21CS003', '00abcdef');
  assert.equal(r.body.error, 'bad_code');
});

test('requests signed by a different key are rejected', async () => {
  const thief = await phone();
  const nonce = 'x';
  const payload = currentPayload(session);
  const r = await call('POST', '/api/checkin', {
    sessionId: session.id,
    roll: '21CS003',
    payload,
    nonce,
    publicKey: asha.publicKey,
    sig: await thief.sign(checkinMessage(session.id, '21CS003', payload, nonce)),
  });
  assert.equal(r.body.error, 'bad_signature');
});

test('a new phone for a known student is held for review', async () => {
  const newPhone = await phone();
  const e = await newPhone.enrol('CS201', '21CS003');
  assert.equal(e.body.binding, 'other_device');
  // Meera's first phone is bound from the earlier enrol; this is a second one.
  const r = await newPhone.checkin(session.id, '21CS003', currentPayload(session));
  assert.equal(r.body.status, 'pending');
  const view = await call('GET', `/api/sessions/${session.id}`, undefined, { lecturer: true });
  const meera = view.body.checkins.find((c) => c.roll === '21CS003');
  assert.deepEqual(meera.flags, ['New phone']);

  const sid = view.body.students.find((s) => s.roll === '21CS003').id;
  assert.equal((await call('POST', `/api/sessions/${session.id}/students/${sid}`, { action: 'approve' }, { lecturer: true })).status, 200);
  const after = await call('GET', `/api/sessions/${session.id}`, undefined, { lecturer: true });
  assert.equal(after.body.checkins.find((c) => c.roll === '21CS003').status, 'present');
});

test('guessing is rate limited per phone', async () => {
  const guesser = await phone();
  const codes = [];
  for (let i = 0; i < 10; i++) codes.push((await guesser.checkin(session.id, '21CS009', i.toString(16).padStart(8, '0'))).status);
  assert.ok(codes.includes(429), `statuses: ${codes}`);
});

test('CSV export lists everyone and defuses formulas', async () => {
  await call('POST', `/api/courses/${course.id}/students`, { roster: '21CS004,=HYPERLINK("x")' }, { lecturer: true });
  const r = await fetch(`${base}/api/sessions/${session.id}/export.csv`, { headers: { cookie: `es_lecturer=${KEY}` } });
  const csv = await r.text();
  assert.match(csv, /"21CS001","Asha Rao","Present"/);
  assert.match(csv, /"21CS004","'=HYPERLINK\(""x""\)","Absent"/);
});

test('nothing gets in after the session ends', async () => {
  await call('POST', `/api/sessions/${session.id}/end`, {}, { lecturer: true });
  const late = await phone();
  const r = await late.checkin(session.id, '21CS004', currentPayload(session));
  assert.equal(r.status, 410);
  assert.equal((await call('GET', '/api/join/cs201')).body.session, null);
});
