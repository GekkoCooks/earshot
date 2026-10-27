import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
pragma journal_mode = wal;
pragma foreign_keys = on;

create table if not exists courses (
  id          integer primary key,
  code        text not null unique collate nocase,
  title       text not null,
  open_roster integer not null default 0,
  created_at  integer not null
);

create table if not exists students (
  id              integer primary key,
  course_id       integer not null references courses(id) on delete cascade,
  roll            text not null collate nocase,
  name            text not null,
  self_added      integer not null default 0,
  device_id       text,
  device_bound_at integer,
  unique (course_id, roll)
);

create table if not exists devices (
  id         text primary key,          -- RFC 7638 thumbprint of the public key
  public_key text not null,             -- JWK
  first_seen integer not null
);

create table if not exists sessions (
  id         text primary key,
  course_id  integer not null references courses(id) on delete cascade,
  secret     text not null,
  started_at integer not null,
  ended_at   integer,
  mode       text not null default 'quiet'
);

create table if not exists checkins (
  id         integer primary key,
  session_id text not null references sessions(id) on delete cascade,
  student_id integer not null references students(id) on delete cascade,
  device_id  text,
  at         integer not null,
  status     text not null,             -- present | pending
  method     text not null,             -- sound | manual
  band       text,
  flags      text not null default '[]',
  unique (session_id, student_id)
);

-- Rejected or suspicious attempts, for the lecturer and for debugging.
create table if not exists attempts (
  id         integer primary key,
  session_id text,
  at         integer not null,
  device_id  text,
  roll       text,
  outcome    text not null
);

create index if not exists checkins_device on checkins(session_id, device_id);
create index if not exists sessions_course on sessions(course_id, started_at);
`;

export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  const q = (sql) => db.prepare(sql);

  return {
    raw: db,
    tx(fn) {
      db.exec('begin');
      try {
        const out = fn();
        db.exec('commit');
        return out;
      } catch (e) {
        db.exec('rollback');
        throw e;
      }
    },

    courses: {
      all: () =>
        q(`select c.*,
             (select count(*) from students s where s.course_id = c.id) as students,
             (select count(*) from sessions x where x.course_id = c.id) as sessions,
             (select id from sessions x where x.course_id = c.id and x.ended_at is null
                order by started_at desc limit 1) as live_session,
             (select max(started_at) from sessions x where x.course_id = c.id) as last_session
           from courses c order by c.code`).all(),
      byId: (id) => q('select * from courses where id = ?').get(id),
      byCode: (code) => q('select * from courses where code = ?').get(code),
      insert: (code, title, openRoster, now) =>
        q('insert into courses (code, title, open_roster, created_at) values (?, ?, ?, ?)').run(
          code,
          title,
          openRoster ? 1 : 0,
          now,
        ).lastInsertRowid,
      remove: (id) => q('delete from courses where id = ?').run(id),
    },

    students: {
      forCourse: (courseId) => q('select * from students where course_id = ? order by roll').all(courseId),
      byRoll: (courseId, roll) => q('select * from students where course_id = ? and roll = ?').get(courseId, roll),
      byId: (id) => q('select * from students where id = ?').get(id),
      upsert: (courseId, roll, name, selfAdded = 0) =>
        q(`insert into students (course_id, roll, name, self_added) values (?, ?, ?, ?)
           on conflict (course_id, roll) do update set name = excluded.name`).run(courseId, roll, name, selfAdded),
      bind: (id, deviceId, now) =>
        q('update students set device_id = ?, device_bound_at = ? where id = ?').run(deviceId, now, id),
      unbind: (id) => q('update students set device_id = null, device_bound_at = null where id = ?').run(id),
      byDevice: (courseId, deviceId) => q('select * from students where course_id = ? and device_id = ?').get(courseId, deviceId),
    },

    devices: {
      get: (id) => q('select * from devices where id = ?').get(id),
      save: (id, jwk, now) => q('insert or ignore into devices (id, public_key, first_seen) values (?, ?, ?)').run(id, jwk, now),
    },

    sessions: {
      byId: (id) => q('select * from sessions where id = ?').get(id),
      live: (courseId) =>
        q('select * from sessions where course_id = ? and ended_at is null order by started_at desc limit 1').get(courseId),
      forCourse: (courseId) =>
        q(`select s.*,
             (select count(*) from checkins k where k.session_id = s.id and k.status = 'present') as present,
             (select count(*) from checkins k where k.session_id = s.id and k.status = 'pending') as pending
           from sessions s where course_id = ? order by started_at desc`).all(courseId),
      insert: (id, courseId, secret, now, mode) =>
        q('insert into sessions (id, course_id, secret, started_at, mode) values (?, ?, ?, ?, ?)').run(id, courseId, secret, now, mode),
      end: (id, now) => q('update sessions set ended_at = ? where id = ? and ended_at is null').run(now, id),
      setMode: (id, mode) => q('update sessions set mode = ? where id = ?').run(mode, id),
    },

    checkins: {
      forSession: (sessionId) =>
        q(`select k.*, s.roll, s.name from checkins k join students s on s.id = k.student_id
           where k.session_id = ? order by k.at`).all(sessionId),
      get: (sessionId, studentId) => q('select * from checkins where session_id = ? and student_id = ?').get(sessionId, studentId),
      byDevice: (sessionId, deviceId) => q('select * from checkins where session_id = ? and device_id = ?').get(sessionId, deviceId),
      insert: (c) =>
        q(`insert into checkins (session_id, student_id, device_id, at, status, method, band, flags)
           values (?, ?, ?, ?, ?, ?, ?, ?)`).run(
          c.sessionId,
          c.studentId,
          c.deviceId ?? null,
          c.at,
          c.status,
          c.method,
          c.band ?? null,
          JSON.stringify(c.flags ?? []),
        ),
      setStatus: (sessionId, studentId, status) =>
        q('update checkins set status = ? where session_id = ? and student_id = ?').run(status, sessionId, studentId),
      remove: (sessionId, studentId) => q('delete from checkins where session_id = ? and student_id = ?').run(sessionId, studentId),
      matrix: (courseId) =>
        q(`select k.session_id, k.student_id, k.status from checkins k
           join sessions s on s.id = k.session_id where s.course_id = ?`).all(courseId),
    },

    attempts: {
      log: (sessionId, deviceId, roll, outcome, now) =>
        q('insert into attempts (session_id, at, device_id, roll, outcome) values (?, ?, ?, ?, ?)').run(
          sessionId ?? null,
          now,
          deviceId ?? null,
          roll ?? null,
          outcome,
        ),
      forSession: (sessionId) =>
        q(`select outcome, count(*) as n from attempts where session_id = ? group by outcome`).all(sessionId),
    },
  };
}
