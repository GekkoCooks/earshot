import crypto from 'node:crypto';
import { Router, HttpError, readJson, sendJson, parseCookies, serveFile, SECURITY_HEADERS, csvCell } from './http.js';
import { Hub } from './events.js';
import { RateLimiter } from './ratelimit.js';
import { newSecret, verifyCode, windowAt } from './codes.js';
import { thumbprint, verify, enrolMessage, checkinMessage } from './devices.js';
import { WINDOW_MS } from '../public/js/modem/protocol.js';

const MODES = new Set(['quiet', 'audible']);
const ROLL_RE = /^[A-Za-z0-9][A-Za-z0-9\-_/.]{0,31}$/;
const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9\-]{1,15}$/;

export function createApp({ db, lecturerKey, publicDir, now = () => Date.now(), joinBase = () => null }) {
  const hub = new Hub();
  const router = new Router();
  const limits = {
    checkinDevice: new RateLimiter(8, 60_000),
    // Generous: a whole class can share one campus Wi-Fi address.
    checkinIp: new RateLimiter(600, 60_000),
    enrolIp: new RateLimiter(60, 60_000),
    login: new RateLimiter(10, 60_000),
  };
  // sessionId -> Map(deviceId -> { state, level, at })
  const listeners = new Map();

  // Behind a tunnel every request comes from 127.0.0.1, so use the forwarded
  // address. Only when told to: the header is trivial to fake otherwise.
  const clientIp = (req) => {
    if (process.env.EARSHOT_TRUST_PROXY) {
      const fwd = req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (fwd) return fwd;
    }
    return req.socket.remoteAddress;
  };

  const isLecturer = (req) => {
    const key = parseCookies(req.headers.cookie).es_lecturer;
    if (!key) return false;
    const a = Buffer.from(key);
    const b = Buffer.from(lecturerKey);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  const requireLecturer = (req) => {
    if (!isLecturer(req)) throw new HttpError(401, 'lecturer_only');
  };

  const getCourse = (id) => {
    const c = db.courses.byId(Number(id));
    if (!c) throw new HttpError(404, 'no_course');
    return c;
  };
  const getSession = (id) => {
    const s = db.sessions.byId(id);
    if (!s) throw new HttpError(404, 'no_session');
    return s;
  };

  function parseRoster(text) {
    const rows = [];
    for (const line of String(text || '').split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const [roll, ...rest] = t.split(/[,\t;]/).map((x) => x.trim());
      if (!ROLL_RE.test(roll) || /^roll/i.test(roll)) continue; // skips a header row
      rows.push({ roll, name: rest.join(' ').trim() || roll });
    }
    return rows;
  }

  function listenerStats(sessionId) {
    const map = listeners.get(sessionId);
    const t = now();
    const out = { listening: 0, faint: 0, silent: 0 };
    if (!map) return out;
    for (const [id, l] of map) {
      if (t - l.at > 15_000) {
        map.delete(id);
        continue;
      }
      if (l.state in out) out[l.state]++;
    }
    return out;
  }

  function sessionView(s) {
    const course = db.courses.byId(s.course_id);
    const students = db.students.forCourse(s.course_id);
    const checkins = db.checkins.forSession(s.id).map(viewCheckin);
    return {
      session: { id: s.id, startedAt: s.started_at, endedAt: s.ended_at, mode: s.mode, windowMs: WINDOW_MS },
      course: { id: course.id, code: course.code, title: course.title },
      students: students.map((st) => ({ id: st.id, roll: st.roll, name: st.name, hasDevice: !!st.device_id, selfAdded: !!st.self_added })),
      checkins,
      listeners: listenerStats(s.id),
      attempts: db.attempts.forSession(s.id),
    };
  }

  function viewCheckin(k) {
    return { studentId: k.student_id, roll: k.roll, name: k.name, at: k.at, status: k.status, method: k.method, band: k.band, flags: JSON.parse(k.flags) };
  }

  function publishCheckin(sessionId, studentId) {
    const k = db.checkins.forSession(sessionId).find((c) => c.student_id === studentId);
    hub.publish(sessionId, 'checkin', k ? viewCheckin(k) : { studentId, removed: true });
  }

  // ---------- lecturer ----------

  router.add('POST', '/api/login', async (req, res) => {
    if (!limits.login.allow(clientIp(req))) throw new HttpError(429, 'rate_limited');
    const { key } = await readJson(req);
    const a = Buffer.from(String(key || ''));
    const b = Buffer.from(lecturerKey);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new HttpError(401, 'wrong_key');
    const secure = req.socket.encrypted ? '; Secure' : '';
    res.setHeader('set-cookie', `es_lecturer=${encodeURIComponent(lecturerKey)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000${secure}`);
    sendJson(res, 200, { ok: true });
  });

  router.add('GET', '/api/me', (req, res) => sendJson(res, 200, { lecturer: isLecturer(req) }));

  // Where phones should go. Falls back to however the lecturer reached us.
  router.add('GET', '/api/info', (req, res) => {
    requireLecturer(req);
    const proto = req.socket.encrypted ? 'https' : 'http';
    sendJson(res, 200, { joinBase: joinBase() || `${proto}://${req.headers.host}` });
  });

  router.add('GET', '/api/courses', (req, res) => {
    requireLecturer(req);
    // Recent attendance rates for a small trend line per class.
    const courses = db.courses.all().map((c) => ({
      ...c,
      recent: db.sessions
        .forCourse(c.id)
        .filter((x) => x.ended_at)
        .slice(0, 12)
        .reverse()
        .map((x) => (c.students ? x.present / c.students : 0)),
    }));
    sendJson(res, 200, { courses });
  });

  router.add('POST', '/api/courses', async (req, res) => {
    requireLecturer(req);
    const body = await readJson(req, 256 * 1024);
    const code = String(body.code || '').trim().toUpperCase();
    const title = String(body.title || '').trim().slice(0, 120);
    if (!CODE_RE.test(code)) throw new HttpError(400, 'bad_code_format', 'Course code: letters, numbers and dashes, 2 to 16 characters.');
    if (!title) throw new HttpError(400, 'title_required');
    if (db.courses.byCode(code)) throw new HttpError(409, 'code_taken', 'A course with that code already exists.');
    const roster = parseRoster(body.roster);
    const id = db.tx(() => {
      const id = Number(db.courses.insert(code, title, body.openRoster ?? roster.length === 0, now()));
      for (const r of roster) db.students.upsert(id, r.roll, r.name);
      return id;
    });
    sendJson(res, 201, { course: db.courses.byId(id), added: roster.length });
  });

  router.add('GET', '/api/courses/:id', (req, res, { id }) => {
    requireLecturer(req);
    const course = getCourse(id);
    sendJson(res, 200, {
      course,
      students: db.students.forCourse(course.id),
      sessions: db.sessions.forCourse(course.id),
    });
  });

  router.add('POST', '/api/courses/:id/students', async (req, res, { id }) => {
    requireLecturer(req);
    const course = getCourse(id);
    const roster = parseRoster((await readJson(req, 256 * 1024)).roster);
    db.tx(() => roster.forEach((r) => db.students.upsert(course.id, r.roll, r.name)));
    sendJson(res, 200, { added: roster.length });
  });

  router.add('POST', '/api/students/:id/reset-device', (req, res, { id }) => {
    requireLecturer(req);
    db.students.unbind(Number(id));
    sendJson(res, 200, { ok: true });
  });

  router.add('DELETE', '/api/courses/:id', (req, res, { id }) => {
    requireLecturer(req);
    db.courses.remove(getCourse(id).id);
    sendJson(res, 200, { ok: true });
  });

  router.add('POST', '/api/courses/:id/sessions', async (req, res, { id }) => {
    requireLecturer(req);
    const course = getCourse(id);
    const body = await readJson(req).catch(() => ({}));
    const mode = MODES.has(body.mode) ? body.mode : 'quiet';
    let s = db.sessions.live(course.id);
    if (!s) {
      const sid = crypto.randomBytes(9).toString('base64url');
      db.sessions.insert(sid, course.id, newSecret(), now(), mode);
      s = db.sessions.byId(sid);
    }
    sendJson(res, 201, { ...sessionView(s), secret: s.secret });
  });

  router.add('GET', '/api/sessions/:id', (req, res, { id }) => {
    requireLecturer(req);
    const s = getSession(id);
    sendJson(res, 200, { ...sessionView(s), secret: s.ended_at ? undefined : s.secret });
  });

  router.add('GET', '/api/sessions/:id/stream', (req, res, { id }) => {
    requireLecturer(req);
    getSession(id);
    hub.subscribe(id, res);
  });

  router.add('POST', '/api/sessions/:id/mode', async (req, res, { id }) => {
    requireLecturer(req);
    const s = getSession(id);
    const { mode } = await readJson(req);
    if (!MODES.has(mode)) throw new HttpError(400, 'bad_mode');
    db.sessions.setMode(s.id, mode);
    hub.publish(s.id, 'mode', { mode });
    sendJson(res, 200, { mode });
  });

  router.add('POST', '/api/sessions/:id/end', (req, res, { id }) => {
    requireLecturer(req);
    const s = getSession(id);
    db.sessions.end(s.id, now());
    listeners.delete(s.id);
    hub.publish(s.id, 'ended', { endedAt: now() });
    sendJson(res, 200, sessionView(db.sessions.byId(s.id)));
  });

  router.add('POST', '/api/sessions/:id/students/:sid', async (req, res, { id, sid }) => {
    requireLecturer(req);
    const s = getSession(id);
    const st = db.students.byId(Number(sid));
    if (!st || st.course_id !== s.course_id) throw new HttpError(404, 'no_student');
    const { action } = await readJson(req);
    const existing = db.checkins.get(s.id, st.id);
    if (action === 'present') {
      if (existing) db.checkins.setStatus(s.id, st.id, 'present');
      else db.checkins.insert({ sessionId: s.id, studentId: st.id, at: now(), status: 'present', method: 'manual', flags: [] });
    } else if (action === 'approve') {
      if (!existing) throw new HttpError(404, 'no_checkin');
      db.checkins.setStatus(s.id, st.id, 'present');
      // Approving a new phone makes it this student's phone from now on.
      if (existing.device_id) db.students.bind(st.id, existing.device_id, now());
    } else if (action === 'remove') {
      db.checkins.remove(s.id, st.id);
    } else {
      throw new HttpError(400, 'bad_action');
    }
    publishCheckin(s.id, st.id);
    sendJson(res, 200, { ok: true });
  });

  router.add('GET', '/api/sessions/:id/export.csv', (req, res, { id }) => {
    requireLecturer(req);
    const s = getSession(id);
    const view = sessionView(s);
    const byStudent = new Map(view.checkins.map((c) => [c.studentId, c]));
    const lines = [['Roll', 'Name', 'Status', 'Checked in at', 'Method', 'Notes'].map(csvCell).join(',')];
    for (const st of view.students) {
      const c = byStudent.get(st.id);
      const status = !c ? 'Absent' : c.status === 'present' ? 'Present' : 'Needs review';
      lines.push(
        [st.roll, st.name, status, c ? new Date(c.at).toISOString() : '', c?.method || '', (c?.flags || []).join('; ')].map(csvCell).join(','),
      );
    }
    const date = new Date(s.started_at).toISOString().slice(0, 10);
    res.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${view.course.code}-${date}.csv"`,
    });
    res.end(lines.join('\r\n') + '\r\n');
  });

  router.add('GET', '/api/courses/:id/export.csv', (req, res, { id }) => {
    requireLecturer(req);
    const course = getCourse(id);
    const sessions = db.sessions.forCourse(course.id).reverse();
    const students = db.students.forCourse(course.id);
    const marks = new Map();
    for (const m of db.checkins.matrix(course.id)) marks.set(`${m.session_id}:${m.student_id}`, m.status);
    const head = ['Roll', 'Name', ...sessions.map((s) => new Date(s.started_at).toISOString().slice(0, 16).replace('T', ' ')), 'Attended', 'Percent'];
    const lines = [head.map(csvCell).join(',')];
    for (const st of students) {
      const cells = sessions.map((s) => {
        const v = marks.get(`${s.id}:${st.id}`);
        return v === 'present' ? 'P' : v === 'pending' ? '?' : 'A';
      });
      const attended = cells.filter((c) => c === 'P').length;
      const pct = sessions.length ? Math.round((100 * attended) / sessions.length) : 0;
      lines.push([st.roll, st.name, ...cells, attended, pct + '%'].map(csvCell).join(','));
    }
    res.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${course.code}-attendance.csv"`,
    });
    res.end(lines.join('\r\n') + '\r\n');
  });

  // ---------- students ----------

  router.add('GET', '/api/time', (req, res) => sendJson(res, 200, { now: now() }));

  router.add('GET', '/api/join/:code', (req, res, { code }) => {
    const course = db.courses.byCode(code);
    if (!course) throw new HttpError(404, 'no_course');
    const live = db.sessions.live(course.id);
    const url = new URL(req.url, 'http://x');
    const deviceId = url.searchParams.get('device');
    let me = null;
    if (deviceId) {
      const st = db.students.byDevice(course.id, deviceId);
      if (st) me = { roll: st.roll, name: st.name };
    }
    let checkin = null;
    if (live && deviceId) {
      const k = db.checkins.byDevice(live.id, deviceId);
      if (k) {
        const st = db.students.byId(k.student_id);
        checkin = { status: k.status, at: k.at, roll: st.roll, name: st.name };
      }
    }
    sendJson(res, 200, {
      course: { code: course.code, title: course.title, openRoster: !!course.open_roster },
      session: live ? { id: live.id, startedAt: live.started_at, mode: live.mode } : null,
      me,
      checkin,
      now: now(),
    });
  });

  router.add('POST', '/api/join/:code/enrol', async (req, res, { code }) => {
    if (!limits.enrolIp.allow(clientIp(req))) throw new HttpError(429, 'rate_limited');
    const course = db.courses.byCode(code);
    if (!course) throw new HttpError(404, 'no_course');
    const { roll, name, publicKey, nonce, sig } = await readJson(req);
    if (!ROLL_RE.test(String(roll || ''))) throw new HttpError(400, 'bad_roll', 'That roll number does not look right.');
    const deviceId = thumbprint(publicKey);
    if (!deviceId || !verify(publicKey, enrolMessage(course.code, roll, String(nonce)), String(sig))) {
      throw new HttpError(400, 'bad_signature');
    }
    db.devices.save(deviceId, JSON.stringify(publicKey), now());

    let st = db.students.byRoll(course.id, roll);
    if (!st) {
      if (!course.open_roster) throw new HttpError(404, 'not_on_roster', 'That roll number is not on this class list.');
      const clean = String(name || '').trim().slice(0, 80);
      if (!clean) throw new HttpError(400, 'name_required', 'Add your name so your lecturer knows who you are.');
      db.students.upsert(course.id, roll, clean, 1);
      st = db.students.byRoll(course.id, roll);
    }

    // One phone, one person per course.
    const other = db.students.byDevice(course.id, deviceId);
    if (other && other.id !== st.id) {
      throw new HttpError(409, 'device_taken', `This phone is already set up for ${other.name} (${other.roll}).`);
    }

    let binding = 'yours';
    if (!st.device_id) db.students.bind(st.id, deviceId, now());
    else if (st.device_id !== deviceId) binding = 'other_device';
    sendJson(res, 200, { student: { roll: st.roll, name: st.name }, binding });
  });

  router.add('POST', '/api/join/:code/ping', async (req, res, { code }) => {
    const course = db.courses.byCode(code);
    if (!course) throw new HttpError(404, 'no_course');
    const live = db.sessions.live(course.id);
    const { device, state, level } = await readJson(req);
    if (live && typeof device === 'string' && device.length < 64 && ['listening', 'faint', 'silent'].includes(state)) {
      if (!listeners.has(live.id)) listeners.set(live.id, new Map());
      listeners.get(live.id).set(device, { state, level: Number(level) || 0, at: now() });
      hub.publish(live.id, 'listeners', listenerStats(live.id));
    }
    sendJson(res, 200, { live: !!live, sessionId: live?.id ?? null });
  });

  router.add('POST', '/api/checkin', async (req, res) => {
    const ip = clientIp(req);
    const body = await readJson(req);
    const { sessionId, roll, payload, band, nonce, sig, publicKey, meta } = body;
    const deviceId = thumbprint(publicKey);
    const t = now();
    const fail = (status, code, message) => {
      db.attempts.log(typeof sessionId === 'string' ? sessionId : null, deviceId, typeof roll === 'string' ? roll.slice(0, 32) : null, code, t);
      throw new HttpError(status, code, message);
    };

    if (!limits.checkinIp.allow(ip, t)) fail(429, 'rate_limited');
    if (!deviceId) fail(400, 'bad_device');
    if (!limits.checkinDevice.allow(deviceId, t)) fail(429, 'rate_limited');
    if (typeof payload !== 'string' || !/^[0-9a-f]{8}$/.test(payload)) fail(400, 'bad_payload');
    if (!verify(publicKey, checkinMessage(String(sessionId), String(roll), payload, String(nonce)), String(sig))) fail(400, 'bad_signature');

    const s = db.sessions.byId(String(sessionId));
    if (!s) fail(404, 'no_session');
    if (s.ended_at) fail(410, 'session_ended');

    const counter = parseInt(payload.slice(0, 2), 16);
    const tag = parseInt(payload.slice(2), 16);
    const check = verifyCode(s, counter, tag, t);
    if (!check.ok) fail(422, check.reason);

    const st = db.students.byRoll(s.course_id, String(roll));
    if (!st) fail(404, 'not_on_roster');

    const done = db.checkins.get(s.id, st.id);
    if (done) {
      return sendJson(res, 200, { status: done.status === 'present' ? 'already' : 'pending', at: done.at, student: { roll: st.roll, name: st.name } });
    }

    const usedBy = db.checkins.byDevice(s.id, deviceId);
    if (usedBy) {
      const other = db.students.byId(usedBy.student_id);
      fail(409, 'device_used', `This phone already checked in ${other.name} today.`);
    }

    const flags = [];
    let status = 'present';
    if (st.device_id && st.device_id !== deviceId) {
      status = 'pending';
      flags.push('New phone');
    }
    if (!st.device_id) db.students.bind(st.id, deviceId, t);
    if (s.mode === 'audible' || band === 'audible') flags.push('Audible mode');
    if (meta && Number(meta.combined) >= 3) flags.push('Weak signal');

    db.checkins.insert({ sessionId: s.id, studentId: st.id, deviceId, at: t, status, method: 'sound', band, flags });
    publishCheckin(s.id, st.id);
    sendJson(res, 200, { status, at: t, student: { roll: st.roll, name: st.name }, window: check.window });
  });

  // ---------- pages ----------

  function page(req, res, file) {
    serveFile(res, publicDir, file);
  }

  async function handle(req, res) {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;
    try {
      const m = router.match(req.method, pathname);
      if (m) return await m.handler(req, res, m.params);
      if (pathname.startsWith('/api/')) throw new HttpError(404, 'not_found');
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method');

      if (pathname === '/' || pathname === '/index.html') return page(req, res, 'lecturer.html');
      if (/^\/c\/[^/]+\/?$/.test(pathname)) return page(req, res, 'student.html');
      if (pathname === '/lab') return page(req, res, 'lab.html');
      if (pathname === '/states') return page(req, res, 'states.html');
      if (serveFile(res, publicDir, pathname)) return;
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found');
    } catch (e) {
      if (res.headersSent) return res.end();
      if (e instanceof HttpError) return sendJson(res, e.status, { error: e.code, message: e.message !== e.code ? e.message : undefined });
      console.error(e);
      sendJson(res, 500, { error: 'server_error' });
    }
  }

  return { handle, hub, windowAt };
}
