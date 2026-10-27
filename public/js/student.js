// Student check-in page: one screen that moves through clear states.

import { getIdentity, nonce } from './lib/identity.js';
import { startReceiver, MicError } from './lib/receiver.js';
import { Waterfall, slotsHtml, setSlot, clearSlots } from './lib/listen-view.js';
import { nibblesToHex } from './modem/protocol.js';

const $ = (sel, root = document) => root.querySelector(sel);
const app = $('#app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const time = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const code = decodeURIComponent(location.pathname.split('/')[2] || '').toUpperCase();
const params = new URLSearchParams(location.search);
const rollKey = `earshot:roll:${code}`;

const S = {
  identity: null,
  course: null,
  session: null,
  roll: null,
  student: null,
  binding: null,
  receiver: null,
  view: null,
};

// ---------- glyphs: one per kind of problem ----------

const GLYPH = {
  mic: '<path d="M24 8a8 8 0 0 1 8 8v12a8 8 0 0 1-16 0V16a8 8 0 0 1 8-8zM12 28a12 12 0 0 0 24 0M24 40v6M8 8l32 40"/>',
  lock: '<rect x="10" y="22" width="28" height="22" rx="3"/><path d="M16 22v-6a8 8 0 0 1 16 0v6"/>',
  wait: '<circle cx="24" cy="26" r="17"/><path d="M24 16v10l7 4"/>',
  closed: '<path d="M10 6h20l8 8v30H10z"/><path d="M17 22h14M17 29h14M17 36h8"/>',
  phone: '<rect x="14" y="4" width="20" height="40" rx="4"/><path d="M22 38h4"/>',
  link: '<path d="M20 28a8 8 0 0 0 11.3 0l6-6a8 8 0 0 0-11.3-11.3l-2 2"/><path d="M28 20a8 8 0 0 0-11.3 0l-6 6a8 8 0 0 0 11.3 11.3l2-2"/>',
  wifi: '<path d="M5 18a28 28 0 0 1 38 0M11 25a19 19 0 0 1 26 0M17.5 32a10 10 0 0 1 13 0"/><circle cx="24" cy="39" r="2" fill="currentColor"/>',
};
const glyph = (k) =>
  `<svg class="s-glyph" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${GLYPH[k]}</svg>`;

const CHECK = '<svg class="s-check" viewBox="0 0 96 96" aria-hidden="true"><path d="M14 50l22 22 46-48"/></svg>';
const WAITING = '<svg class="s-check wait" viewBox="0 0 96 96" aria-hidden="true"><circle cx="48" cy="48" r="38"/></svg>';

// ---------- rendering ----------

function show(view, html, tone = '') {
  if (S.view === 'listening' && view !== 'listening') teardownListening();
  S.view = view;
  document.body.dataset.tone = tone;
  app.innerHTML = html;
  app.firstElementChild?.classList.add('enter');
  app.dataset.view = view;
  const meta = document.querySelector('meta[name="theme-color"]:not([media])') || document.createElement('meta');
  meta.name = 'theme-color';
  meta.content = getComputedStyle(document.body).backgroundColor;
  document.head.append(meta);
  const h = app.querySelector('h1');
  if (h) {
    h.tabIndex = -1;
    h.focus({ preventScroll: true });
  }
}

function who(extra = '') {
  if (!S.student) return '';
  return `<dl class="s-who"><dt>Name</dt><dd>${esc(S.student.name)}</dd><dt>Roll</dt><dd>${esc(S.student.roll)}</dd>${extra}</dl>`;
}

const page = (inner, actions = '') => `<div style="display:contents">${inner}<div class="s-actions">${actions}</div></div>`;

const views = {
  noCourse() {
    show(
      'no_course',
      page(`<div class="s-copy">${glyph('link')}<h1 class="s-title">Bad link</h1>
        <p>This class link doesn't match a class. Check it with your lecturer. It ends with the course code, like <b>/c/CS201</b>.</p></div>`),
    );
  },

  identify(error = '') {
    const open = S.course.openRoster;
    show(
      'identify',
      page(
        `<div class="s-copy"><h1 class="s-title">Check in</h1>
         <p>Your roll number, once. This phone remembers it for <b>${esc(S.course.code)}</b>.</p></div>
         <form class="s-form" id="who" novalidate>
           <div class="field">
             <label for="roll">Roll number</label>
             <input class="input" id="roll" name="roll" autocomplete="off" autocapitalize="characters" spellcheck="false"
               required maxlength="32" placeholder="21CS001" value="${esc(S.roll || '')}" ${error ? 'aria-invalid="true" aria-describedby="err"' : ''} />
           </div>
           ${
             open
               ? `<div class="field"><label for="name">Your name</label>
                  <input class="input" id="name" name="name" autocomplete="name" maxlength="80" required /></div>`
               : ''
           }
           ${error ? `<p class="form-error" id="err" role="alert">${esc(error)}</p>` : ''}
         </form>`,
        '<button class="btn btn-primary btn-lg btn-block" type="submit" form="who">Continue</button>',
      ),
    );
    $('#who').addEventListener('submit', onIdentify);
  },

  noSession() {
    show(
      'no_session',
      page(
        `<div class="s-copy">${glyph('wait')}<h1 class="s-title">Not started</h1>
         <p>When your lecturer starts the session, this page moves on by itself.</p>${who()}</div>`,
        '<p class="s-foot">Not you? <a href="#" data-act="switch">Use a different roll number</a></p>',
      ),
    );
  },

  ready() {
    const note =
      S.binding === 'other_device'
        ? `<p class="s-note">Your roll number is set up on another phone. You can still check in, and your lecturer will confirm it.</p>`
        : '';
    show(
      'ready',
      page(
        `<section class="s-viz" aria-hidden="true"><canvas class="waterfall"></canvas>${slotsHtml()}</section>
         <div class="s-copy"><h1 class="s-title">Ready</h1>
         <p>Your phone listens for a quiet signal from the lecturer's laptop. Hold it up for a few seconds.</p>${note}</div>`,
        `<button class="btn btn-blue btn-lg btn-block" data-act="listen">Start listening</button>
         <p class="s-foot">Sound is decoded on this phone. Nothing is recorded or uploaded.</p>`,
      ),
    );
  },

  listening() {
    show(
      'listening',
      page(
        `<section class="s-viz" id="stage" aria-hidden="true"><canvas class="waterfall" id="wf"></canvas>${slotsHtml()}</section>
         <div class="s-sig"><span class="meter" id="meter"><b></b><b></b><b></b><b></b><b></b></span><span id="sigLabel">Listening</span></div>
         <div class="s-copy" style="padding-top:4px"><h1 class="s-title" id="title">Listening</h1><p id="body">Hold your phone up with the screen facing you.</p>
           <div id="extra"></div></div>`,
        '<button class="btn btn-quiet btn-block" data-act="stop">Stop listening</button>',
      ),
    );
  },

  present(at, status) {
    const pending = status === 'pending';
    const already = status === 'already';
    show(
      status,
      page(
        `<div class="s-copy">${pending ? WAITING : CHECK}
           <h1 class="s-title">${pending ? 'Almost there' : 'Present'}</h1>
           <p>${
             pending
               ? `You're checked in to ${esc(S.course.code)}. This phone is new for your roll number, so your lecturer will confirm it.`
               : already
                 ? `You already checked in to ${esc(S.course.code)} at ${time(at)}.`
                 : `Marked at ${time(at)} in ${esc(S.course.code)} ${esc(S.course.title)}.`
           }</p>
           ${who()}
         </div>`,
        '<p class="s-foot">You can close this page.</p>',
      ),
      pending ? 'hl' : 'blue',
    );
  },

  micProblem(kind) {
    const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const copy = {
      denied: {
        h: 'Mic blocked',
        p: 'This page is not allowed to use the microphone. Turn it on, then try again.',
        steps: isIOS
          ? ['Tap <b>aA</b> in the address bar, then <b>Website Settings</b>.', 'Set <b>Microphone</b> to <b>Allow</b>.', 'Come back and tap <b>Try again</b>.']
          : ['Tap the icon at the left of the address bar.', 'Open <b>Permissions</b> and allow <b>Microphone</b>.', 'Come back and tap <b>Try again</b>.'],
      },
      insecure: { h: 'Wrong link', p: 'Phones only share the microphone with pages that start with https. Ask your lecturer for that link.', steps: [] },
      unsupported: { h: "Can't listen here", p: 'This browser cannot use the microphone. Open the link in Chrome on Android or Safari on iPhone.', steps: [] },
      no_device: { h: 'No mic', p: 'This device does not seem to have a microphone Earshot can use.', steps: [] },
      busy: { h: 'Mic busy', p: 'Another app is using the microphone. Close calls, voice notes or recorders, then try again.', steps: [] },
    }[kind] || { h: "Couldn't start", p: 'The microphone did not start. Try again, and reload the page if it keeps failing.', steps: [] };
    show(
      'mic_' + kind,
      page(
        `<div class="s-copy">${glyph(kind === 'insecure' ? 'lock' : 'mic')}<h1 class="s-title">${copy.h}</h1><p>${copy.p}</p>
         ${copy.steps.length ? `<ol class="s-steps">${copy.steps.map((t) => `<li><span>${t}</span></li>`).join('')}</ol>` : ''}</div>`,
        kind === 'insecure' || kind === 'unsupported' ? '' : '<button class="btn btn-primary btn-lg btn-block" data-act="listen">Try again</button>',
      ),
    );
  },

  ended() {
    show(
      'ended',
      page(
        `<div class="s-copy">${glyph('closed')}<h1 class="s-title">Closed</h1>
         <p>Your lecturer ended the session before this phone checked in. If you were in the room, talk to them after class.</p>${who()}</div>`,
      ),
    );
  },

  problem(title, body, { icon = 'phone', retry = false } = {}) {
    show(
      'problem',
      page(
        `<div class="s-copy">${glyph(icon)}<h1 class="s-title">${esc(title)}</h1><p>${esc(body)}</p></div>`,
        retry ? '<button class="btn btn-primary btn-lg btn-block" data-act="listen">Listen again</button>' : '',
      ),
    );
  },
};

// ---------- listening ----------

const L = {
  wf: null,
  started: 0,
  lastHeard: 0,
  phase: 'silent',
  submitting: false,
  sent: new Set(),
  pingTimer: null,
  tickTimer: null,
  levelDb: 0,
  lostCount: 0,
  // Counters for the end-to-end test and the field test page.
  stats: { levels: 0, syncs: 0, frames: 0, lost: 0, maxDb: 0, submitted: [], replies: [] },
};
window.__earshot = L.stats;

function setText(title, body, label) {
  const t = $('#title');
  const b = $('#body');
  if (t && t.textContent !== title) {
    t.textContent = title;
    if (!reduceMotion) t.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: 'ease-out' });
  }
  if (b && b.innerHTML !== body) b.innerHTML = body;
  if (label && $('#sigLabel')) $('#sigLabel').textContent = label;
}

function setPhase(phase) {
  if (L.submitting && phase !== 'sending') return;
  if (phase === L.phase && phase !== 'locked') return;
  L.phase = phase;
  const extra = $('#extra');
  if (extra) extra.innerHTML = '';
  switch (phase) {
    case 'silent':
      setText('Listening', 'Hold your phone up with the screen facing you.', 'Listening');
      break;
    case 'faint':
      setText('Faint', 'Something is there. Hold the phone higher, away from your body, with nothing covering the bottom edge.', 'Faint signal');
      break;
    case 'locked':
      setText('Hearing it', 'Keep the phone still for a moment.', 'Catching the code');
      break;
    case 'close':
      setText('Almost', 'Part of the code got lost in the noise. Keep holding the phone up; it tries again every couple of seconds.', 'Trying again');
      break;
    case 'cant_hear':
      setText('Nothing yet', 'Still listening. Things that help:', 'Nothing heard');
      if (extra)
        extra.innerHTML = `<ul class="s-steps plain">
          <li><span>Check the lecturer's laptop is showing the session with a moving code.</span></li>
          <li><span>Move closer to the front, or point the phone at the laptop.</span></li>
          <li><span>Ask your lecturer to switch to audible mode for a minute.</span></li></ul>`;
      break;
    case 'sending':
      setText('Caught', 'Checking you in…', 'Code caught');
      break;
  }
}

function updateMeter(db) {
  const bars = document.querySelectorAll('#meter b');
  const n = db < 4 ? 0 : db < 8 ? 1 : db < 12 ? 2 : db < 17 ? 3 : db < 22 ? 4 : 5;
  bars.forEach((b, i) => b.classList.toggle('on', i < n));
}

async function startListening() {
  if (!S.session) return views.noSession();
  views.listening();
  L.wf = new Waterfall($('#wf'));
  L.started = Date.now();
  L.lastHeard = 0;
  L.submitting = false;
  L.sent.clear();
  L.lostCount = 0;
  L.phase = null;
  setPhase('silent');

  const band = () => S.session?.mode || 'quiet';
  try {
    S.receiver = await startReceiver({
      onLevel(levels) {
        const db = Math.max(levels[band()], levels.quiet);
        L.levelDb = db;
        L.stats.levels++;
        L.stats.maxDb = Math.max(L.stats.maxDb, db);
        L.wf?.push(S.receiver?.demod.spectrum(levels.audible > levels.quiet + 6 ? 'audible' : band()));
        updateMeter(db);
        if (db > 9) L.lastHeard = Date.now();
      },
      onSync() {
        L.stats.syncs++;
        clearSlots($('#stage'));
        setPhase('locked');
      },
      onSymbol({ index, value, confidence }) {
        setSlot($('#stage'), index, value, confidence);
      },
      onLost() {
        L.lostCount++;
        L.stats.lost++;
        setPhase('close');
      },
      onFrame(frame) {
        L.stats.frames++;
        submit(frame);
      },
    });
  } catch (e) {
    teardownListening();
    if (e instanceof MicError) return views.micProblem(e.kind);
    console.error(e);
    return views.micProblem('other');
  }

  // Quiet-or-loud bookkeeping that the callbacks above do not cover.
  L.tickTimer = setInterval(() => {
    if (L.submitting || L.phase === 'locked') return;
    const since = Date.now() - (L.lastHeard || L.started);
    if (L.phase === 'close' && since < 4000) return;
    if (since > 15000) setPhase('cant_hear');
    else if (L.levelDb > 9 && L.phase !== 'cant_hear') setPhase('faint');
    else if (L.phase !== 'cant_hear' && L.phase !== 'close') setPhase('silent');
  }, 500);

  const ping = () => {
    const state = L.phase === 'cant_hear' || L.levelDb < 6 ? 'silent' : L.phase === 'faint' || L.phase === 'close' ? 'faint' : 'listening';
    fetch(`/api/join/${encodeURIComponent(code)}/ping`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device: S.identity.id, state, level: Math.round(L.levelDb) }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (!d.live) onSessionGone();
        else if (d.sessionId !== S.session?.id) refresh();
      })
      .catch(() => {});
  };
  ping();
  L.pingTimer = setInterval(ping, 4000);
}

function teardownListening() {
  clearInterval(L.pingTimer);
  clearInterval(L.tickTimer);
  L.wf?.destroy();
  L.wf = null;
  S.receiver?.stop();
  S.receiver = null;
}

async function onSessionGone() {
  if (S.view !== 'listening' || L.submitting) return;
  teardownListening();
  views.ended();
}

// The caught marks sit on one line; that line opens into the outcome colour.
let floodEl = null;
async function flood(tone) {
  if (reduceMotion) return;
  await wait(520);
  const stage = $('#stage');
  const r = stage?.getBoundingClientRect();
  const y = r ? r.top + r.height / 2 : innerHeight / 2;
  floodEl = document.createElement('div');
  floodEl.className = 'flood';
  floodEl.style.background = tone === 'hl' ? 'var(--hl)' : 'var(--blue)';
  document.body.append(floodEl);
  await floodEl.animate(
    [{ clipPath: `inset(${y - 3}px 20px ${innerHeight - y - 3}px 20px)` }, { clipPath: `inset(${y - 3}px 0 ${innerHeight - y - 3}px 0)`, offset: 0.25 }, { clipPath: 'inset(0 0 0 0)' }],
    { duration: 650, easing: 'cubic-bezier(0.7, 0, 0.2, 1)', fill: 'forwards' },
  ).finished;
}

function unflood() {
  if (!floodEl) return;
  const el = floodEl;
  floodEl = null;
  el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, fill: 'forwards' }).finished.then(() => el.remove());
}

async function submit(frame) {
  const payload = nibblesToHex(frame.nibbles);
  if (L.submitting || L.sent.has(payload)) return;
  L.sent.add(payload);
  L.submitting = true;
  setPhase('sending');
  frame.nibbles.forEach((v, i) => setSlot($('#stage'), i, v, 1));
  $('#stage')?.classList.add('caught');

  const n = nonce();
  const body = {
    sessionId: S.session.id,
    roll: S.roll,
    payload,
    band: frame.band,
    nonce: n,
    publicKey: S.identity.publicKey,
    meta: { combined: frame.combined, corrected: frame.corrected },
  };
  body.sig = await S.identity.sign(`earshot-checkin\n${body.sessionId}\n${body.roll}\n${payload}\n${n}`);

  let res;
  let data;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      res = await fetch('/api/checkin', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      data = await res.json();
      break;
    } catch {
      setText('No connection', 'Your phone caught the code but cannot reach the server. Retrying…', 'Offline');
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }

  const resume = (title, text) => {
    L.submitting = false;
    $('#stage')?.classList.remove('caught');
    clearSlots($('#stage'));
    setPhase('silent');
    if (title) setText(title, text, 'Listening');
  };

  L.stats.replies.push(res ? res.status + ' ' + (data?.error || data?.status) : 'offline');
  if (!res) return resume('Still offline', 'Check your Wi-Fi or mobile data. Your phone keeps listening and will try again with the next code.');

  if (res.ok) {
    S.student = data.student;
    navigator.vibrate?.(30);
    await flood(data.status === 'pending' ? 'hl' : 'blue');
    teardownListening();
    views.present(data.at, data.status === 'already' ? 'already' : data.status);
    unflood();
    return;
  }

  switch (data.error) {
    case 'stale_code':
    case 'bad_code':
      return resume('Listening for the next code', 'That one had just changed. A new code plays every few seconds.');
    case 'session_ended':
      teardownListening();
      return views.ended();
    case 'device_used':
      teardownListening();
      return views.problem('This phone already checked someone in', data.message || 'Each phone can check in one person per class.', { icon: 'phone' });
    case 'not_on_roster':
      teardownListening();
      localStorage.removeItem(rollKey);
      S.roll = null;
      return views.identify('That roll number is not on this class list.');
    case 'rate_limited':
      L.submitting = false;
      setText('Slow down a little', 'Too many tries from this phone. Wait a minute and keep the page open.', 'Paused');
      return;
    default:
      teardownListening();
      return views.problem("Couldn't check you in", data.message || 'Something went wrong on the server. Try again in a moment.', { retry: true });
  }
}

// ---------- flow ----------

async function onIdentify(e) {
  e.preventDefault();
  const form = e.currentTarget;
  // form.name is the form's own name attribute, so go through elements.
  const nameInput = form.elements.namedItem('name');
  const roll = form.elements.namedItem('roll').value.trim().toUpperCase();
  const name = nameInput?.value.trim();
  if (!roll) return views.identify('Enter your roll number.');
  if (nameInput && !name) return views.identify('Enter your name.');
  const submitBtn = document.querySelector('button[form="who"]');
  if (submitBtn) submitBtn.disabled = true;
  const n = nonce();
  const sig = await S.identity.sign(`earshot-enrol\n${code}\n${roll}\n${n}`);
  let res;
  let data;
  try {
    res = await fetch(`/api/join/${encodeURIComponent(code)}/enrol`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roll, name, publicKey: S.identity.publicKey, nonce: n, sig }),
    });
    data = await res.json();
  } catch {
    S.roll = roll;
    return views.identify('No connection. Check your Wi-Fi or mobile data and try again.');
  }
  if (!res.ok) {
    S.roll = roll;
    return views.identify(data.message || 'That did not work. Check the roll number and try again.');
  }
  S.roll = data.student.roll;
  S.student = data.student;
  S.binding = data.binding;
  localStorage.setItem(rollKey, S.roll);
  route();
}

let pollTimer;

async function refresh() {
  const res = await fetch(`/api/join/${encodeURIComponent(code)}?device=${encodeURIComponent(S.identity.id)}`, { cache: 'no-store' }).catch(() => null);
  if (!res) return false;
  if (res.status === 404) {
    S.course = null;
    return true;
  }
  const d = await res.json();
  S.course = d.course;
  const prevSession = S.session?.id;
  S.session = d.session;
  S.checkin = d.checkin;
  if (d.me) {
    S.student = d.me;
    if (!S.roll) S.roll = d.me.roll;
  }
  if (prevSession && d.session && d.session.id !== prevSession && S.view !== 'listening') route();
  return true;
}

function route() {
  if (!S.course) return views.noCourse();
  $('#course').textContent = S.course.code;
  document.title = `Check in to ${S.course.code}`;
  if (!S.roll) return views.identify();
  if (S.checkin) return views.present(S.checkin.at, S.checkin.status === 'pending' ? 'pending' : 'already');
  if (!S.session) return views.noSession();
  return views.ready();
}

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    if (S.view === 'listening') return;
    const before = { session: S.session?.id, checkin: !!S.checkin };
    await refresh();
    const changed = before.session !== S.session?.id || before.checkin !== !!S.checkin;
    if (!changed) return;
    if (['no_session', 'ready', 'ended'].includes(S.view)) route();
  }, 5000);
}

app.addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  e.preventDefault();
  if (act === 'listen') startListening();
  if (act === 'stop') {
    teardownListening();
    views.ready();
  }
  if (act === 'switch') {
    localStorage.removeItem(rollKey);
    S.roll = null;
    S.student = null;
    views.identify();
  }
});

document.addEventListener('visibilitychange', () => {
  // Browsers cut the microphone in the background; pick up cleanly on return.
  if (document.visibilityState === 'visible' && S.view === 'listening' && !S.receiver) views.ready();
});

async function main() {
  if (params.has('demo')) {
    const { runDemo } = await import('./student-demo.js');
    return runDemo({ S, views, setPhase, setSlot, Waterfall, $, params });
  }
  try {
    S.identity = await getIdentity();
  } catch {
    return views.micProblem('unsupported');
  }
  S.roll = localStorage.getItem(rollKey);
  const ok = await refresh();
  if (!ok) return views.problem('No connection', 'Earshot could not reach the server. Check your Wi-Fi or mobile data, then reload.', { icon: 'wifi' });
  route();
  startPolling();
}

main();
