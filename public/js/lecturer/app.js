// Lecturer dashboard: classes, a class's history, the live register, and the
// end-of-session summary. Hash routes: #/, #/class/:id, #/session/:id

import { Transmitter } from './transmitter.js';
import { syncClock } from '../lib/clock.js';
import { SYNC_SLOTS } from '../modem/protocol.js';
import { qrSvg } from '../lib/qr.js';

const $ = (s, r = document) => r.querySelector(s);
const app = $('#app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtTime = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });
const fmtDate = (t) => new Date(t).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

const TICK = '<svg class="tick" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

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
  fresh: new Set(),
  anim: null,
  joinBase: null,
  volume: 0.8,
};

function stopLive({ keepSound = false } = {}) {
  live.es?.close();
  live.es = null;
  cancelAnimationFrame(live.anim);
  clearInterval(live.animTimer);
  if (!keepSound) {
    live.tx?.stop();
    live.tx = null;
    live.wake?.release?.();
    live.wake = null;
  }
}

// ---------- views ----------

const views = {
  login(error) {
    stopLive();
    crumbs([]);
    app.innerHTML = `
      <form class="login" id="login">
        <h1>Lecturer sign in</h1>
        <p>Open the lecturer link printed in the terminal when the server started, or paste the key from it here.</p>
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
        <div class="class-row ${c.live_session ? 'live' : ''}">
          <div>
            <a class="name" href="#/class/${c.id}"><span class="code">${esc(c.code)}</span><span class="title">${esc(c.title)}</span></a>
            <p class="meta">${c.live_session ? '<span class="live-dot" aria-hidden="true"></span> Session running. ' : ''}${plural(c.students, 'student')}, ${
              c.last_session ? `last session ${fmtDate(c.last_session)}` : 'no sessions yet'
            }</p>
          </div>
          ${
            c.live_session
              ? `<a class="btn btn-primary" href="#/session/${c.live_session}">Open session</a>`
              : `<button class="btn btn-ink" data-act="start" data-id="${c.id}">Start session</button>`
          }
        </div>`,
      )
      .join('');
    app.innerHTML = `
      <div class="page-head">
        <div><h1>Classes</h1><p>Start a session when you begin teaching. Students check in by listening.</p></div>
        <button class="btn" data-act="new-class">New class</button>
      </div>
      ${
        courses.length
          ? `<div class="classes">${rows}</div>`
          : `<div class="empty"><h2>Add your first class</h2>
             <p>Give it a code, a name and the class list. Students use the code to find it, like /c/CS201.</p>
             <button class="btn btn-primary" data-act="new-class">New class</button></div>`
      }`;
  },

  async course(id) {
    stopLive();
    const { course, students, sessions } = await api('GET', `/api/courses/${id}`);
    crumbs([{ label: 'Classes', href: '#/' }, { label: `${course.code} ${course.title}` }]);
    const liveS = sessions.find((s) => !s.ended_at);
    app.innerHTML = `
      <div class="page-head">
        <div><h1>${esc(course.code)} ${esc(course.title)}</h1>
          <p>${plural(students.length, 'student')}, ${plural(sessions.length, 'session')}. Students join at <b>/c/${esc(course.code)}</b>.</p></div>
        <div class="join-actions">
          <a class="btn" href="/api/courses/${course.id}/export.csv" download>Export attendance</a>
          ${
            liveS
              ? `<a class="btn btn-primary" href="#/session/${liveS.id}">Open session</a>`
              : `<button class="btn btn-primary" data-act="start" data-id="${course.id}">Start session</button>`
          }
        </div>
      </div>
      <div class="two">
        <section class="block">
          <h2>Sessions</h2>
          ${
            sessions.length
              ? `<table class="table"><thead><tr><th>Date</th><th>Time</th><th>Present</th><th></th></tr></thead><tbody>
                ${sessions
                  .map(
                    (s) => `<tr><td>${fmtDate(s.started_at)}</td><td class="n">${fmtTime(s.started_at)}${s.ended_at ? '' : ' <span class="tag tag-blue">Live</span>'}</td>
                    <td class="n">${s.present} of ${students.length}${s.pending ? ` <span class="tag tag-hl">${s.pending} to review</span>` : ''}</td>
                    <td style="text-align:right"><a class="btn" href="#/session/${s.id}">${s.ended_at ? 'View' : 'Open'}</a></td></tr>`,
                  )
                  .join('')}</tbody></table>`
              : '<p class="muted">No sessions yet.</p>'
          }
        </section>
        <section class="block">
          <h2>Class list <button class="btn btn-quiet" data-act="add-students" data-id="${course.id}">Add students</button></h2>
          ${
            students.length
              ? `<table class="table"><thead><tr><th>Roll</th><th>Name</th><th>Phone</th></tr></thead><tbody>
                ${students
                  .map(
                    (st) => `<tr><td class="n"><b>${esc(st.roll)}</b></td><td>${esc(st.name)}${st.self_added ? ' <span class="tag">Self-added</span>' : ''}</td>
                    <td>${st.device_id ? `Linked <button class="btn btn-quiet" data-act="reset-device" data-id="${st.id}" data-name="${esc(st.name)}">Unlink</button>` : '<span class="muted">Not yet</span>'}</td></tr>`,
                  )
                  .join('')}</tbody></table>`
              : `<p class="muted">${course.open_roster ? 'Open class list: students add themselves when they first check in.' : 'No students yet.'}</p>`
          }
        </section>
      </div>`;
  },

  async session(id) {
    stopLive({ keepSound: live.id === id });
    if (live.id !== id) {
      live.tx?.stop();
      live.tx = null;
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
    const mins = Math.round((data.session.endedAt - data.session.startedAt) / 60000);
    app.innerHTML = `
      <div class="page-head">
        <div><h1>${esc(data.course.code)} on ${fmtDate(data.session.startedAt)}</h1>
          <p>${fmtTime(data.session.startedAt)} to ${fmtTime(data.session.endedAt)}, ${plural(mins, 'minute')}.</p></div>
        <div class="join-actions"><a class="btn btn-primary" href="/api/sessions/${data.session.id}/export.csv" download>Download CSV</a></div>
      </div>
      <div class="register-head"><div class="count"><b>${present}</b><span>of ${data.students.length} present</span></div></div>
      <div class="bar"><i style="width:${data.students.length ? (100 * present) / data.students.length : 0}%"></i></div>
      <div class="summary-grid">
        <section class="block"><h2>Not checked in <span class="muted">${absent.length}</span></h2>
          ${
            absent.length
              ? `<ul class="absent-list">${absent
                  .map((s) => `<li><span><span class="roll">${esc(s.roll)}</span>${esc(s.name)}</span><button class="btn btn-quiet" data-act="mark" data-sid="${s.id}" data-action="present">Mark present</button></li>`)
                  .join('')}</ul>`
              : '<p class="muted">Everyone on the list checked in.</p>'
          }
        </section>
        <section class="block"><h2>Needs review <span class="muted">${pending.length}</span></h2>
          ${
            pending.length
              ? `<ul class="absent-list">${pending
                  .map(
                    (c) => `<li><span><span class="roll">${esc(c.roll)}</span>${esc(c.name)} <span class="tag tag-hl">${esc(c.flags.join(', '))}</span></span>
                    <span><button class="btn btn-quiet" data-act="mark" data-sid="${c.studentId}" data-action="approve">Approve</button></span></li>`,
                  )
                  .join('')}</ul>`
              : '<p class="muted">Nothing to review.</p>'
          }
        </section>
      </div>`;
  },
};

// ---------- live session rendering ----------

function renderLive() {
  const d = live.view;
  const mode = d.session.mode;
  const url = `${live.joinBase}/c/${d.course.code}`;
  const host = url.replace(/^https?:\/\//, '').replace(/\/c\/.*$/, '');
  const sound = live.tx && live.tx.state === 'running';
  const txSlots = Array.from({ length: 16 }, (_, i) => `<span class="${i < SYNC_SLOTS ? 'sync' : ''}"><i></i></span>`).join('');

  app.innerHTML = `
    <div class="live">
      <aside class="panel" aria-label="Session controls">
        <section>
          ${
            sound
              ? ''
              : `<div class="resume"><p><b>Sound is off.</b> Browsers need a click before a page can play audio.</p>
                 <button class="btn btn-primary" data-act="sound">Play sound</button></div>`
          }
          <p class="onair ${sound ? '' : 'paused'}" id="onair"><span class="live-dot" aria-hidden="true"></span>${sound ? 'Playing the check-in code' : 'Waiting to play'}</p>
          <div class="tx" id="tx" aria-hidden="true">${txSlots}</div>
          <p class="tx-caption" id="txCaption">The code changes every 8 seconds.</p>
        </section>
        <section>
          <h2>Sound</h2>
          <div class="seg" role="group" aria-label="Sound mode">
            <button data-act="mode" data-mode="quiet" aria-pressed="${mode === 'quiet'}">Quiet</button>
            <button data-act="mode" data-mode="audible" aria-pressed="${mode === 'audible'}">Audible</button>
          </div>
          <p class="mode-note ${mode === 'audible' ? 'warn' : ''}" id="modeNote">${
            mode === 'quiet'
              ? 'Near-ultrasonic, 18 to 20 kHz. Most people will not notice it, and phone calls cannot carry it.'
              : 'Audible chirps, 2.4 to 4.4 kHz. Reaches further, but it can be relayed over a phone call, so check-ins are marked.'
          }</p>
          <label class="volume"><span>Volume</span><input type="range" id="vol" min="0.1" max="1" step="0.05" value="${live.volume}" /></label>
        </section>
        <section>
          <h2>Students open</h2>
          <div class="join">
            <button class="qr" data-act="qr" data-url="${esc(url)}" aria-label="Show the QR code large">${qrSvg(url)}</button>
            <div>
              <p class="join-url"><span class="host">${esc(host)}</span>/c/${esc(d.course.code)}</p>
              <div class="join-actions"><button class="btn" data-act="copy" data-url="${esc(url)}">Copy link</button>
              <button class="btn btn-quiet" data-act="qr" data-url="${esc(url)}">Show large</button></div>
            </div>
          </div>
          <p class="mode-note">Sharing this link is fine. It only opens the page; the phone still has to hear the room.</p>
        </section>
        <section>
          <h2>Phones listening now</h2>
          <div id="phones"></div>
        </section>
        <section>
          <button class="btn btn-block btn-danger" data-act="end">End session</button>
        </section>
      </aside>
      <section aria-label="Register">
        <div id="register"></div>
      </section>
    </div>`;

  $('#vol').addEventListener('input', (e) => {
    live.volume = Number(e.target.value);
    live.tx?.setVolume(live.volume);
  });
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
  el.innerHTML = `<div class="phones">
      <div><b>${l.listening}</b><span>hearing you</span></div>
      <div><b>${l.faint}</b><span>faint</span></div>
      <div><b>${l.silent}</b><span>hearing nothing</span></div>
    </div>${hint}`;
}

function renderRegister() {
  const el = $('#register');
  if (!el) return;
  const d = live.view;
  const by = new Map(d.checkins.map((c) => [c.studentId, c]));
  const present = d.checkins.filter((c) => c.status === 'present').length;
  const pending = d.checkins.filter((c) => c.status === 'pending').length;
  const total = d.students.length;
  const f = live.filter;
  const list = d.students.filter((s) => {
    const c = by.get(s.id);
    if (f === 'present') return c?.status === 'present';
    if (f === 'waiting') return !c;
    if (f === 'review') return c?.status === 'pending';
    return true;
  });

  el.innerHTML = `
    <div class="register-head">
      <div class="count" aria-live="polite"><b>${present}</b><span>of ${total} present</span></div>
      <div class="filters" role="group" aria-label="Filter the register">
        ${[
          ['all', `All ${total}`],
          ['waiting', `Not yet ${total - present - pending}`],
          ['present', `Present ${present}`],
          ['review', `Needs review ${pending}`],
        ]
          .map(([k, label]) => `<button data-act="filter" data-filter="${k}" aria-pressed="${f === k}">${label}</button>`)
          .join('')}
      </div>
    </div>
    <div class="bar" aria-hidden="true"><i style="width:${total ? (100 * present) / total : 0}%"></i></div>
    ${
      total === 0
        ? `<div class="empty"><h2>No one on the list yet</h2><p>This class has an open list. Students appear here as they check in.</p></div>`
        : `<ul class="register">${list
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
            .join('')}</ul>`
    }`;
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

function startNowPlaying() {
  clearInterval(live.animTimer);
  live.animTimer = setInterval(async () => {
    const tx = $('#tx');
    if (!tx || !live.tx) return;
    const np = await live.tx.nowPlaying();
    if (!np) return;
    const spans = tx.children;
    for (let i = 0; i < 16; i++) {
      spans[i].style.setProperty('--v', String(np.tones[i] / 15));
      spans[i].classList.toggle('now', i === np.slot);
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
  renderLive();
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
      <p class="muted">${present} of ${d.students.length} checked in. Students who have not checked in will be marked absent, and the sound stops.</p>
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
      const dlg = document.createElement('dialog');
      dlg.className = 'qr-big';
      dlg.innerHTML = `<div class="qr-big-inner">${qrSvg(el.dataset.url)}<p class="join-url">${esc(el.dataset.url.replace(/^https?:\/\//, ''))}</p>
        <button class="btn" data-close>Close</button></div>`;
      document.body.append(dlg);
      dlg.addEventListener('close', () => dlg.remove());
      dlg.addEventListener('click', (ev) => (ev.target === dlg || ev.target.closest('[data-close]')) && dlg.close());
      dlg.showModal();
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
  if (live.tx && live.view && !live.view.session.endedAt) {
    e.preventDefault();
  }
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
