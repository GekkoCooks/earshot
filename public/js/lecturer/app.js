// Lecturer dashboard: classes, a class's history, the live register, and the
// end-of-session summary. Hash routes: #/, #/class/:id, #/session/:id

import { Transmitter } from './transmitter.js';
import { syncClock, serverNow } from '../lib/clock.js';
import { SYNC_SLOTS, WINDOW_MS, bankOf } from '../modem/protocol.js';
import { qrSvg } from '../lib/qr.js';

const $ = (s, r = document) => r.querySelector(s);
const app = $('#app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtTime = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });
const fmtDate = (t) => new Date(t).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const TICK = '<svg class="tick" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

// ---------- api ----------

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.error === 'lecturer_only') {
    views.login();
    throw new Error('login');
  }
  if (!res.ok) throw Object.assign(new Error(data.message || data.error || 'Request failed'), { data, status: res.status });
  return data;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2600);
}

function crumbs(items) {
  $('#crumbs').innerHTML = items
    .map((c, i) => (i === items.length - 1 ? `<span>${esc(c.label)}</span>` : `<a href="${c.href}">${esc(c.label)}</a><b class="sep" aria-hidden="true">/</b>`))
    .join('');
}

// ---------- theme ----------

const root = document.documentElement;
try {
  const saved = localStorage.getItem('earshot:theme');
  if (saved) root.dataset.theme = saved;
} catch {
  /* storage blocked */
}
$('#theme').addEventListener('click', () => {
  const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = dark ? 'light' : 'dark';
  try {
    localStorage.setItem('earshot:theme', root.dataset.theme);
  } catch {
    /* fine */
  }
});

// ---------- live session state ----------

const live = {
  id: null,
  view: null,
  tx: null,
  es: null,
  filter: 'all',
  query: '',
  fresh: new Set(),
  joinBase: null,
  volume: 0.8,
  lastCount: null,
};

function stopLive({ keepSound = false } = {}) {
  live.es?.close();
  live.es = null;
  clearInterval(live.animTimer);
  if (!keepSound) {
    live.tx?.stop();
    live.tx = null;
    live.wake?.release?.();
    live.wake = null;
  }
}

// A small trend line of recent attendance, one point per session.
function trend(rates) {
  if (rates.length < 2) return '<div class="trend"><span>Not enough sessions for a trend</span></div>';
  const w = 220;
  const h = 36;
  // Scale to the data so a drop from 90% to 70% is visible, with 100% at the top.
  const lo = Math.max(0, Math.min(0.5, Math.min(...rates) - 0.1));
  const y = (r) => h - ((r - lo) / (1 - lo)) * h;
  const pts = rates.map((r, i) => [(i / (rates.length - 1)) * w, y(r)]);
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join('');
  const avg = Math.round((100 * rates.reduce((a, b) => a + b, 0)) / rates.length);
  const [lx, ly] = pts.at(-1);
  return `<div class="trend" aria-label="Average attendance ${avg} percent">
    <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
      <line x1="0" x2="${w}" y1="${y(0.75)}" y2="${y(0.75)}" stroke="var(--rule-strong)" stroke-dasharray="2 3" vector-effect="non-scaling-stroke"/>
      <path d="${d}" fill="none" stroke="var(--ink)" stroke-width="1.6" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
      <circle cx="${lx}" cy="${ly}" r="3" fill="var(--blue)"/>
    </svg>
    <span>${avg}% average, last ${rates.length} sessions. Dashed line is 75%.</span></div>`;
}

// ---------- views ----------

const views = {
  login(error) {
    stopLive();
    crumbs([]);
    app.innerHTML = `
      <form class="login" id="login">
        <h1>Sign in</h1>
        <p>Open the lecturer link printed in the terminal when the server started, or paste the key from it.</p>
        <div class="field"><label for="key">Lecturer key</label>
          <input class="input" id="key" name="key" autocomplete="off" spellcheck="false" ${error ? 'aria-invalid="true"' : ''} /></div>
        ${error ? `<p class="form-error" role="alert">${esc(error)}</p>` : ''}
        <button class="btn btn-primary btn-lg" type="submit">Sign in</button>
      </form>`;
    $('#login').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('POST', '/api/login', { key: e.currentTarget.key.value.trim() });
        route();
      } catch (err) {
        if (err.message !== 'login') views.login("That key doesn't match.");
      }
    });
    $('#key').focus();
  },

  async classes() {
    stopLive();
    crumbs([{ label: 'Classes' }]);
    const { courses } = await api('GET', '/api/courses');
    const rows = courses
      .map(
        (c) => `
        <li class="class-row">
          <a class="class-main" href="#/class/${c.id}">
            <span class="code">${esc(c.code)}</span>
            <span class="title">${esc(c.title)}</span>
            <span class="meta">${
              c.live_session
                ? '<span class="live-tag"><span class="live-dot" aria-hidden="true"></span>Session running</span>'
                : `${plural(c.students, 'student')}, ${c.last_session ? `last session ${fmtDate(c.last_session)}` : 'no sessions yet'}`
            }</span>
          </a>
          ${trend(c.recent)}
          ${
            c.live_session
              ? `<a class="btn btn-blue" href="#/session/${c.live_session}">Open session</a>`
              : `<button class="btn btn-primary" data-act="start" data-id="${c.id}">Start session</button>`
          }
        </li>`,
      )
      .join('');
    app.innerHTML = `
      <div>
        <div class="page-head">
          <div><h1>Classes</h1><p>Start a session when you begin teaching. Students check in by listening for a few seconds.</p></div>
          <div class="actions"><button class="btn" data-act="new-class">New class</button></div>
        </div>
        ${
          courses.length
            ? `<ol class="class-list">${rows}</ol>`
            : `<div class="empty"><h2>Add your first class</h2>
               <p>Give it a code, a name and the class list. Students use the code to find it, like /c/CS201.</p>
               <button class="btn btn-primary" data-act="new-class">New class</button></div>`
        }
      </div>`;
  },

  async course(id) {
    stopLive();
    const { course, students, sessions } = await api('GET', `/api/courses/${id}`);
    crumbs([{ label: 'Classes', href: '#/' }, { label: course.code }]);
    const liveS = sessions.find((s) => !s.ended_at);
    const total = students.length;
    app.innerHTML = `
      <div>
        <div class="page-head">
          <div><h1>${esc(course.code)}</h1>
            <p>${esc(course.title)}. ${plural(total, 'student')}, ${plural(sessions.length, 'session')}. Students join at <b>/c/${esc(course.code)}</b>.</p></div>
          <div class="actions">
            <a class="btn" href="/api/courses/${course.id}/export.csv" download>Export attendance</a>
            ${
              liveS
                ? `<a class="btn btn-blue" href="#/session/${liveS.id}">Open session</a>`
                : `<button class="btn btn-primary" data-act="start" data-id="${course.id}">Start session</button>`
            }
          </div>
        </div>
        <div class="two">
          <section class="block">
            <h2>Sessions</h2>
            ${
              sessions.length
                ? `<ol class="rows">${sessions
                    .map(
                      (s) => `<li>
                        <span class="date"><b>${fmtDate(s.started_at)}</b><span>${fmtTime(s.started_at)}</span></span>
                        <span class="att"><span class="track"><i style="width:${pct(s.present, total)}%"></i></span>
                          <span>${s.present} of ${total} present${s.pending ? `, ${s.pending} to review` : ''}</span></span>
                        <a class="btn ${s.ended_at ? '' : 'btn-blue'}" href="#/session/${s.id}">${s.ended_at ? 'View' : 'Open'}</a></li>`,
                    )
                    .join('')}</ol>`
                : '<p class="muted" style="padding-top:16px">No sessions yet.</p>'
            }
          </section>
          <section class="block">
            <h2>Class list <button class="btn btn-quiet" data-act="add-students" data-id="${course.id}">Add students</button></h2>
            ${
              students.length
                ? `<ol class="rows roster">${students
                    .map(
                      (st) => `<li><span class="roll">${esc(st.roll)}</span><span>${esc(st.name)}${st.self_added ? ' <span class="tag">Self-added</span>' : ''}</span>
                      <span class="phone">${
                        st.device_id
                          ? `Phone linked <button class="btn btn-quiet" data-act="reset-device" data-id="${st.id}" data-name="${esc(st.name)}">Unlink</button>`
                          : 'No phone yet'
                      }</span></li>`,
                    )
                    .join('')}</ol>`
                : `<p class="muted" style="padding-top:16px">${course.open_roster ? 'Open class list: students add themselves when they first check in.' : 'No students yet.'}</p>`
            }
          </section>
        </div>
      </div>`;
  },

  async session(id) {
    stopLive({ keepSound: live.id === id });
    if (live.id !== id) {
      live.tx?.stop();
      live.tx = null;
      live.lastCount = null;
    }
    live.id = id;
    const data = await api('GET', `/api/sessions/${id}`);
    live.view = data;
    if (data.session.endedAt) return views.summary(data);
    if (!live.joinBase) live.joinBase = (await api('GET', '/api/info')).joinBase;
    crumbs([{ label: 'Classes', href: '#/' }, { label: data.course.code, href: `#/class/${data.course.id}` }, { label: 'Live session' }]);
    renderLive();
    connectStream(id);
    startNowPlaying();
  },

  summary(data) {
    stopLive();
    live.id = null;
    crumbs([{ label: 'Classes', href: '#/' }, { label: data.course.code, href: `#/class/${data.course.id}` }, { label: fmtDate(data.session.startedAt) }]);
    const by = new Map(data.checkins.map((c) => [c.studentId, c]));
    const present = data.checkins.filter((c) => c.status === 'present').length;
    const pending = data.checkins.filter((c) => c.status === 'pending');
    const absent = data.students.filter((s) => !by.has(s.id));
    const total = data.students.length;
    const mins = Math.max(1, Math.round((data.session.endedAt - data.session.startedAt) / 60000));
    app.innerHTML = `
      <div>
        <div class="page-head">
          <div><h1>${esc(data.course.code)}, ${fmtDate(data.session.startedAt)}</h1>
            <p>${fmtTime(data.session.startedAt)} to ${fmtTime(data.session.endedAt)}, ${plural(mins, 'minute')}. Attendance is closed.</p></div>
          <div class="actions"><a class="btn btn-primary" href="/api/sessions/${data.session.id}/export.csv" download>Download CSV</a></div>
        </div>
        <div class="summary-count">
          <div class="count"><b>${present}</b><span>of <strong>${total}</strong><br />present</span></div>
          <div class="bar"><i style="width:${pct(present, total)}%"></i></div>
        </div>
        <div class="summary-grid">
          <section class="block"><h2>Not checked in <span class="muted">${absent.length}</span></h2>
            ${
              absent.length
                ? `<ol class="rows absent-list">${absent
                    .map(
                      (s) =>
                        `<li><span class="roll"><b>${esc(s.roll)}</b></span><span>${esc(s.name)}</span><button class="btn btn-quiet" data-act="mark" data-sid="${s.id}" data-action="present">Mark present</button></li>`,
                    )
                    .join('')}</ol>`
                : '<p class="muted" style="padding-top:16px">Everyone on the list checked in.</p>'
            }
          </section>
          <section class="block"><h2>Needs review <span class="muted">${pending.length}</span></h2>
            ${
              pending.length
                ? `<ol class="rows absent-list">${pending
                    .map(
                      (c) => `<li><span class="roll"><b>${esc(c.roll)}</b></span><span>${esc(c.name)} <span class="tag tag-hl">${esc(c.flags.join(', '))}</span></span>
                      <button class="btn" data-act="mark" data-sid="${c.studentId}" data-action="approve">Approve</button></li>`,
                    )
                    .join('')}</ol>`
                : '<p class="muted" style="padding-top:16px">Nothing to review.</p>'
            }
          </section>
        </div>
      </div>`;
  },
};

// ---------- live session ----------

function renderLive() {
  const d = live.view;
  const mode = d.session.mode;
  const url = `${live.joinBase}/c/${d.course.code}`;
  const host = url.replace(/^https?:\/\//, '').replace(/\/c\/.*$/, '');
  const sound = live.tx && live.tx.state === 'running';
  const txSlots = Array.from({ length: 16 }, (_, i) => `<span class="${i < SYNC_SLOTS ? 'sync' : ''}"><i></i></span>`).join('');

  app.innerHTML = `
    <div>
      ${
        sound
          ? ''
          : `<div class="resume" role="status"><span>Sound is off. Browsers need a click before a page can play audio.</span>
             <button class="btn" data-act="sound">Play the code</button></div>`
      }
      <section class="band" aria-label="Session">
        <div>
          <div class="count" aria-live="polite"><b id="countNum">0</b><span>of <strong id="countTotal">0</strong><br />present</span></div>
          <div class="bar" aria-hidden="true"><i id="barPresent"></i><i class="pending" id="barPending"></i></div>
          <div class="count-foot" id="countFoot"></div>
        </div>
        <div>
          <div class="tx-head">
            <span class="onair ${sound ? '' : 'paused'}"><span class="live-dot" aria-hidden="true"></span>${sound ? (mode === 'quiet' ? 'Playing quietly' : 'Playing audibly') : 'Not playing'}</span>
            <span class="next-code" id="nextCode"></span>
          </div>
          <div class="tx ${sound ? '' : 'paused'}" id="tx" aria-hidden="true">${txSlots}</div>
          <p class="tx-caption">The code this laptop is playing, symbol by symbol. The first four are the sync pattern.</p>
          <div id="phones"></div>
        </div>
        <div class="join">
          <button class="qr" data-act="qr" data-url="${esc(url)}" aria-label="Show the join QR code large">${qrSvg(url)}</button>
          <div>
            <p class="join-url"><span class="host">${esc(host)}</span><br />/c/${esc(d.course.code)}</p>
            <div class="join-actions"><button class="btn" data-act="copy" data-url="${esc(url)}">Copy</button>
            <button class="btn btn-quiet" data-act="qr" data-url="${esc(url)}">Show large</button></div>
          </div>
        </div>
      </section>
      <section class="controls" aria-label="Sound">
        <div class="mode">
          <div class="seg" role="group" aria-label="Sound mode">
            <button data-act="mode" data-mode="quiet" aria-pressed="${mode === 'quiet'}">Quiet</button>
            <button data-act="mode" data-mode="audible" aria-pressed="${mode === 'audible'}">Audible</button>
          </div>
          <p class="mode-note ${mode === 'audible' ? 'warn' : ''}">${
            mode === 'quiet'
              ? 'Near-ultrasonic, 18 to 20 kHz. Most people will not notice it, and phone calls cannot carry it.'
              : 'Audible chirps, 2.4 to 4.4 kHz. Reaches further, but can be relayed over a call, so these check-ins are marked.'
          }</p>
        </div>
        <label class="volume"><span>Volume</span><input type="range" id="vol" min="0.1" max="1" step="0.05" value="${live.volume}" /></label>
        <button class="btn btn-danger end" data-act="end">End session</button>
      </section>
      <section aria-label="Register">
        <div class="reg-head">
          <div class="filters" role="group" aria-label="Filter the register" id="filters"></div>
          <input class="input find" id="find" type="search" placeholder="Find a roll or name" value="${esc(live.query)}" aria-label="Find a student" />
        </div>
        <ul class="register" id="register"></ul>
      </section>
    </div>`;

  $('#vol').addEventListener('input', (e) => {
    live.volume = Number(e.target.value);
    live.tx?.setVolume(live.volume);
  });
  $('#find').addEventListener('input', (e) => {
    live.query = e.target.value.trim().toLowerCase();
    renderRegister();
  });
  live.lastCount = null;
  renderPhones();
  renderRegister();
}

function renderPhones() {
  const el = $('#phones');
  if (!el) return;
  const l = live.view.listeners || { listening: 0, faint: 0, silent: 0 };
  const total = l.listening + l.faint + l.silent;
  const struggling = l.silent + l.faint;
  let hint = '';
  if (total >= 3 && struggling / total >= 0.4) {
    hint =
      live.view.session.mode === 'quiet'
        ? '<p class="hint-box">Several phones can barely hear the code. Turn the laptop volume up, or switch to Audible for a minute.</p>'
        : '<p class="hint-box">Several phones can barely hear the code. Turn the volume up or connect the laptop to the room speakers.</p>';
  }
  el.innerHTML = `<div class="phones"><span><b>${l.listening}</b>phones hearing you</span><span><b>${l.faint}</b>faint</span><span><b>${l.silent}</b>hearing nothing</span></div>${hint}`;
}

function updateCount(present, pending, total) {
  const num = $('#countNum');
  if (!num) return;
  if (live.lastCount !== present) {
    num.textContent = present;
    if (live.lastCount !== null && !reduceMotion) {
      num.animate([{ transform: 'translateY(0.25em)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 380, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
    }
    live.lastCount = present;
  }
  $('#countTotal').textContent = total;
  $('#barPresent').style.width = `${pct(present, total)}%`;
  $('#barPending').style.left = `${pct(present, total)}%`;
  $('#barPending').style.width = `${pct(pending, total)}%`;
  $('#countFoot').innerHTML = `<span><b>${pct(present, total)}%</b> of the class</span><span><b>${total - present - pending}</b> not yet</span>${
    pending ? `<span><b>${pending}</b> to review</span>` : ''
  }`;
}

function renderRegister() {
  const el = $('#register');
  if (!el) return;
  const d = live.view;
  const by = new Map(d.checkins.map((c) => [c.studentId, c]));
  const present = d.checkins.filter((c) => c.status === 'present').length;
  const pending = d.checkins.filter((c) => c.status === 'pending').length;
  const total = d.students.length;
  updateCount(present, pending, total);

  const f = live.filter;
  $('#filters').innerHTML = [
    ['all', `Everyone ${total}`],
    ['waiting', `Not yet ${total - present - pending}`],
    ['present', `Present ${present}`],
    ['review', `Needs review ${pending}`],
  ]
    .map(([k, label]) => `<button data-act="filter" data-filter="${k}" aria-pressed="${f === k}">${label}</button>`)
    .join('');

  const q = live.query;
  const list = d.students.filter((s) => {
    const c = by.get(s.id);
    if (q && !s.roll.toLowerCase().includes(q) && !s.name.toLowerCase().includes(q)) return false;
    if (f === 'present') return c?.status === 'present';
    if (f === 'waiting') return !c;
    if (f === 'review') return c?.status === 'pending';
    return true;
  });

  if (total === 0) {
    el.outerHTML = `<div class="empty" id="register"><h2>No one on the list yet</h2><p>This class has an open list. Students appear here as they check in.</p></div>`;
    return;
  }
  el.innerHTML = list
    .map((s) => {
      const c = by.get(s.id);
      const cls = c ? c.status : '';
      const when = !c
        ? 'Not yet'
        : c.status === 'pending'
          ? c.flags.join(', ') || 'Needs review'
          : `${fmtTime(c.at)}${c.method === 'manual' ? ', by you' : c.flags.includes('Audible mode') ? ', audible' : ''}`;
      return `<li><button class="cell ${cls} ${live.fresh.has(s.id) ? 'fresh' : ''}" data-act="cell" data-sid="${s.id}"
        aria-label="${esc(s.roll)} ${esc(s.name)}: ${esc(when)}">
        ${TICK}<span class="roll">${esc(s.roll)}</span><span class="who">${esc(s.name)}</span><span class="when">${esc(when)}</span></button></li>`;
    })
    .join('');
  if (!list.length) el.innerHTML = '<li style="grid-column:1/-1;padding:24px 16px" class="muted">No one matches.</li>';
  live.fresh.clear();
}

function connectStream(id) {
  live.es?.close();
  const es = new EventSource(`/api/sessions/${id}/stream`);
  live.es = es;
  es.addEventListener('checkin', (e) => {
    const c = JSON.parse(e.data);
    const list = live.view.checkins.filter((x) => x.studentId !== c.studentId);
    if (!c.removed) {
      list.push(c);
      if (!live.view.students.some((s) => s.id === c.studentId)) {
        live.view.students.push({ id: c.studentId, roll: c.roll, name: c.name });
        live.view.students.sort((a, b) => a.roll.localeCompare(b.roll));
      }
      if (c.status === 'present') live.fresh.add(c.studentId);
    }
    live.view.checkins = list;
    renderRegister();
  });
  es.addEventListener('listeners', (e) => {
    live.view.listeners = JSON.parse(e.data);
    renderPhones();
  });
  es.addEventListener('mode', (e) => {
    const { mode } = JSON.parse(e.data);
    if (mode !== live.view.session.mode) {
      live.view.session.mode = mode;
      live.tx?.setMode(mode);
      renderLive();
    }
  });
  es.addEventListener('ended', () => route());
}

// Keep the code strip in step with what the speakers are playing.
function startNowPlaying() {
  clearInterval(live.animTimer);
  live.animTimer = setInterval(async () => {
    const next = $('#nextCode');
    if (next) {
      const left = Math.ceil((WINDOW_MS - ((serverNow() - live.view.session.startedAt) % WINDOW_MS)) / 1000);
      next.textContent = `New code in ${left} s`;
    }
    const tx = $('#tx');
    if (!tx || !live.tx) return;
    const np = await live.tx.nowPlaying();
    if (!np) return;
    const spans = tx.children;
    for (let i = 0; i < 16; i++) {
      spans[i].style.setProperty('--v', String((np.tones[i] * 2 + bankOf(i) + 0.5) / 32));
      spans[i].classList.toggle('now', i === np.slot);
      spans[i].classList.toggle('played', i < np.slot && i >= SYNC_SLOTS);
    }
  }, 50);
}

async function startSound() {
  const d = live.view;
  if (live.tx) live.tx.stop();
  live.tx = new Transmitter({ sessionId: d.session.id, secretHex: d.secret, startedAt: d.session.startedAt, mode: d.session.mode, volume: live.volume });
  const ready = live.tx.start();
  try {
    live.wake = await navigator.wakeLock?.request('screen');
  } catch {
    /* not supported or denied; fine */
  }
  await syncClock();
  await ready;
  if (live.id === d.session.id && !d.session.endedAt) renderLive();
}

// ---------- register cell menu ----------

function closeMenu() {
  document.querySelector('.menu')?.remove();
}

function openMenu(btn) {
  closeMenu();
  const sid = Number(btn.dataset.sid);
  const st = live.view.students.find((s) => s.id === sid);
  const c = live.view.checkins.find((x) => x.studentId === sid);
  const items = !c
    ? [['present', 'Mark present']]
    : c.status === 'pending'
      ? [
          ['approve', 'Approve this phone'],
          ['remove', 'Remove check-in', 'danger'],
        ]
      : [['remove', 'Remove check-in', 'danger']];
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = `<p>${esc(st.roll)} ${esc(st.name)}</p>${items
    .map(([a, label, cls]) => `<button role="menuitem" class="${cls || ''}" data-act="mark" data-sid="${sid}" data-action="${a}">${label}</button>`)
    .join('')}`;
  document.body.append(menu);
  const r = btn.getBoundingClientRect();
  const left = Math.min(r.left, window.innerWidth - menu.offsetWidth - 12);
  const top = r.bottom + 6 + menu.offsetHeight > window.innerHeight ? r.top - menu.offsetHeight - 6 : r.bottom + 6;
  menu.style.left = `${Math.max(12, left)}px`;
  menu.style.top = `${top}px`;
  menu.querySelector('button').focus();
}

// ---------- dialogs ----------

function dialog(html, onSubmit) {
  const dlg = document.createElement('dialog');
  dlg.innerHTML = html;
  document.body.append(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  dlg.querySelector('[data-close]')?.addEventListener('click', () => dlg.close());
  dlg.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = dlg.querySelector('.form-error');
    err.textContent = '';
    try {
      await onSubmit(new FormData(e.currentTarget), dlg);
      dlg.close();
    } catch (ex) {
      if (ex.message !== 'login') err.textContent = ex.message;
    }
  });
  dlg.showModal();
}

const rosterHint = 'One student per line: roll number, then name. You can paste straight from a spreadsheet.';

function newClassDialog() {
  dialog(
    `<form class="dlg" method="dialog">
      <h2>New class</h2>
      <div class="row">
        <div class="field"><label for="code">Code</label><input class="input" id="code" name="code" required maxlength="16" placeholder="CS201" autocapitalize="characters" /></div>
        <div class="field"><label for="title">Name</label><input class="input" id="title" name="title" required maxlength="120" placeholder="Data Structures" /></div>
      </div>
      <div class="field"><label for="roster">Class list</label>
        <textarea class="input" id="roster" name="roster" placeholder="21CS001, Asha Rao&#10;21CS002, Vikram Iyer"></textarea>
        <p class="hint">${rosterHint} Leave it empty to let students add themselves.</p></div>
      <p class="form-error" role="alert"></p>
      <div class="dlg-actions"><button class="btn btn-quiet" type="button" data-close>Cancel</button><button class="btn btn-primary" type="submit">Create class</button></div>
    </form>`,
    async (fd) => {
      await api('POST', '/api/courses', { code: fd.get('code'), title: fd.get('title'), roster: fd.get('roster') });
      toast('Class created');
      route();
    },
  );
}

function addStudentsDialog(id) {
  dialog(
    `<form class="dlg" method="dialog">
      <h2>Add students</h2>
      <div class="field"><label for="roster">Students</label><textarea class="input" id="roster" name="roster" required></textarea>
        <p class="hint">${rosterHint} Existing roll numbers get their names updated.</p></div>
      <p class="form-error" role="alert"></p>
      <div class="dlg-actions"><button class="btn btn-quiet" type="button" data-close>Cancel</button><button class="btn btn-primary" type="submit">Add students</button></div>
    </form>`,
    async (fd) => {
      const r = await api('POST', `/api/courses/${id}/students`, { roster: fd.get('roster') });
      toast(`${plural(r.added, 'student')} added`);
      route();
    },
  );
}

function confirmEnd() {
  const d = live.view;
  const present = d.checkins.filter((c) => c.status === 'present').length;
  dialog(
    `<form class="dlg" method="dialog">
      <h2>End this session?</h2>
      <p class="muted">${present} of ${d.students.length} checked in. Everyone else is marked absent, and the sound stops.</p>
      <p class="form-error" role="alert"></p>
      <div class="dlg-actions"><button class="btn btn-quiet" type="button" data-close>Keep going</button><button class="btn btn-primary" type="submit">End session</button></div>
    </form>`,
    async () => {
      await api('POST', `/api/sessions/${d.session.id}/end`);
      live.tx?.stop();
      live.tx = null;
      toast('Session ended');
      route();
    },
  );
}

function qrDialog(url) {
  const dlg = document.createElement('dialog');
  dlg.className = 'qr-big';
  dlg.innerHTML = `<div class="qr-big-inner">${qrSvg(url)}<p class="join-url">${esc(url.replace(/^https?:\/\//, ''))}</p>
    <button class="btn" data-close>Close</button></div>`;
  document.body.append(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  dlg.addEventListener('click', (ev) => (ev.target === dlg || ev.target.closest('[data-close]')) && dlg.close());
  dlg.showModal();
}

// ---------- events ----------

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) {
    if (!e.target.closest('.menu')) closeMenu();
    return;
  }
  const act = el.dataset.act;
  try {
    if (act === 'start') {
      el.disabled = true;
      const data = await api('POST', `/api/courses/${el.dataset.id}/sessions`, {});
      live.id = data.session.id;
      live.view = data;
      // The click is our one chance to start audio without asking again.
      live.joinBase = live.joinBase || (await api('GET', '/api/info')).joinBase;
      startSound();
      location.hash = `#/session/${data.session.id}`;
    } else if (act === 'sound') {
      startSound();
    } else if (act === 'mode') {
      const mode = el.dataset.mode;
      await api('POST', `/api/sessions/${live.view.session.id}/mode`, { mode });
      live.view.session.mode = mode;
      live.tx?.setMode(mode);
      renderLive();
    } else if (act === 'copy') {
      await navigator.clipboard?.writeText(el.dataset.url);
      toast('Link copied');
    } else if (act === 'qr') {
      qrDialog(el.dataset.url);
    } else if (act === 'end') {
      confirmEnd();
    } else if (act === 'filter') {
      live.filter = el.dataset.filter;
      renderRegister();
    } else if (act === 'cell') {
      openMenu(el);
    } else if (act === 'mark') {
      closeMenu();
      const sessionId = live.view.session.id;
      await api('POST', `/api/sessions/${sessionId}/students/${el.dataset.sid}`, { action: el.dataset.action });
      if (live.view.session.endedAt) views.session(sessionId);
    } else if (act === 'new-class') {
      newClassDialog();
    } else if (act === 'add-students') {
      addStudentsDialog(el.dataset.id);
    } else if (act === 'reset-device') {
      await api('POST', `/api/students/${el.dataset.id}/reset-device`);
      toast(`${el.dataset.name} can link a new phone`);
      route();
    }
  } catch (err) {
    if (err.message !== 'login') toast(err.message);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMenu();
});

window.addEventListener('beforeunload', (e) => {
  if (live.tx && live.view && !live.view.session.endedAt) e.preventDefault();
});

// ---------- routing ----------

async function route() {
  closeMenu();
  const hash = location.hash || '#/';
  try {
    let m;
    if ((m = hash.match(/^#\/session\/([\w-]+)/))) return await views.session(m[1]);
    if ((m = hash.match(/^#\/class\/(\d+)/))) return await views.course(m[1]);
    return await views.classes();
  } catch (err) {
    if (err.message === 'login') return;
    if (err.status === 404) {
      location.hash = '#/';
      return;
    }
    app.innerHTML = `<div class="empty"><h2>Couldn't load this page</h2><p>${esc(err.message)}. Check the server is running, then reload.</p></div>`;
  }
}

async function boot() {
  const params = new URLSearchParams(location.search);
  const key = params.get('key');
  if (key) {
    await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key }) });
    history.replaceState(null, '', location.pathname + location.hash);
  }
  const me = await fetch('/api/me').then((r) => r.json());
  if (!me.lecturer) return views.login();
  syncClock();
  window.addEventListener('hashchange', route);
  route();
}

boot();
