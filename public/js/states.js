const STATES = [
  ['identify', 'First visit', 'Roll number once; the phone remembers it.'],
  ['no-session', 'Too early', 'Moves on by itself when class starts.'],
  ['ready', 'Ready', 'One tap starts the microphone.'],
  ['ready-new-phone', 'Ready on a new phone', 'Allowed, but the lecturer confirms it.'],
  ['listening', 'Listening', 'Nothing heard yet.'],
  ['faint', 'Faint signal', 'Something is there; guidance to improve it.'],
  ['catching', 'Catching the code', 'Slots fill at the pitch each tone was heard.'],
  ['almost', 'Almost', 'A frame was lost in noise; it retries.'],
  ['cant-hear', "Can't hear", 'After 15 seconds of silence.'],
  ['sending', 'Code caught', 'The marks line up while it checks in.'],
  ['present', 'Present', 'The confirmation.'],
  ['already', 'Already checked in', 'Opening the page again later.'],
  ['pending', 'Needs confirmation', 'Checked in from a phone the lecturer has not seen.'],
  ['mic-denied', 'Microphone blocked', 'Platform-specific steps to fix it.'],
  ['insecure', 'Wrong link', 'Phones need https for the microphone.'],
  ['device-used', 'Phone already used', 'One phone, one person per class.'],
  ['ended', 'Session ended', 'Closed before this phone checked in.'],
  ['offline', 'No connection', 'Could not reach the server.'],
  ['no-course', 'Bad link', 'The course code does not exist.'],
];

const still = new URLSearchParams(location.search).has('still') ? '&still' : '';
document.getElementById('gallery').innerHTML = STATES.map(
  ([id, title, note]) => `<figure>
    <iframe src="/c/CS201?demo=${id}${still}" title="${title}" loading="lazy"></iframe>
    <figcaption><b>${title}</b><span>${note}</span></figcaption>
  </figure>`,
).join('');
