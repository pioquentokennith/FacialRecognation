const Database = require('better-sqlite3');
const { randomUUID, randomBytes, scryptSync, timingSafeEqual } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const APP_ID = 0x5052534e;
const MODEL = 'sface-mediapipe-5pt-v1';
const SCHEMA_VERSION = 2;
const ROLES = ['admin', 'teacher'];
function fail(message) { throw new Error(message); }
function text(value, label, max = 160) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) fail(`${label} is required (maximum ${max} characters).`);
  return value.trim();
}
function dateKey(value = new Date()) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}
function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('Choose a valid date.');
  const parsed = new Date(`${value}T12:00:00`);
  if (Number.isNaN(parsed.getTime()) || dateKey(parsed) !== value) fail('Choose a valid date.');
  return value;
}
function passwordHash(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) fail('Passwords must contain 8–128 characters.');
  const salt = randomBytes(16).toString('hex');
  return { salt, hash: scryptSync(password, salt, 64).toString('hex') };
}
function passwordMatches(password, user) {
  if (typeof password !== 'string' || password.length > 128) return false;
  const hash = scryptSync(password, user.salt, 64);
  const expected = Buffer.from(user.password_hash, 'hex');
  return hash.length === expected.length && timingSafeEqual(hash, expected);
}
function safeUser(user) {
  if (!user) return null;
  return { id: user.id, username: user.username, role: user.role, active: !!user.active };
}

class Store {
  constructor(filename, clock = () => new Date()) {
    this.filename = filename;
    this.clock = clock;
    this.sessionId = null;
    this.attempts = new Map();
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new Database(filename);
    try { this.initialize(); } catch (error) { this.db.close(); throw error; }
  }
  initialize() {
    const version = this.db.pragma('user_version', { simple: true });
    if (version > SCHEMA_VERSION) fail('This database belongs to a newer application version. Install the newer application.');
    if (version === 0) {
      if (this.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().n) fail('Unrecognized database. Existing data has not been changed.');
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL, username_key TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL, salt TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','teacher')),
            active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
          CREATE UNIQUE INDEX one_admin ON users(role) WHERE role='admin';
          CREATE TABLE students (id TEXT PRIMARY KEY, student_id TEXT NOT NULL, student_key TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL, course TEXT NOT NULL, year TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
          CREATE TABLE attendance_days (id TEXT PRIMARY KEY, date TEXT NOT NULL UNIQUE, state TEXT NOT NULL CHECK(state IN ('open','closed')),
            opened_at TEXT NOT NULL, opened_by TEXT NOT NULL REFERENCES users(id), closed_at TEXT, closed_by TEXT REFERENCES users(id));
          CREATE TABLE day_roster (day_id TEXT NOT NULL REFERENCES attendance_days(id), student_id TEXT NOT NULL REFERENCES students(id),
            display_id TEXT NOT NULL, name TEXT NOT NULL, course TEXT NOT NULL, year TEXT NOT NULL, PRIMARY KEY(day_id,student_id));
          CREATE TABLE attendance_records (id TEXT PRIMARY KEY, day_id TEXT NOT NULL, student_id TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('present','absent')), checked_in_at TEXT, utc_offset INTEGER,
            method TEXT CHECK(method IN ('manual','face','admin_correction')), recorded_by TEXT NOT NULL REFERENCES users(id),
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(day_id,student_id),
            FOREIGN KEY(day_id,student_id) REFERENCES day_roster(day_id,student_id));
          CREATE TABLE attendance_events (id TEXT PRIMARY KEY, day_id TEXT NOT NULL, student_id TEXT NOT NULL,
            method TEXT NOT NULL CHECK(method IN ('manual','face','admin_correction')), checked_in_at TEXT NOT NULL,
            utc_offset INTEGER NOT NULL, recorded_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
            FOREIGN KEY(day_id,student_id) REFERENCES day_roster(day_id,student_id));
          CREATE TABLE face_enrollments (student_id TEXT PRIMARY KEY REFERENCES students(id) ON DELETE CASCADE,
            descriptors TEXT NOT NULL, model TEXT NOT NULL, consent_at TEXT NOT NULL, enrolled_at TEXT NOT NULL);
          CREATE TABLE audit_events (id TEXT PRIMARY KEY, action TEXT NOT NULL, entity_id TEXT, operator_id TEXT REFERENCES users(id),
            operator_name TEXT NOT NULL, timestamp TEXT NOT NULL, reason TEXT, before_json TEXT, after_json TEXT);
          CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
          CREATE INDEX attendance_day_lookup ON attendance_records(day_id);
          CREATE INDEX attendance_event_lookup ON attendance_events(day_id, student_id, checked_in_at);
          CREATE INDEX audit_timestamp ON audit_events(timestamp);
          PRAGMA application_id = ${APP_ID};
          PRAGMA user_version = ${SCHEMA_VERSION};
        `);
        const now = this.now();
        this.db.prepare('INSERT INTO schema_migrations VALUES (1, ?)').run(now);
        this.db.prepare('INSERT INTO schema_migrations VALUES (2, ?)').run(now);
        for (const [username, password, role] of [['admin', 'admin123', 'admin'], ['teacher', 'teacher123', 'teacher']]) {
          const { salt, hash } = passwordHash(password);
          this.db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,1,?,?)').run(randomUUID(), username, username, hash, salt, role, now, now);
        }
      })();
    } else if (version === 1) {
      this.migrateToV2();
    }
    if (this.db.pragma('application_id', { simple: true }) !== APP_ID) fail('The selected database is not a Presence database.');
    if (this.db.pragma('quick_check', { simple: true }) !== 'ok') fail('The database failed its integrity check. Restore a working backup.');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
  }
  migrateToV2() {
    this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS attendance_events (id TEXT PRIMARY KEY, day_id TEXT NOT NULL, student_id TEXT NOT NULL,
          method TEXT NOT NULL CHECK(method IN ('manual','face','admin_correction')), checked_in_at TEXT NOT NULL,
          utc_offset INTEGER NOT NULL, recorded_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
          FOREIGN KEY(day_id,student_id) REFERENCES day_roster(day_id,student_id));
        CREATE INDEX IF NOT EXISTS attendance_event_lookup ON attendance_events(day_id, student_id, checked_in_at);
      `);
      const now = this.now();
      const insert = this.db.prepare('INSERT INTO attendance_events VALUES (?,?,?,?,?,?,?,?)');
      const present = this.db.prepare("SELECT day_id,student_id,method,checked_in_at,utc_offset,recorded_by,created_at FROM attendance_records WHERE status='present' AND checked_in_at IS NOT NULL").all();
      for (const row of present) insert.run(randomUUID(), row.day_id, row.student_id, row.method || 'manual', row.checked_in_at,
        row.utc_offset ?? 0, row.recorded_by, row.created_at || now);
      this.db.prepare('INSERT OR IGNORE INTO schema_migrations VALUES (?, ?)').run(2, now);
      this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
    })();
  }
  now() { return this.clock().toISOString(); }
  today() { return dateKey(this.clock()); }
  current() { return safeUser(this.db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(this.sessionId || '')); }
  require(admin = false) {
    const user = this.current();
    if (!user) fail('Please log in to continue.');
    if (admin && user.role !== 'admin') fail('Only an Admin can perform this action.');
    return user;
  }
  auditEvent(action, entityId, before = null, after = null, reason = null) {
    const user = this.require();
    this.db.prepare('INSERT INTO audit_events VALUES (?,?,?,?,?,?,?,?,?)').run(randomUUID(), action, entityId, user.id, user.username,
      this.now(), reason, before === null ? null : JSON.stringify(before), after === null ? null : JSON.stringify(after));
  }
  login({ username, password }) {
    const key = text(username, 'Username', 60).toLowerCase();
    const attempt = this.attempts.get(key);
    if (attempt && attempt.count >= 5 && Date.now() - attempt.at < 30000) fail('Too many attempts. Please wait 30 seconds.');
    const user = this.db.prepare('SELECT * FROM users WHERE username_key=? AND active=1').get(key);
    if (!user || !passwordMatches(password, user)) {
      const count = attempt && Date.now() - attempt.at < 30000 ? attempt.count + 1 : 1;
      this.attempts.set(key, { count, at: Date.now() });
      fail('Username or password is incorrect, or the account is inactive.');
    }
    this.attempts.delete(key);
    this.sessionId = user.id;
    this.auditEvent('login', user.id);
    return safeUser(user);
  }
  logout() { if (this.current()) this.auditEvent('logout', this.sessionId); this.sessionId = null; return true; }
  changePassword({ currentPassword, newPassword }) {
    const user = this.require();
    const row = this.db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
    if (!passwordMatches(currentPassword, row)) fail('Current password is incorrect.');
    const { salt, hash } = passwordHash(newPassword);
    this.db.transaction(() => {
      this.db.prepare('UPDATE users SET password_hash=?,salt=?,updated_at=? WHERE id=?').run(hash, salt, this.now(), user.id);
      this.auditEvent('password_changed', user.id);
    })();
    return true;
  }
  students({ search = '', archived = false } = {}) {
    this.require();
    return this.db.prepare(`SELECT s.*, EXISTS(SELECT 1 FROM face_enrollments f WHERE f.student_id=s.id AND f.model=?) AS has_face,
      EXISTS(SELECT 1 FROM face_enrollments f WHERE f.student_id=s.id AND f.model<>?) AS needs_face_upgrade
      FROM students s WHERE s.active=? ORDER BY s.name COLLATE NOCASE`).all(MODEL, MODEL, archived ? 0 : 1)
      .filter(s => `${s.student_id} ${s.name} ${s.course} ${s.year}`.toLowerCase().includes(String(search).toLowerCase()));
  }
  saveStudent(payload) {
    this.require(true);
    const studentId = text(payload.student_id, 'Student ID', 60);
    const name = text(payload.name, 'Full name');
    const course = text(payload.course, 'Course', 100);
    const year = text(payload.year, 'Year level', 40);
    const id = payload.id ? text(payload.id, 'Student reference', 40) : randomUUID();
    const before = this.db.prepare('SELECT * FROM students WHERE id=?').get(id);
    if (payload.id && !before) fail('Student was not found.');
    const duplicate = this.db.prepare('SELECT id FROM students WHERE student_key=? AND id<>?').get(studentId.toLowerCase(), id);
    if (duplicate) fail('That Student ID already exists (including archived students).');
    this.db.transaction(() => {
      if (before) this.db.prepare('UPDATE students SET student_id=?,student_key=?,name=?,course=?,year=?,updated_at=? WHERE id=?')
        .run(studentId, studentId.toLowerCase(), name, course, year, this.now(), id);
      else this.db.prepare('INSERT INTO students VALUES (?,?,?,?,?,?,1,?,?)').run(id, studentId, studentId.toLowerCase(), name, course, year, this.now(), this.now());
      this.auditEvent(before ? 'student_updated' : 'student_created', id, before || null, { student_id: studentId, name, course, year });
    })();
    return { id };
  }
  archiveStudent({ id, active }) {
    this.require(true);
    if (typeof active !== 'boolean') fail('Invalid student state.');
    const row = this.db.prepare('SELECT * FROM students WHERE id=?').get(text(id, 'Student reference', 40));
    if (!row) fail('Student was not found.');
    this.db.transaction(() => {
      this.db.prepare('UPDATE students SET active=?,updated_at=? WHERE id=?').run(active ? 1 : 0, this.now(), id);
      if (!active) this.db.prepare('DELETE FROM face_enrollments WHERE student_id=?').run(id);
      this.auditEvent(active ? 'student_reactivated' : 'student_archived', id, { active: !!row.active }, { active });
    })();
    return true;
  }
  deleteStudent({ id }) {
    this.require(true);
    const row = this.db.prepare('SELECT * FROM students WHERE id=?').get(text(id, 'Student reference', 40));
    if (!row) fail('Student was not found.');
    if (this.db.prepare('SELECT 1 FROM day_roster WHERE student_id=?').get(id)) fail('This student has attendance history. Archive the student instead.');
    this.db.transaction(() => { this.db.prepare('DELETE FROM students WHERE id=?').run(id); this.auditEvent('student_deleted', id, row); })();
    return true;
  }
  saveFace({ id, descriptors, consent, model = MODEL }) {
    this.require(true);
    if (consent !== true) fail('Consent is required for face enrollment.');
    if (model !== MODEL) fail('This face enrollment uses an older model. Re-enroll using the offline scanner.');
    const student = this.db.prepare('SELECT * FROM students WHERE id=? AND active=1').get(text(id, 'Student reference', 40));
    if (!student) fail('Choose an active student.');
    if (!Array.isArray(descriptors) || descriptors.length < 3 || descriptors.length > 8 || descriptors.some(d =>
      !Array.isArray(d) || d.length !== 128 || d.some(n => typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > 10))) fail('Capture at least three valid face samples.');
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO face_enrollments VALUES (?,?,?,?,?) ON CONFLICT(student_id) DO UPDATE SET
        descriptors=excluded.descriptors,model=excluded.model,consent_at=excluded.consent_at,enrolled_at=excluded.enrolled_at`)
        .run(id, JSON.stringify(descriptors), MODEL, this.now(), this.now());
      this.auditEvent('face_enrolled', id, null, { samples: descriptors.length, model: MODEL });
    })();
    return true;
  }
  deleteFace({ id }) {
    this.require(true);
    this.db.transaction(() => { this.db.prepare('DELETE FROM face_enrollments WHERE student_id=?').run(text(id, 'Student reference', 40)); this.auditEvent('face_deleted', id); })();
    return true;
  }
  faceCandidates({ date }) {
    this.require();
    const day = this.getDay(date);
    if (!day || day.state !== 'open') fail('Open attendance before starting recognition.');
    if (date !== this.today()) fail('Live recognition is available for today only.');
    return this.db.prepare(`SELECT r.student_id AS id,r.display_id,r.name,f.descriptors,f.model,f.enrolled_at,
      (SELECT COUNT(*) FROM attendance_events e WHERE e.day_id=r.day_id AND e.student_id=r.student_id) AS checkin_count,
      (SELECT MAX(e.checked_in_at) FROM attendance_events e WHERE e.day_id=r.day_id AND e.student_id=r.student_id) AS last_checkin_at,
      (SELECT e.utc_offset FROM attendance_events e WHERE e.day_id=r.day_id AND e.student_id=r.student_id
        ORDER BY e.checked_in_at DESC,e.rowid DESC LIMIT 1) AS last_utc_offset
      FROM day_roster r JOIN face_enrollments f ON f.student_id=r.student_id WHERE r.day_id=? AND f.model=?`).all(day.id, MODEL)
      .map(row => ({ ...row, descriptors: JSON.parse(row.descriptors) }));
  }
  faceStatus({ date = this.today() } = {}) {
    this.require();
    const day = this.getDay(date);
    const students = this.db.prepare(`SELECT s.id,s.student_id,s.name,f.model,
      EXISTS(SELECT 1 FROM day_roster r WHERE r.student_id=s.id AND r.day_id=?) AS on_roster
      FROM students s LEFT JOIN face_enrollments f ON f.student_id=s.id WHERE s.active=1`).all(day?.id || '');
    return { model: MODEL, dayState: day?.state || 'not_opened', roster: day ? this.db.prepare('SELECT COUNT(*) n FROM day_roster WHERE day_id=?').get(day.id).n : 0,
      ready: day ? this.db.prepare('SELECT COUNT(*) n FROM day_roster r JOIN face_enrollments f ON f.student_id=r.student_id WHERE r.day_id=? AND f.model=?').get(day.id, MODEL).n : 0,
      needsUpgrade: students.filter(s => s.model && s.model !== MODEL).length,
      missingEnrollment: students.filter(s => !s.model).length,
      notOnRoster: students.filter(s => !s.on_roster).map(s => ({ id: s.id, name: s.name, student_id: s.student_id })),
    };
  }
  includeStudentsToday({ date = this.today() } = {}) {
    this.require(true);
    if (validDate(date) !== this.today()) fail('The date has changed. Switch to today before adding students.');
    const day = this.getDay(this.today());
    if (!day || day.state !== 'open') fail('Today must be open before adding newly registered students.');
    return this.db.transaction(() => {
      const result = this.db.prepare(`INSERT INTO day_roster SELECT ?,id,student_id,name,course,year FROM students
        WHERE active=1 AND id NOT IN (SELECT student_id FROM day_roster WHERE day_id=?)`).run(day.id, day.id);
      this.auditEvent('roster_students_added', day.id, null, { date: day.date, added: result.changes }, 'Admin explicitly included newly registered students in today’s roster');
      return { added: result.changes };
    })();
  }
  getDay(date) { return this.db.prepare('SELECT * FROM attendance_days WHERE date=?').get(validDate(date)) || null; }
  days() { this.require(); return this.db.prepare('SELECT * FROM attendance_days ORDER BY date DESC').all(); }
  day({ date }) {
    this.require();
    const day = this.getDay(date);
    return { day, rows: day ? this.records({ from: date, to: date }) : [] };
  }
  openDay() {
    const user = this.require();
    const date = this.today();
    if (this.getDay(date)) fail('Today already has an attendance day. An Admin can reopen it if closed.');
    const id = randomUUID();
    this.db.transaction(() => {
      this.db.prepare("INSERT INTO attendance_days (id,date,state,opened_at,opened_by) VALUES (?,?,'open',?,?)").run(id, date, this.now(), user.id);
      this.db.prepare(`INSERT INTO day_roster SELECT ?,id,student_id,name,course,year FROM students WHERE active=1`).run(id);
      this.auditEvent('day_opened', id, null, { date });
    })();
    return this.getDay(date);
  }
  closeDay({ date }) {
    const user = this.require(true);
    const day = this.getDay(date);
    if (!day) fail('This attendance day has not been opened.');
    if (day.state === 'closed') return day;
    this.db.transaction(() => {
      const missing = this.db.prepare(`SELECT r.student_id FROM day_roster r LEFT JOIN attendance_records a
        ON a.day_id=r.day_id AND a.student_id=r.student_id WHERE r.day_id=? AND a.id IS NULL`).all(day.id);
      const insert = this.db.prepare(`INSERT INTO attendance_records VALUES (?,?,?,'absent',NULL,NULL,NULL,?,?,?)`);
      for (const row of missing) insert.run(randomUUID(), day.id, row.student_id, user.id, this.now(), this.now());
      this.db.prepare("UPDATE attendance_days SET state='closed',closed_at=?,closed_by=? WHERE id=?").run(this.now(), user.id, day.id);
      this.auditEvent('day_closed', day.id, null, { date, absences_created: missing.length });
    })();
    return this.getDay(date);
  }
  reopenDay({ date }) {
    this.require(true);
    const day = this.getDay(date);
    if (!day || day.state !== 'closed') fail('Choose a closed attendance day.');
    this.db.transaction(() => {
      this.db.prepare("UPDATE attendance_days SET state='open',closed_at=NULL,closed_by=NULL WHERE id=?").run(day.id);
      this.auditEvent('day_reopened', day.id, null, { date });
    })();
    return this.getDay(date);
  }
  recordAttendance({ date, studentId, method, confirmed }) {
    const user = this.require();
    if (confirmed !== true) fail('Confirm the student identity before saving.');
    if (!['manual', 'face'].includes(method)) fail('Invalid recording method.');
    if (validDate(date) !== this.today()) fail('The date has changed. Switch to today before recording live attendance.');
    const day = this.getDay(date);
    if (!day || day.state !== 'open') fail('Attendance must be open before recording.');
    if (!this.db.prepare('SELECT 1 FROM day_roster WHERE day_id=? AND student_id=?').get(day.id, studentId)) fail('This student is not on the daily roster.');
    if (method === 'face' && !this.db.prepare('SELECT 1 FROM face_enrollments WHERE student_id=? AND model=?').get(studentId, MODEL)) fail('Face enrollment is no longer available. Use manual attendance.');
    let checkinCount = 0;
    this.db.transaction(() => {
      const before = this.db.prepare('SELECT * FROM attendance_records WHERE day_id=? AND student_id=?').get(day.id, studentId);
      const now = this.now();
      const offset = -this.clock().getTimezoneOffset();
      if (before?.status === 'present' && before.checked_in_at) {
        this.db.prepare('UPDATE attendance_records SET updated_at=? WHERE id=?').run(now, before.id);
      } else if (before) {
        this.db.prepare("UPDATE attendance_records SET status='present',checked_in_at=?,utc_offset=?,method=?,recorded_by=?,updated_at=? WHERE id=?")
          .run(now, offset, method, user.id, now, before.id);
      } else {
        this.db.prepare("INSERT INTO attendance_records VALUES (?,?,?,'present',?,?,?,?,?,?)")
          .run(randomUUID(), day.id, studentId, now, offset, method, user.id, now, now);
      }
      this.db.prepare('INSERT INTO attendance_events VALUES (?,?,?,?,?,?,?,?)')
        .run(randomUUID(), day.id, studentId, method, now, offset, user.id, now);
      checkinCount = this.db.prepare('SELECT COUNT(*) AS n FROM attendance_events WHERE day_id=? AND student_id=?').get(day.id, studentId).n;
      this.auditEvent('attendance_recorded', before?.id || studentId, before || null, { date, studentId, method, checkinCount },
        before?.status === 'present' ? 'Additional check-in for an already present student' : before ? 'Confirmed check-in after day reopened' : null);
    })();
    return { checkinCount };
  }
  attendanceEvents({ date, studentId }) {
    this.require();
    const day = this.getDay(validDate(date));
    if (!day) fail('This attendance day has not been opened.');
    return this.db.prepare(`SELECT e.id,e.checked_in_at,e.utc_offset,e.method,u.username AS recorded_by
      FROM attendance_events e LEFT JOIN users u ON u.id=e.recorded_by
      WHERE e.day_id=? AND e.student_id=? ORDER BY e.checked_in_at DESC,e.rowid DESC`).all(day.id, studentId);
  }
  correctAttendance({ date, studentId, status, reason }) {
    const user = this.require(true);
    const why = text(reason, 'Correction reason', 500);
    if (!['present', 'absent', 'pending'].includes(status)) fail('Choose a valid attendance status.');
    const day = this.getDay(date);
    if (!day || day.state !== 'open') fail('Reopen this attendance day before correcting a record.');
    if (!this.db.prepare('SELECT 1 FROM day_roster WHERE day_id=? AND student_id=?').get(day.id, studentId)) fail('Student is not on this daily roster.');
    this.db.transaction(() => {
      const before = this.db.prepare('SELECT * FROM attendance_records WHERE day_id=? AND student_id=?').get(day.id, studentId);
      if (status === 'pending') this.db.prepare('DELETE FROM attendance_records WHERE day_id=? AND student_id=?').run(day.id, studentId);
      else {
        const checkedIn = status === 'present' && before?.status === 'present' ? before.checked_in_at : null;
        const offset = checkedIn ? before.utc_offset : null;
        this.db.prepare(`INSERT INTO attendance_records VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(day_id,student_id) DO UPDATE SET
          status=excluded.status,checked_in_at=excluded.checked_in_at,utc_offset=excluded.utc_offset,method=excluded.method,
          recorded_by=excluded.recorded_by,updated_at=excluded.updated_at`)
          .run(before?.id || randomUUID(), day.id, studentId, status, checkedIn, offset, status === 'present' ? 'admin_correction' : null,
            user.id, before?.created_at || this.now(), this.now());
      }
      const removed = status === 'present' ? 0 : this.db.prepare('DELETE FROM attendance_events WHERE day_id=? AND student_id=?').run(day.id, studentId).changes;
      this.auditEvent('attendance_corrected', before?.id || studentId, before || null, { date, studentId, status, checkins_removed: removed }, why);
    })();
    return true;
  }
  records({ from, to, search = '', status = '', method = '' } = {}) {
    this.require();
    if (from) validDate(from);
    if (to) validDate(to);
    if (from && to && from > to) fail('The start date must not be after the end date.');
    if (status && !['present', 'absent', 'pending'].includes(status)) fail('Invalid status filter.');
    if (method && !['manual', 'face', 'admin_correction'].includes(method)) fail('Invalid method filter.');
    const rows = this.db.prepare(`SELECT d.date,d.state AS day_state,r.student_id,r.display_id,r.name,r.course,r.year,
      a.id,COALESCE(a.status,'pending') AS status,a.checked_in_at,a.utc_offset,a.method,u.username AS recorded_by,a.updated_at,
      (SELECT COUNT(*) FROM attendance_events e WHERE e.day_id=r.day_id AND e.student_id=r.student_id) AS checkin_count,
      (SELECT MAX(e.checked_in_at) FROM attendance_events e WHERE e.day_id=r.day_id AND e.student_id=r.student_id) AS last_checkin_at,
      (SELECT e.utc_offset FROM attendance_events e WHERE e.day_id=r.day_id AND e.student_id=r.student_id
        ORDER BY e.checked_in_at DESC,e.rowid DESC LIMIT 1) AS last_utc_offset
      FROM day_roster r JOIN attendance_days d ON d.id=r.day_id
      LEFT JOIN attendance_records a ON a.day_id=r.day_id AND a.student_id=r.student_id
      LEFT JOIN users u ON u.id=a.recorded_by
      WHERE (? IS NULL OR d.date>=?) AND (? IS NULL OR d.date<=?) ORDER BY d.date DESC,r.name COLLATE NOCASE`)
      .all(from || null, from || null, to || null, to || null);
    const needle = String(search).toLowerCase();
    return rows.filter(r => (!status || r.status === status) && (!method || r.method === method)
      && `${r.display_id} ${r.name} ${r.course} ${r.year}`.toLowerCase().includes(needle));
  }
  dashboard({ date = this.today() } = {}) {
    this.require();
    const data = this.day({ date });
    const counts = { present: 0, absent: 0, pending: 0 };
    data.rows.forEach(row => counts[row.status]++);
    return { ...counts, date, day: data.day, roster: data.rows.length,
      students: this.db.prepare('SELECT count(*) AS n FROM students WHERE active=1').get().n,
      enrolled: this.db.prepare('SELECT count(*) AS n FROM face_enrollments WHERE model=?').get(MODEL).n,
      recent: data.rows.filter(r => r.status !== 'pending').sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 6) };
  }
  users() { this.require(true); return this.db.prepare('SELECT id,username,role,active,created_at FROM users ORDER BY role,username').all(); }
  saveUser({ id, username, password, active = true }) {
    this.require(true);
    const name = text(username, 'Username', 60);
    if (typeof active !== 'boolean') fail('Invalid account state.');
    const before = id ? this.db.prepare('SELECT * FROM users WHERE id=?').get(id) : null;
    if (id && !before) fail('Account was not found.');
    if (before?.role === 'admin') fail('The permanent Admin account cannot be edited here. Use Settings to change its password.');
    if (this.db.prepare('SELECT 1 FROM users WHERE username_key=? AND id<>?').get(name.toLowerCase(), id || '')) fail('That username already exists.');
    const key = id || randomUUID();
    const credentials = before ? null : passwordHash(password);
    this.db.transaction(() => {
      if (before) this.db.prepare('UPDATE users SET username=?,username_key=?,active=?,updated_at=? WHERE id=?').run(name, name.toLowerCase(), active ? 1 : 0, this.now(), key);
      else this.db.prepare("INSERT INTO users VALUES (?,?,?,?,?,'teacher',?,?,?)")
        .run(key, name, name.toLowerCase(), credentials.hash, credentials.salt, active ? 1 : 0, this.now(), this.now());
      this.auditEvent(before ? 'teacher_updated' : 'teacher_created', key, safeUser(before), { username: name, active });
    })();
    return true;
  }
  resetPassword({ id, password }) {
    this.require(true);
    if (!this.db.prepare("SELECT 1 FROM users WHERE id=? AND role='teacher'").get(id)) fail('Choose a Teacher account.');
    const { salt, hash } = passwordHash(password);
    this.db.transaction(() => {
      this.db.prepare('UPDATE users SET password_hash=?,salt=?,updated_at=? WHERE id=?').run(hash, salt, this.now(), id);
      this.auditEvent('teacher_password_reset', id);
    })();
    return true;
  }
  audit({ limit = 100 } = {}) {
    this.require(true);
    return this.db.prepare('SELECT * FROM audit_events ORDER BY timestamp DESC,rowid DESC LIMIT ?').all(Math.max(1, Math.min(500, Number(limit) || 100)));
  }
  async backup(destination) {
    this.require(true);
    if (path.resolve(destination).toLowerCase().startsWith(path.resolve(this.filename).toLowerCase())) fail('Choose a backup location different from the live database.');
    const staging = `${destination}.${randomUUID()}.tmp`;
    try {
      await this.db.backup(staging);
      fs.renameSync(staging, destination);
    } finally { fs.rmSync(staging, { force: true }); }
    this.auditEvent('backup_created', null);
    return true;
  }
  static validateBackup(filename) {
    const candidate = new Database(filename, { readonly: true, fileMustExist: true });
    try {
      const version = candidate.pragma('user_version', { simple: true });
      if (candidate.pragma('application_id', { simple: true }) !== APP_ID || !(version >= 1 && version <= SCHEMA_VERSION)) fail('This file is not a compatible Presence backup.');
      if (candidate.pragma('integrity_check', { simple: true }) !== 'ok' || candidate.pragma('foreign_key_check').length) fail('The backup failed its integrity check.');
      const requiredColumns = {
        users: 'id,username,username_key,password_hash,salt,role,active,created_at,updated_at',
        students: 'id,student_id,student_key,name,course,year,active,created_at,updated_at',
        attendance_days: 'id,date,state,opened_at,opened_by,closed_at,closed_by',
        day_roster: 'day_id,student_id,display_id,name,course,year',
        attendance_records: 'id,day_id,student_id,status,checked_in_at,utc_offset,method,recorded_by,created_at,updated_at',
        face_enrollments: 'student_id,descriptors,model,consent_at,enrolled_at',
        audit_events: 'id,action,entity_id,operator_id,operator_name,timestamp,reason,before_json,after_json',
        schema_migrations: 'version,applied_at',
      };
      if (version >= 2) requiredColumns.attendance_events = 'id,day_id,student_id,method,checked_in_at,utc_offset,recorded_by,created_at';
      for (const [table, columns] of Object.entries(requiredColumns)) {
        try { candidate.prepare(`SELECT ${columns} FROM ${table} LIMIT 1`).get(); }
        catch { fail(`The backup has an incompatible ${table} schema. Your current data has not been changed.`); }
      }
      const admin = candidate.prepare("SELECT * FROM users WHERE role='admin' AND active=1").all();
      if (admin.length !== 1 || !ROLES.includes(admin[0].role) || !/^[a-f0-9]{128}$/.test(admin[0].password_hash) || !/^[a-f0-9]{32}$/.test(admin[0].salt)) fail('The backup must contain one valid active Admin.');
      return true;
    } finally { candidate.close(); }
  }
  async restore(filename) {
    this.require(true);
    if (path.resolve(filename).toLowerCase() === path.resolve(this.filename).toLowerCase()) fail('Select a backup, not the live database.');
    Store.validateBackup(filename);
    const staging = `${this.filename}.restore-${randomUUID()}`;
    const recovery = path.join(path.dirname(this.filename), `recovery-${Date.now()}.sqlite`);
    const source = new Database(filename, { readonly: true });
    try { await source.backup(staging); } finally { source.close(); }
    try {
      await this.db.backup(recovery);
      this.db.pragma('wal_checkpoint(TRUNCATE)');
      this.db.close();
      try {
        fs.copyFileSync(staging, this.filename);
        this.db = new Database(this.filename);
        this.initialize();
      } catch (error) {
        if (this.db.open) this.db.close();
        fs.rmSync(this.filename + '-wal', { force: true });
        fs.rmSync(this.filename + '-shm', { force: true });
        fs.copyFileSync(recovery, this.filename);
        this.db = new Database(this.filename);
        this.initialize();
        throw error;
      }
      this.sessionId = null;
      return { recovery };
    } finally {
      fs.rmSync(staging, { force: true });
      if (!this.db.open) { this.db = new Database(this.filename); this.initialize(); }
    }
  }
  close() { if (this.db.open) this.db.close(); }
}

function csvCell(value) {
  let result = String(value ?? '');
  if (/^[\s]*[=+@-]/.test(result) || /^[\t\r\n]/.test(result)) result = `'${result}`;
  return `"${result.replaceAll('"', '""')}"`;
}
function localTimestamp(value, offset) {
  return value ? new Date(new Date(value).getTime() + (offset || 0) * 60000).toISOString().slice(0, 19).replace('T', ' ') : '';
}
function exportCSV(rows) {
  const fields = ['Date', 'Student ID', 'Full name', 'Course', 'Year level', 'Status', 'Check-in time (local)', 'UTC offset (minutes)',
    'Method', 'Recorded by', 'Check-ins', 'Last check-in time (local)'];
  const data = rows.map(r => [r.date, r.display_id, r.name, r.course, r.year, r.status === 'pending' ? 'Not yet recorded' : r.status,
    localTimestamp(r.checked_in_at, r.utc_offset), r.utc_offset ?? '', r.method || '', r.recorded_by || '',
    r.checkin_count ?? 0, localTimestamp(r.last_checkin_at, r.last_utc_offset)]);
  return '\uFEFF' + [fields, ...data].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
module.exports = { Store, dateKey, exportCSV, MODEL };
