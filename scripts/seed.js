// Demo data: three classes, rosters and a few weeks of past sessions.
//   npm run seed            add demo classes (skips any that exist)
//   npm run seed -- --fresh delete the database first

import fs from 'node:fs';
import crypto from 'node:crypto';
import { config } from '../server/config.js';
import { openDb } from '../server/db.js';
import { newSecret } from '../server/codes.js';

if (process.argv.includes('--fresh')) {
  for (const f of [config.dbFile, config.dbFile + '-wal', config.dbFile + '-shm']) fs.rmSync(f, { force: true });
}
const db = openDb(config.dbFile);

const FIRST = [
  'Aarav', 'Ananya', 'Arjun', 'Asha', 'Bhavya', 'Chirag', 'Deepika', 'Dhruv', 'Divya', 'Farhan', 'Gauri', 'Harsh', 'Ishaan', 'Isha',
  'Jaya', 'Karthik', 'Kavya', 'Lakshmi', 'Manav', 'Meera', 'Mohammed', 'Nandini', 'Nikhil', 'Nisha', 'Pooja', 'Pranav', 'Priya',
  'Rahul', 'Riya', 'Rohan', 'Sahil', 'Sana', 'Shreya', 'Siddharth', 'Sneha', 'Tanvi', 'Tejas', 'Varun', 'Vikram', 'Zoya', 'Aditi',
  'Kabir', 'Mitali', 'Naveen', 'Ritika', 'Sameer', 'Tara', 'Uday', 'Yash', 'Anjali', 'Gurpreet', 'Joseph', 'Lalit', 'Fathima',
];
const LAST = [
  'Rao', 'Iyer', 'Nair', 'Sharma', 'Patel', 'Reddy', 'Menon', 'Gupta', 'Das', 'Singh', 'Khan', 'Kulkarni', 'Banerjee', 'Pillai',
  'Joshi', 'Mehta', 'Chatterjee', 'Shetty', 'Verma', 'Bose', 'Naidu', 'Desai', 'Fernandes', 'Hegde', 'Mishra', 'Sen',
];

let seed = 11;
const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const pick = (a) => a[Math.floor(rand() * a.length)];

function roster(prefix, n) {
  const used = new Set();
  const out = [];
  for (let i = 1; i <= n; i++) {
    let name;
    do name = `${pick(FIRST)} ${pick(LAST)}`;
    while (used.has(name));
    used.add(name);
    out.push({ roll: `${prefix}${String(i).padStart(3, '0')}`, name });
  }
  return out;
}

const classes = [
  { code: 'CS201', title: 'Data Structures', students: roster('21CS', 48), past: 9, rate: 0.86 },
  { code: 'MA102', title: 'Linear Algebra', students: roster('22MA', 60), past: 6, rate: 0.78 },
  { code: 'PH110', title: 'Physics Lab', students: [], past: 0, rate: 0, open: true },
];

const DAY = 86_400_000;
const now = Date.now();

for (const c of classes) {
  if (db.courses.byCode(c.code)) {
    console.log(`skip ${c.code} (exists)`);
    continue;
  }
  db.tx(() => {
    const id = Number(db.courses.insert(c.code, c.title, !!c.open, now - 40 * DAY));
    for (const s of c.students) db.students.upsert(id, s.roll, s.name);
    const studs = db.students.forCourse(id);
    for (let k = c.past; k >= 1; k--) {
      const start = now - k * 2 * DAY - 3 * 3600_000;
      const sid = crypto.randomBytes(9).toString('base64url');
      db.sessions.insert(sid, id, newSecret(), start, 'quiet');
      db.sessions.end(sid, start + 52 * 60_000);
      for (const st of studs) {
        if (rand() > c.rate) continue;
        const at = start + Math.floor(rand() * 6 * 60_000);
        const late = rand() < 0.01;
        db.checkins.insert({
          sessionId: sid,
          studentId: st.id,
          at,
          status: late ? 'pending' : 'present',
          method: rand() < 0.04 ? 'manual' : 'sound',
          band: 'quiet',
          flags: late ? ['New phone'] : [],
        });
      }
    }
  });
  console.log(`added ${c.code} ${c.title}: ${c.students.length} students, ${c.past} past sessions`);
}
console.log(`\nLecturer key: ${config.lecturerKey}`);
