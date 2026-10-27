// Student check-in page: one screen that moves through clear states.

import { getIdentity, nonce } from './lib/identity.js';
import { startReceiver, MicError } from './lib/receiver.js';
import { Waterfall, slotsHtml, setSlot, clearSlots } from './lib/listen-view.js';
import { nibblesToHex } from './modem/protocol.js';

const $ = (sel, root = document) => root.querySelector(sel);
const app = $('#app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const time = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });

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

// ---------- icons ----------

const ICON = {
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/><path d="M3 3l18 18"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/></svg>',
  wait: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
  closed: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4h11l3 3v13H5z"/><path d="M8.5 10h7M8.5 13.5h7M8.5 17h4"/></svg>',
  phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/></svg>',
  link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1"/><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"/></svg>',
  wifi: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 9a14 14 0 0 1 19 0M5.5 12.5a9.5 9.5 0 0 1 13 0M8.8 16a5 5 0 0 1 6.4 0"/><circle cx="12" cy="19.5" r="1" fill="currentColor"/></svg>',
};

const CHECK = '<div class="check"><svg viewBox="0 0 96 96" aria-hidden="true"><circle cx="48" cy="48" r="44"/><path d="M30 49l12 12 24-26" fill="none" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/></svg></div>';

// ---------- rendering ----------

function show(view, html) {
  if (S.view === 'listening' && view !== 'listening') teardownListening();
  S.view = view;
  app.innerHTML = `<div class="enter" style="display:contents">${html}</div>`;
  app.dataset.view = view;
  const h = app.querySelector('h1');
  if (h) {
    h.tabIndex = -1;
    h.focus({ preventScroll: true });
  }
}

function iconStage(icon, tone = '') {
  return `<div class="stage icon ${tone}" aria-hidden="true">${ICON[icon]}</div>`;
}

function who(extra = '') {
  if (!S.student) return '';
  return `<dl class="s-who"><dt>Name</dt><dd>${esc(S.student.name)}</dd><dt>Roll</dt><dd>${esc(S.student.roll)}</dd>${extra}</dl>`;
}

const views = {
  noCourse() {
    show(
      'no_course',
      `${iconStage('link')}
      <div class="s-copy"><h1>This class link doesn't work</h1>
      <p>Check the link with your lecturer. It should end with your course code, like <b>/c/CS201</b>.</p></div>`,
    );
  },

  identify(error = '') {
    const open = S.course.openRoster;
    show(
      'identify',
      `<div class="s-copy"><h1>Who's checking in?</h1>
       <p>Enter your roll number once. This phone remembers it for ${esc(S.course.code)}.</p></div>
       <form class="s-form" id="who" novalidate>
         <div class="field">
           <label for="roll">Roll number</label>
           <input class="input" id="roll" name="roll" autocomplete="off" autocapitalize="characters" spellcheck="false"
             inputmode="text" required maxlength="32" value="${esc(S.roll || '')}" ${error ? 'aria-invalid="true" aria-describedby="err"' : ''} />
         </div>
         ${
           open
             ? `<div class="field"><label for="name">Your name</label>
                <input class="input" id="name" name="name" autocomplete="name" maxlength="80" required /></div>`
             : ''
         }
         ${error ? `<p class="form-error" id="err" role="alert">${esc(error)}</p>` : ''}
         <div class="s-actions"><button class="btn btn-primary btn-lg btn-block" type="submit">Continue</button></div>
       </form>`,
    );
    $('#who').addEventListener('submit', onIdentify);
  },

  noSession() {
    show(
      'no_session',
      `${iconStage('wait')}
       <div class="s-copy"><h1>Class hasn't started yet</h1>
       <p>When your lecturer starts the session, this page moves on by itself.</p>${who()}</div>
       <div class="s-actions"><p class="s-foot">Not you? <a href="#" data-act="switch">Use a different roll number</a></p></div>`,
    );
  },

  ready() {
    const note =
      S.binding === 'other_device'
        ? `<p class="s-note">Your roll number is set up on another phone. You can still check in, and your lecturer will confirm it.</p>`
        : '';
    show(
      'ready',
      `<div class="stage" aria-hidden="true">
         <div class="stage-label"><span>Waiting to listen</span></div>
         <canvas class="waterfall"></canvas>${slotsHtml()}
       </div>
       <div class="s-copy"><h1>Ready when you are</h1>
       <p>Your phone listens for a quiet signal from the lecturer's laptop. It takes a few seconds.</p>${note}</div>
       <div class="s-actions">
         <button class="btn btn-primary btn-lg btn-block" data-act="listen">Start listening</button>
         <p class="s-foot">Sound is decoded on this phone. Nothing is recorded or uploaded.</p>
       </div>`,
    );
  },

  listening() {
    show(
      'listening',
      `<div class="stage" id="stage" aria-hidden="true">
         <div class="stage-label"><span id="stageLabel">Listening</span>
           <span class="meter" id="meter"><b></b><b></b><b></b><b></b><b></b></span></div>
         <canvas class="waterfall" id="wf"></canvas>${slotsHtml()}
         ${CHECK}
       </div>
       <div class="s-copy"><h1 id="title">Listening</h1><p id="body">Hold your phone up with the screen facing you.</p>
         <div id="extra"></div></div>
       <div class="s-actions"><button class="btn btn-quiet btn-block" data-act="stop">Stop</button></div>`,
    );
  },

  present(at, status) {
    const pending = status === 'pending';
    const already = status === 'already';
    show(
      status,
      `<div class="stage done caught" aria-hidden="true">
         <div class="stage-label"><span>${pending ? 'Waiting for your lecturer' : 'Code caught'}</span></div>
         <canvas class="waterfall"></canvas>${slotsHtml()}${CHECK}
       </div>
       <div class="s-copy">
         <h1 class="big">${pending ? 'Almost there' : 'Present'}</h1>
         <p>${
           pending
             ? `You're checked in to ${esc(S.course.code)}. Your lecturer needs to confirm this phone.`
             : already
               ? `You already checked in to ${esc(S.course.code)} at ${time(at)}.`
               : `Marked at ${time(at)} in ${esc(S.course.code)} ${esc(S.course.title)}.`
         }</p>
         ${who()}
         ${pending ? '<p class="s-note">This phone is new for your roll number. Once your lecturer approves it, it becomes your phone for this class.</p>' : ''}
       </div>
       <div class="s-actions"><p class="s-foot">You can close this page.</p></div>`,
    );
    $('.stage').querySelectorAll('.slot').forEach((s, i) => {
      s.classList.add('on');
      s.style.setProperty('--v', String(((i * 7) % 16) / 15));
    });
  },

  micProblem(kind) {
    const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const copy = {
      denied: {
        h: 'Earshot needs your microphone',
        p: 'Microphone access is blocked for this page. Turn it on, then try again.',
        tips: isIOS
          ? ['Tap <b>aA</b> in the address bar, then <b>Website Settings</b>.', 'Set <b>Microphone</b> to <b>Allow</b>.', 'Come back here and tap <b>Try again</b>.']
          : ['Tap the icon at the left of the address bar.', 'Open <b>Permissions</b> and allow <b>Microphone</b>.', 'Come back here and tap <b>Try again</b>.'],
      },
      insecure: {
        h: 'Open the secure link',
        p: 'Phones only share the microphone with pages that start with https. Ask your lecturer for that link.',
        tips: [],
      },
      unsupported: {
        h: "This browser can't listen",
        p: 'Open this page in Chrome on Android or Safari on iPhone.',
        tips: [],
      },
      no_device: { h: 'No microphone found', p: 'This device does not seem to have a microphone Earshot can use.', tips: [] },
      busy: {
        h: 'Your microphone is busy',
        p: 'Another app is using it. Close calls, voice notes or recorders, then try again.',
        tips: [],
      },
    }[kind] || { h: "Couldn't start the microphone", p: 'Try again. If it keeps failing, reload the page.', tips: [] };
    show(
      'mic_' + kind,
      `${iconStage(kind === 'insecure' ? 'lock' : 'mic')}
       <div class="s-copy"><h1>${copy.h}</h1><p>${copy.p}</p>
       ${copy.tips.length ? `<ol class="s-tips">${copy.tips.map((t) => `<li>${t}</li>`).join('')}</ol>` : ''}</div>
       <div class="s-actions">${kind === 'insecure' || kind === 'unsupported' ? '' : '<button class="btn btn-primary btn-lg btn-block" data-act="listen">Try again</button>'}</div>`,
    );
  },

  ended() {
    show(
      'ended',
      `${iconStage('closed')}
       <div class="s-copy"><h1>Attendance for this class is closed</h1>
       <p>Your lecturer ended the session before your phone checked in. If you were in the room, talk to them after class.</p>${who()}</div>`,
    );
  },

  problem(title, body, { icon = 'phone', retry = false } = {}) {
    show(
      'problem',
      `${iconStage(icon, 'hl')}
       <div class="s-copy"><h1>${esc(title)}</h1><p>${esc(body)}</p></div>
       <div class="s-actions">${retry ? '<button class="btn btn-primary btn-lg btn-block" data-act="listen">Listen again</button>' : ''}</div>`,
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
};

function setText(title, body, label) {
  const t = $('#title');
  const b = $('#body');
  if (t && t.textContent !== title) t.textContent = title;
  if (b && b.innerHTML !== body) b.innerHTML = body;
  if (label) $('#stageLabel').textContent = label;
}

function setPhase(phase) {
  if (L.submitting && phase !== 'sending') return;
  L.phase = phase;
  const extra = $('#extra');
  if (extra) extra.innerHTML = '';
  switch (phase) {
    case 'silent':
      setText('Listening', 'Hold your phone up with the screen facing you.', 'Listening');
      break;
    case 'faint':
      setText('Picking something up', 'Hold the phone higher, away from your body, with nothing covering the bottom edge.', 'Faint signal');
      break;
    case 'locked':
      setText('Hearing the code', 'Keep the phone still for a moment.', 'Catching the code');
      break;
    case 'close':
      setText('Almost', 'Part of the code got lost in the noise. Keep holding the phone up. It tries again every couple of seconds.', 'Trying again');
      break;
    case 'cant_hear':
      setText("Can't hear the classroom yet", 'Still listening. A few things that help:', 'Nothing heard');
      if (extra)
        extra.innerHTML = `<ul class="s-tips">
          <li>Check the lecturer's laptop shows the session screen with moving marks.</li>
          <li>Move closer to the front, or hold the phone towards the laptop.</li>
          <li>Ask your lecturer to switch to audible mode for a minute.</li></ul>`;
      break;
    case 'sending':
      setText('Got it', 'Checking you in…', 'Code caught');
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
  setPhase('silent');

  const band = () => S.session?.mode || 'quiet';
  try {
    S.receiver = await startReceiver({
      onLevel(levels) {
        const db = Math.max(levels[band()], levels.quiet);
        L.levelDb = db;
        L.wf?.push(S.receiver?.demod.spectrum(levels.audible > levels.quiet + 6 ? 'audible' : band()));
        updateMeter(db);
        if (db > 9) L.lastHeard = Date.now();
      },
      onSync() {
        clearSlots($('#stage'));
        setPhase('locked');
      },
      onSymbol({ index, value, confidence }) {
        setSlot($('#stage'), index, value, confidence);
      },
      onLost() {
        L.lostCount++;
        setPhase('close');
      },
      onFrame(frame) {
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

  if (!res) return resume('Still offline', 'Check your Wi-Fi or mobile data. Your phone keeps listening and will try again with the next code.');

  if (res.ok) {
    S.student = data.student;
    const stage = $('#stage');
    stage?.classList.add('done');
    navigator.vibrate?.(30);
    // Let the check draw before the screen changes.
    await new Promise((r) => setTimeout(r, 900));
    teardownListening();
    return views.present(data.at, data.status === 'already' ? 'already' : data.status);
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
  const roll = form.roll.value.trim().toUpperCase();
  const name = form.name?.value.trim();
  if (!roll) return views.identify('Enter your roll number.');
  if (form.name && !name) return views.identify('Enter your name.');
  form.querySelector('button').disabled = true;
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
