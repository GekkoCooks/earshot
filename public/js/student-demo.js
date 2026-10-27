// Renders any student state with sample data, for the states gallery and
// screenshots. Loaded only when the URL has ?demo=<state>.

import { frameTones, packPayload, bankOf } from './modem/protocol.js';

export function runDemo({ S, views, setPhase, setSlot, Waterfall, $, params }) {
  const state = params.get('demo');
  S.course = { code: 'CS201', title: 'Data Structures', openRoster: false };
  S.student = { name: 'Asha Rao', roll: '21CS001' };
  S.roll = '21CS001';
  S.session = { id: 'demo', mode: 'quiet' };
  $('#course').textContent = 'CS201';
  const at = new Date();
  at.setHours(9, 4, 0, 0);

  const listening = (phase, { strength = 1, slots = 0 } = {}) => {
    views.listening();
    const wf = new Waterfall($('#wf'));
    const tones = frameTones(packPayload(0x3c, 0x9a41e7));
    let hop = 0;
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const tick = () => {
      const spec = new Float32Array(32);
      for (let i = 0; i < 32; i++) spec[i] = 1 + rand() * 2.2;
      if (strength > 0) {
        const slot = Math.floor(hop / 4) % 16;
        const bin = tones[slot] * 2 + bankOf(slot);
        spec[bin] = 1 + 120 * strength * (0.7 + 0.3 * rand());
        // A little echo of the previous symbol.
        const prev = (slot + 15) % 16;
        spec[tones[prev] * 2 + bankOf(prev)] += 12 * strength;
      }
      wf.push(spec);
      hop++;
    };
    for (let i = 0; i < 110; i++) tick();
    if (!params.has('still')) setInterval(tick, 25);
    const meter = document.querySelectorAll('#meter b');
    const lit = strength > 0.6 ? 4 : strength > 0 ? 2 : 0;
    meter.forEach((b, i) => b.classList.toggle('on', i < lit));
    const code = tones.slice(4);
    for (let i = 0; i < slots; i++) setSlot($('#stage'), i, code[i], i === 3 ? 0.5 : 1);
    setPhase(phase);
    if (phase === 'sending') $('#stage').classList.add('caught');
  };

  switch (state) {
    case 'identify':
      S.roll = null;
      return views.identify();
    case 'identify-error':
      S.roll = '21CS0O1';
      return views.identify('That roll number is not on this class list.');
    case 'no-session':
      return views.noSession();
    case 'ready':
      return views.ready();
    case 'ready-new-phone':
      S.binding = 'other_device';
      return views.ready();
    case 'listening':
      return listening('silent', { strength: 0 });
    case 'faint':
      return listening('faint', { strength: 0.15 });
    case 'catching':
      return listening('locked', { strength: 1, slots: 7 });
    case 'almost':
      return listening('close', { strength: 0.35, slots: 0 });
    case 'cant-hear':
      return listening('cant_hear', { strength: 0 });
    case 'sending':
      return listening('sending', { strength: 1, slots: 12 });
    case 'present':
      return views.present(at, 'present');
    case 'already':
      return views.present(at, 'already');
    case 'pending':
      return views.present(at, 'pending');
    case 'mic-denied':
      return views.micProblem('denied');
    case 'insecure':
      return views.micProblem('insecure');
    case 'ended':
      return views.ended();
    case 'device-used':
      return views.problem('This phone already checked someone in', 'This phone already checked in Vikram Iyer today. Each phone can check in one person per class.');
    case 'offline':
      return views.problem('No connection', 'Earshot could not reach the server. Check your Wi-Fi or mobile data, then reload.', { icon: 'wifi' });
    case 'no-course':
      S.course = null;
      return views.noCourse();
    default:
      return views.ready();
  }
}
